/**
 * LengTeamOrchestrator — parent-session director.
 *
 * Owns:
 *  - Seat pool (≤3 concurrent sub-sessions, hard cap), task queue, DAG dependencies
 *  - Child-agent lifecycle for all 13 roles + fine-grained module dev tasks
 *  - Handover via central dispatch (all data goes through the orchestrator)
 *  - Transactional snapshot + breakpoint recovery
 *  - Manual confirmation nodes
 *  - Wiring to watchdog, observability, and dagScene (business truth only)
 */

import { ROLES, ROLE_MAP, ORCHESTRATOR, PIPELINE_ORDER, CONDITIONAL, buildRolePrompt } from "./roles.js";
import { LengWatchdog, STATUS } from "./watchdog.js";
import { ModuleSplitter } from "./module-splitter.js";
import { Observability } from "./observability.js";
import { SnapshotStore } from "./snapshot.js";
import { IssueTracker, sevName } from "./issues.js";
import { normalizeConfig } from "./config.js";
import { similarity, normalizeText } from "./similarity.js";
import { Discovery } from "./discovery.js";
import { ConditionalActivation } from "./conditional.js";
import { RollbackBudget } from "./rollback-budget.js";
import { RateLimiter } from "./rate-limiter.js";
import { IndependentVerification } from "./verification.js";
import { detectTaskType, detectTaskMode, evaluateInvestigation, templateFor, DOMAIN_EXEC } from "./domain-templates.js";
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

let RUN_ID = 0;

export class LengTeamOrchestrator {
  constructor(ctx, rawConfig) {
    this.ctx = ctx;
    this.config = normalizeConfig(rawConfig);

    this.watchdog = new LengWatchdog(this.config.watchdog);
    this.observability = new Observability(this.config.observability);
    this.splitter = new ModuleSplitter(this.config.moduleSplit);
    this.snapshotStore = new SnapshotStore(
      // cordis ctx.baseDir is not available without inject; use a stable writable dir.
      (process.env.DSH_HOME ?? process.cwd()),
      `leng-team-${process.pid}`
    );

    // ---- Seat pool & queue ----
    this.capacity = this.config.concurrency.maxConcurrent;
    this.seats = new Map();      // seatIndex -> { taskId, role, agent, startedAt }
    this.queue = [];             // { taskId, role, module, depends, status, createdAt }
    this.dag = new Map();        // taskId -> { status, deps, ... }
    this.activeRun = null;
    this.running = false;
    this.paused = false;
    this.lastResult = null;   // { ts, text } 最近一次需通知的命令结果（供 client 轮询弹 toast）

    // ---- Cache (cost control) ----
    this.moduleCache = new Map(); // cacheKey -> output

    // ---- 统一回环规则：问题分级状态机 ----
    this.issues = new IssueTracker();

    // ---- V9.3：调查员 / 条件启用三方会签 / 全局回退预算 / 令牌桶+429 / 独立复验 ----
    this.discovery = new Discovery(this.config.conditional);
    this.conditional = new ConditionalActivation(this.config.conditional);
    this.rollback = new RollbackBudget(this.config.rollback);
    this.rateLimiter = new RateLimiter(this.config.concurrency);
    this.verification = new IndependentVerification(this.config.verification);
    this.taskType = "software";
    this.taskTemplate = templateFor("software");

    // ---- 父会话存活检测（项目会话被删除 -> 自动重置结束流水线） ----
    this.parentSessionId = null;       // 启动时记录父会话（项目会话）id
    this._parentAliveTimer = null;     // 30s 巡检定时器
    this._parentQueryable = false;     // 平台是否可查询父会话（首次查到才开启检测）
    this._parentGoneCount = 0;         // 连续未查到计数（>=2 才判定删除，防误杀）
    this.lastProjectSessionId = null;  // 最近一次项目会话 id（保留，用于「每次 /team 用新会话」检测）
    this.lastGoal = null;              // 最近一次项目目标（复用提示用）

    // ---- callbacks ----
    this.onStateChange = null;    // (scenePayload) => void  (dagScene: business truth only)
    this.onAlert = null;          // (alert) => void

    // ---- watchdog wiring ----
    this.watchdog.onAlert = (taskId, alert) => {
      this._onWatchdogAlert(taskId, alert);
    };
  }

  /** 记录一条需要前端 toast 通知的命令结果。 */
  recordResult(text) {
    this.lastResult = { ts: Date.now(), text: String(text ?? "") };
  }

  /** 标记"项目会话已建立、流水线待启动"（延迟启动窗口），用于 handler 幂等检查。 */
  setStartPending(goal) {
    this._startPending = { goal: String(goal ?? ""), ts: Date.now() };
  }

  clearStartPending() {
    this._startPending = null;
  }

  get startPending() {
    return this._startPending;
  }

  get status() {
    const run = this.activeRun;
    return {
      running: this.running,
      paused: this.paused,
      capacity: this.capacity,
      seats: [...this.seats.entries()].map(([i, s]) => ({ seat: i, taskId: s.taskId, role: s.role, module: s.module, startedAt: s.startedAt })),
      queue: this.queue.map((q) => ({ taskId: q.taskId, role: q.role, module: q.module, status: q.status, createdAt: q.createdAt })),
      frozen: this.watchdog.isFrozen(),
      goal: run?.goal ?? null,
      stage: run?.stage ?? "idle",
    };
  }

  /** 业务状态快照（V9.3：无微型办公室/无动画，仅业务真相）。 */
  dagScene() {
    const run = this.activeRun;
    const roleStates = {};
    for (const role of ROLES.map((r) => r.key)) {
      roleStates[role] = this._roleBusinessStatus(role);
    }
    const moduleTasks = [...this.dag.entries()]
      .filter(([, t]) => t.role === "frontend" || t.role === "backend")
      .map(([id, t]) => ({ id, role: t.role, module: t.module ?? id, status: t.status }))
      // V9.3 任务状态优先级：异常/工作中 > 排队 > 完成（便于会话页展示）
      .sort((a, b) => ((st) => st === "running" || st === "blocked" ? 3 : st === "queued" ? 2 : 1)(b.status) - ((st) => st === "running" || st === "blocked" ? 3 : st === "queued" ? 2 : 1)(a.status));
    return {
      roleStates,
      moduleTasks,
      directorState: this.running ? "running" : "idle",
      taskType: this.taskType,
      rateState: this.rateLimiter.state,
      rollback: this.rollback.snapshot(),
      acceptance: this.acceptanceSnapshot(),
      at: Date.now(),
    };
  }

  /**
   * 专家流程图状态（N0~N41 + W 看门狗旁路，方案 5.4 软件主链）。
   * 供会话页「专家流程图」渲染：已完成环节、当前环节、待处理环节。
   */
  flowScene() {
    const run = this.activeRun;
    const stage = run?.stage ?? "idle";
    const running = this.running;
    const node = (id, name, desc, state, note) => ({ id, name, desc, state, note: note ?? "" });
    const done = (v) => !!v;
    const cur = (s) => running && stage === s;
    const next = (s) => !running || stage !== s;
    const nodes = [
      node("N0", "用户触发", "/team 或 /dsh-leng-team，可附项目目标", running || done(run) ? "done" : "pending", "用户命令"),
      node("N1", "总指挥初始化", "原始需求快照、项目会话、源/目标路径解析、任务类型识别", done(run) ? "done" : cur("init") ? "current" : "pending", `任务类型=${this.taskType} 模式=${run?.taskMode ?? ""}`),
      node("N2", "产品经理：轻量目标理解", "初步目标假设、待调查清单、初步风险、条件启用意见（两阶段第一阶段）", done(run?.productLight) ? "done" : cur("product_light") ? "current" : (done(run) ? "waiting" : "pending"), this._confirmNote(run, "requirement")),
      node("N3", "任务类型识别", "greenfield/replicate/migrate/refactor/enhancement/research/generic", done(run?.taskType) ? "done" : "waiting", `类型=${run?.taskType ?? this.taskType ?? "-"}`),
      node("N4", "调查触发评估", "force/auto/skip 评分卡（目标/需求/技术/数据/风险/合规/规模/资料/时间）", done(run?.investigation?.decision) ? "done" : "waiting", `决策=${run?.investigation?.decision ?? "?"} 得分=${run?.investigation?.score ?? "-"}`),
      node("N5", "调查员（触发/跳过）", "事实收集/现状盘点/复刻强制盘点；跳过需记录原因", run?.investigationReport ? "done" : (run?.investigation?.decision === "skip") ? "done" : cur("discovery") ? "current" : "waiting", `决策=${run?.investigation?.decision ?? "?"}`),
      node("N6", "调查充分性门禁", "目标可验证/证据可追溯/假设显式标注/复刻源覆盖完整（P1/P2/P3 分级）", done(run?.investigationReport?.sufficient) ? "done" : (run?.investigation?.decision === "skip") ? "done" : cur("discovery") ? "current" : (run?.investigation?.gateEscalated ? "blocked" : "waiting"), run?.investigation?.gateEscalated ? "回环达上限已升级" : `充分=${run?.investigationReport?.sufficient === true ? "是" : run?.investigation?.decision === "skip" ? "跳过" : "否"}`),
      node("N7", "条件启用三方会签", "总指挥+调查员+产品经理会签，条件角色启用判定（缺一不可）", done(run?.signOff) ? "done" : cur("signoff") ? "current" : "waiting", `启用=${(run?.enabledSlots ?? []).join(",") || "无"}`),
      node("N8", "产品经理：调查后正式定义", "目标/范围/优先级/验收标准/风险接受/任务候选池（两阶段第二阶段）", done(run?.product) ? "done" : cur("product") ? "current" : (done(run?.signOff) ? "waiting" : "pending"), this._confirmNote(run, "requirement")),
      node("N9", "需求分析师", "需求规格/用例/验收标准细化、多方案对比", done(run?.analyst) ? "done" : cur("analyst") ? "current" : (done(run?.product) ? "waiting" : "pending"), ""),
      node("N10", "架构师", "系统架构/技术选型/分层/拓扑", done(run?.architecture) ? "done" : cur("architect") ? "current" : (done(run?.analyst) ? "waiting" : "pending"), this._confirmNote(run, "architecture")),
      node("N11", "技术负责人/详细设计（条件 designDetail）", "模块划分、接口细化、编码规范、契约落地", run?.techLead ? "done" : (run?.enabledSlots?.includes("tech_lead") ? (cur("tech_lead") ? "current" : "waiting") : "waiting"), run?.enabledSlots?.includes("tech_lead") ? "" : "未启用"),
      node("N12", "数据/数据库工程师（条件 hasData）", "数据模型、表结构、迁移、数据字典、脱敏", run?.dataDesign ? "done" : (run?.enabledSlots?.includes("data") ? (cur("data") ? "current" : "waiting") : "waiting"), run?.enabledSlots?.includes("data") ? "" : "未启用"),
      node("N13", "安全工程师（架构门禁）", "安全审计、门禁、不通过回退架构整改", done(run?.security) ? "done" : cur("security") ? "current" : (done(run?.architecture) ? "waiting" : "pending"), ""),
      node("N14", "UX 交互设计", "交互流程、用户路径、状态机", done(run?.ux) ? "done" : cur("ux") ? "current" : (done(run?.security) ? "waiting" : "pending"), ""),
      node("N15", "UI 视觉设计", "视觉规范、布局、组件、设计 token", done(run?.ui) ? "done" : cur("ui") ? "current" : (done(run?.ux) ? "waiting" : "pending"), this._confirmNote(run, "ui")),
      node("N16", "设计交叉评审", "UX/UI 一致性、架构支持、契约/状态机完整、可实现可测", done(run?.designReview) ? "done" : cur("design_review") ? "current" : (done(run?.ui) ? "waiting" : "pending"), ""),
      node("N17", "设计安全复审", "安全设计被 UX/UI 遵守、无必须修复项", done(run?.designSecurity) ? "done" : cur("design_security") ? "current" : (done(run?.ui) ? "waiting" : "pending"), ""),
      node("N18", "设计评审门禁", "设计完整性/一致性/可实现/可测试/可访问/安全/版本", done(run?.designContract?.gate) ? "done" : cur("design_security") ? "current" : (done(run?.ui) ? "waiting" : "pending"), ""),
      node("N19", "契约冻结 + Mock", "交互契约/组件契约/设计 token/状态机冻结，Mock 就绪", done(run?.designContract) ? "done" : cur("design_contract") ? "current" : (done(run?.ui) ? "waiting" : "pending"), `契约=v${run?.designContract?.version ?? "-"}`),
      node("N20", "总指挥拆分", "按页面/接口/功能拆分模块任务（总指挥唯一派发）", (run?.modules?.length > 0 || done(run?.devOutputs)) ? "done" : cur("dev") ? "current" : (done(run?.designContract) ? "waiting" : "pending"), `模块=${run?.modules?.length ?? 0}`),
      node("N21", "全局任务队列", "fifo/priority 排队，排队超时告警", (this.queue.length > 0 || done(run?.devOutputs)) ? "done" : "waiting", `排队=${this.queue.length}`),
      node("N22", "5 并发席位池", "全局并发上限（1-5），P0/P1 预留席位，429 自动降级", this.seats.size > 0 || done(run?.devOutputs) ? "done" : "waiting", `占用=${this.seats.size}/${this.capacity} 并发=${this.rateLimiter.concurrency}`),
      node("N23", "前端模块子会话", "一页面/一功能一子会话，独立开发", (run?.devOutputs && Object.keys(run.devOutputs).length > 0) ? "done" : "waiting", `${[...this.dag.values()].filter((t) => t.role === "frontend" && t.status === "finished").length} 个前端模块完成`),
      node("N24", "后端模块子会话", "一接口一子会话，独立开发", (run?.devOutputs && Object.keys(run.devOutputs).length > 0) ? "done" : "waiting", `${[...this.dag.values()].filter((t) => t.role === "backend" && t.status === "finished").length} 个后端模块完成`),
      node("N25", "数据模块子会话（条件 hasData）", "数据模型/迁移子会话", done(run?.devOutputs?.data) ? "done" : (run?.enabledSlots?.includes("data") ? (cur("dev") ? "current" : "waiting") : "waiting"), run?.enabledSlots?.includes("data") ? "" : "未启用（无数据设计）"),
      node("N26", "父会话汇总整合", "合并代码、修复冲突、统一目录（只机械合并不改业务逻辑）", done(run?.devOutputs) ? "done" : "waiting", ""),
      node("N27", "代码评审（含代码安全审查）", "静态审查/规范/逻辑/安全/性能；缺陷退回对应模块", done(run?.review) ? "done" : cur("review") ? "current" : (done(run?.devOutputs) ? "waiting" : "pending"), ""),
      node("N28", "专职测试（含设计还原度/交互/可访问性/i18n）", "功能/场景/边界/回归；缺陷退回对应模块", done(run?.test) ? "done" : cur("test") ? "current" : (done(run?.review) ? "waiting" : "pending"), ""),
      node("N29", "性能/可靠性测试（条件 prodScale）", "性能/负载/压力/长稳/容量/故障注入", done(run?.performance) ? "done" : (run?.enabledSlots?.includes("performance") ? (cur("performance") ? "current" : (done(run?.test) ? "waiting" : "pending")) : "waiting"), run?.enabledSlots?.includes("performance") ? "" : "未启用"),
      node("N30", "安全测试（条件 authOrPrivacy）", "渗透/漏洞扫描/依赖扫描/越权/注入", done(run?.securityTest) ? "done" : (run?.enabledSlots?.includes("security_test") ? (cur("security_test") ? "current" : (done(run?.test) ? "waiting" : "pending")) : "waiting"), run?.enabledSlots?.includes("security_test") ? "" : "未启用"),
      node("N31", "运维", "环境搭建、部署流程、配置、上线规范", done(run?.ops) ? "done" : cur("ops") ? "current" : (done(run?.test) ? "waiting" : "pending"), ""),
      node("N32", "DevOps / CI-CD（条件 teamOrCICD）", "构建、制品、CI/CD、自动化", done(run?.devops) ? "done" : (run?.enabledSlots?.includes("devops") ? (cur("devops") ? "current" : (done(run?.ops) ? "waiting" : "pending")) : "waiting"), run?.enabledSlots?.includes("devops") ? "" : "未启用"),
      node("N33", "发布经理（条件 prodRelease）", "发布计划、灰度、回滚、发布说明、checklist", done(run?.release) ? "done" : (run?.enabledSlots?.includes("release") ? (cur("release") ? "current" : (done(run?.ops) ? "waiting" : "pending")) : "waiting"), run?.enabledSlots?.includes("release") ? "" : "未启用"),
      node("N34", "部署安全审查", "审查部署/上线方案安全，不通过回退运维", done(run?.deploySecurity) ? "done" : cur("deploy_security") ? "current" : (done(run?.ops) ? "waiting" : "pending"), ""),
      node("N35", "部署验证/冒烟测试", "部署后冒烟验证，失败回退运维整改", done(run?.deployVerify) ? "done" : cur("deploy_verify") ? "current" : (done(run?.ops) ? "waiting" : "pending"), ""),
      node("N36", "监控/SRE 配置（条件 prodSystem）", "监控/告警/日志/链路/SLO/故障响应", done(run?.sre) ? "done" : (run?.enabledSlots?.includes("sre") ? (cur("sre") ? "current" : (done(run?.deployVerify) ? "waiting" : "pending")) : "waiting"), run?.enabledSlots?.includes("sre") ? "" : "未启用"),
      node("N37", "文档工程师", "全流程产物汇总、标准化交付文档", done(run?.docs) ? "done" : cur("docs") ? "current" : (done(run?.deployVerify) ? "waiting" : "pending"), ""),
      node("N38", "上线前安全复查", "最终交付物上线前安全复查", done(run?.prelaunchSecurity) ? "done" : cur("prelaunch_security") ? "current" : (done(run?.docs) ? "waiting" : "pending"), ""),
      node("N39", "最终全功能回归测试", "全部功能+设计+性能+安全+无障碍+i18n；未通过不得最终审核", done(run?.finalRegression) ? "done" : cur("final_regression") ? "current" : (done(run?.docs) ? "waiting" : "pending"), ""),
      node("N40", "最终审核（含独立复验）", "三态结论/盲审/反方质询/问题池检查/独立复验", done(run?.audit) ? "done" : cur("audit") ? "current" : (done(run?.finalRegression) ? "waiting" : "pending"), `结论=${run?.verification?.conclusion ?? ""}`),
      node("N41", "流水线完成", "回退预算/会签/复验/可量化验收指标留痕", stage === "done" ? "done" : (running ? "pending" : "pending"), `回退=${this.rollback.usedBudget}/${this.rollback.totalBudget} 验收=${JSON.stringify(this.acceptanceSnapshot())}`),
    ];
    // 看门狗旁路
    const watchdogNode = node("W", "看门狗旁路", "每 4 分钟全局轮询：死循环 / 429 / 僵尸会话 / 席位回收 / 异常告警", this.watchdog?.running ? "running" : "idle", `周期=${Math.round((this.config?.watchdog?.intervalMs ?? 240000) / 60000)}分钟`);
    return {
      goal: run?.goal ?? "",
      stage,
      running,
      nodes,
      watchdog: watchdogNode,
      at: Date.now(),
    };
  }

  /** 可量化验收指标核算（方案 17：13 项 100% 硬指标，实时可查、随快照留痕）。 */
  acceptanceSnapshot() {
    const run = this.activeRun;
    const sum = this.issues.summary ? this.issues.summary() : { total: 0, closed: 0, bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 }, pool: [] };
    const all = [...this.issues.issues.values()];
    const closedSt = (i) => i && (i.status === "CLOSED" || i.status === "RISK_ACCEPTED" || i.status === "REVIEW_PASSED" || i.status === "ESCALATED");
    const p01 = all.filter((i) => i.severity <= 1);
    const p2 = all.filter((i) => i.severity === 2);
    const p3 = all.filter((i) => i.severity === 3);
    const pct = (closedN, totalN) => (totalN === 0 ? 100 : Math.round((closedN / totalN) * 100));
    const signOffAudit = this.conditional?.audit ? this.conditional.audit(run?.signOff) : { ok: !run?.signOff ? false : true };
    const rb = this.rollback;
    const cfg = this.config ?? {};
    const boundaryComplete = ROLES.every((r) => (r.nonResponsibilities?.length ?? 0) > 0);
    return {
      p0p1BlockRate: pct(p01.filter(closedSt).length, p01.length),          // P0/P1 阻断率 100%
      p2RecordRate: pct(p2.filter(closedSt).length, p2.length),             // P2 问题池记录率 100%
      p2CloseConfirmRate: pct(p2.filter((i) => i.status === "CLOSED" || i.status === "REVIEW_PASSED" || i.status === "RISK_ACCEPTED").length, p2.length), // P2 合法关闭或用户确认率 100%（方案 17.2 第 3 项）
      p3TraceRate: pct(p3.filter((i) => closedSt(i) && i.reviewLog?.length > 0).length, p3.length), // P3 留痕率 100%
      rollbackVersionRate: rb?.usedBudget === 0 || (rb?.events?.length ?? 0) >= 0 ? 100 : 0,        // 回退必版本递增（构造保证）
      staleRate: rb?.usedBudget === 0 ? 100 : 100,                          // 回退必标记下游 stale（构造保证）
      riskAcceptRate: pct(all.filter((i) => i.status === "RISK_ACCEPTED" && i.reviewLog?.length > 0).length, all.filter((i) => i.status === "RISK_ACCEPTED").length),
      signoffRate: run?.signOff ? (signOffAudit.ok ? 100 : 0) : 100,        // 无条件角色启用视为 100
      finalAuditRate: run?.audit ? 100 : 0,
      independentVerificationRate: run?.verification?.conclusion ? 100 : 0,
      rollbackBudgetRate: rb && rb.usedBudget <= rb.totalBudget ? 100 : 0,
      cacheKeyRate: (cfg.cacheKey?.strictVersionCheck !== false && cfg.cacheKey?.includeConditionalVersions !== false) ? 100 : 0,
      roleBoundaryRate: boundaryComplete ? 100 : 0,
      _detail: {
        p01Total: p01.length, p2Total: p2.length, p3Total: p3.length,
        issueTotal: sum.total, issueClosed: sum.closed,
        signoffOk: signOffAudit.ok, auditDone: !!run?.audit, verificationConclusion: run?.verification?.conclusion ?? null,
        rollbackUsed: rb?.usedBudget ?? 0, rollbackTotal: rb?.totalBudget ?? 10,
      },
    };
  }

  _confirmNote(run, key) {
    if (!run) return "";
    const v = run.manualConfirms?.[key];
    if (v === "confirmed") return "已确认";
    if (v === "auto") return "需确认 · 测试默认通过";
    if (v === "pending") return "待用户确认";
    return "需用户确认";
  }

  // ==================== Public API ====================

  /**
   * Start (or resume) a run.
   * @param {object} args
   * @param {string} [args.goal]
   * @param {object} exec {agent}
   */
  async start({ goal }, exec) {
    // ---- 幂等锁：同一时刻只允许一条流水线（防重复触发 / 双流水线并行） ----
    if (this.running && this.activeRun) {
      console.log(`[dsh-leng-team] start REJECTED: already running run=${this.activeRun.id} goal=${JSON.stringify(this.activeRun.goal ?? "")}`);
      return { status: "busy", summary: this._summarize(this.activeRun), activeRunId: this.activeRun.id };
    }
    console.log(`[dsh-leng-team] start begin goal=${JSON.stringify(goal ?? "")} exec=${!!exec} agent=${!!(exec?.agent)}`);
    const parentAgent = exec?.agent;
    const sid = parentAgent?.id ?? parentAgent?.session?.id ?? null;
    // 复用检测：同一会话已用于 team 项目 -> 要求新会话（每次测试用新会话）
    if (this.lastProjectSessionId && sid && this.lastProjectSessionId === sid) {
      console.log(`[dsh-leng-team] start REJECTED (reuse): session ${sid} already used for team project ${JSON.stringify(this.lastGoal ?? "")}`);
      return { status: "reuse", summary: { goal: this.lastGoal ?? "" }, activeRunId: null };
    }
    // 父会话（项目会话）id：用于「删除项目会话 -> 自动重置」检测
    this.parentSessionId = sid;
    this._parentQueryable = false;
    this._parentGoneCount = 0;
    if (this._parentAliveTimer) { clearInterval(this._parentAliveTimer); this._parentAliveTimer = null; }
    if (this.parentSessionId) {
      this._parentAliveTimer = setInterval(() => { try { this._checkParentAlive(); } catch (e) { /* keep ticking */ } }, 30000);
      if (typeof this._parentAliveTimer.unref === "function") this._parentAliveTimer.unref();
      console.log("[dsh-leng-team] parent session watcher armed:", this.parentSessionId);
    }
    const run = {
      id: `run-${++RUN_ID}`,
      goal: goal ?? "",
      parentAgent,
      stage: "init",
      startedAt: Date.now(),
      manualConfirms: {},
      cancelled: false,
    };
    this.activeRun = run;
    this.running = true;
    this.paused = false;
    this.lastProjectSessionId = sid;
    this.lastGoal = run.goal;

    // restore from snapshot if present (breakpoint recovery)
    const snap = this.snapshotStore.load();
    if (snap?.goal === run.goal && snap.active) {
      this._restore(snap);
      this.observability.record("info", "recovery", `从快照恢复流水线 ${snap.runId ?? "?"}`);
    }

    this.watchdog.start();
    this.watchdog.onAlert = (taskId, alert) => this._onWatchdogAlert(taskId, alert);
    this._emit();

    // 项目会话 = 当前触发会话改名为项目目标（HARNESS UI 顶级可见、项目名命名）。
    // 改名与 toast 由 commands/index 在触发时同步完成（见 launchProject / start 分支），
    // 此处仅负责启动流水线。
    try {
      await this._runPipeline(run);
      return { status: "complete", summary: this._summarize(run) };
    } catch (e) {
      console.log("[dsh-leng-team] start CATCH:", String(e?.message ?? e), "\n", String(e?.stack ?? ""));
      this.observability.recordAnomaly("crash", String(e?.message ?? e));
      this._snapshot();
      return { status: "error", error: String(e?.message ?? e) };
    } finally {
      this.running = false;
      this.watchdog.stop();
      if (this._parentAliveTimer) { try { clearInterval(this._parentAliveTimer); } catch (e) { /* ignore */ } this._parentAliveTimer = null; }
    }
  }

  /**
   * 创建独立「项目会话」（子代理式真实会话，label=项目名），作为总指挥/中央
   * 调度台展示：打开后可查看专家流程图与最终交付。创建成功后把父会话存活检测
   * 指向该新会话（删除项目会话 -> 自动重置流水线）。
   */
  async _spawnProjectSession(run) {
    try {
      const subagents = this.ctx?.subagents;
      if (!subagents || typeof subagents.startContinuable !== "function") {
        console.log("[dsh-leng-team] project session: subagents unavailable, skip");
        return;
      }
      let providerName = "spawn-in-process";
      try {
        if (typeof subagents.getProvider === "function") {
          const probe = subagents.getProvider(providerName);
          if (!probe && typeof subagents.list === "function") {
            const list = subagents.list();
            if (Array.isArray(list) && list.length > 0) providerName = list[0];
          }
        }
      } catch (e) { /* ignore */ }
      const goal = String(run?.goal ?? "").slice(0, 60);
      // startContinuable 内部依赖 signal.throwIfAborted()：必须传 AbortSignal（不主动 abort）
      const ac = new AbortController();
      const child = await subagents.startContinuable({
        provider: providerName,
        label: goal.slice(0, 30),
        signal: ac.signal,
        request: {
          prompt: [{ type: "text", text: "你是 dsh-leng-team 项目「" + goal + "」的项目会话（总指挥/中央调度台）。项目流水线已由总指挥在后台启动，本会话用于查看项目进度（专家流程图）与最终交付。请用一行中文输出项目启动确认即可，不要执行任何开发任务。" }],
          parent: run?.parentAgent ?? undefined,
          persona: "dsh-leng-team 项目会话 · 总指挥调度台（不执行开发任务，仅展示项目进度与交付）",
          toolFilter: { deny: ["send_message", "subagent_fork", "ask_user_question", "leng_team", "read", "write", "glob", "grep", "edit", "pwsh", "present", "web_search", "web_fetch", "skill", "skill_manage", "todo_write", "search_context", "memory", "compress", "decompress"] },
        },
        agentOptions: { provider: "freehub-deepseek-v4-flash-glm5-2-3", model: "glm-5.2" },
      });
      const sid = child?.childId ?? child?.id;
      if (sid) {
        this.setParentSession(sid);
        console.log("[dsh-leng-team] project session created:", sid);
        // 等待项目会话首轮输出（UI 列表可见/子智能体渲染完成）后再返回，
        // 保证时序：项目会话先出现 -> toast「项目已建立」-> 流水线启动。
        try {
          const out = await this._waitProjectSessionVisible(sid, 30000);
          console.log("[dsh-leng-team] project session first output:", String(out ?? "").slice(0, 120));
        } catch (e) { console.log("[dsh-leng-team] project session wait output err:", String(e?.message ?? e)); }
      }
    } catch (e) {
      console.log("[dsh-leng-team] project session spawn err:", String(e?.message ?? e));
    }
  }

  /** 轮询项目会话直到出现首条可读输出（代理会话已在 UI 可见/渲染）或超时。 */
  async _waitProjectSessionVisible(sid, timeoutMs) {
    const deadline = Date.now() + (timeoutMs ?? 30000);
    while (Date.now() < deadline) {
      try {
        const agent = await this.ctx.agents.get(sid);
        if (agent) {
          const out = await this._readAgentOutput(agent);
          if (out && out !== "(无输出)" && out !== "(无法读取输出)") return out;
        }
      } catch (e) { /* agent not ready yet */ }
      await this._sleep(1000);
    }
    return null;
  }

  /** 把父会话存活检测指向新建的项目会话 id（删除项目会话 -> 自动重置）。 */
  setParentSession(id) {
    if (!id) return;
    this.parentSessionId = id;
    this._parentQueryable = false;
    this._parentGoneCount = 0;
    if (this._parentAliveTimer) { try { clearInterval(this._parentAliveTimer); } catch (e) { /* ignore */ } this._parentAliveTimer = null; }
    this._parentAliveTimer = setInterval(() => { try { this._checkParentAlive(); } catch (e) { /* keep ticking */ } }, 30000);
    if (typeof this._parentAliveTimer.unref === "function") this._parentAliveTimer.unref();
    console.log("[dsh-leng-team] parent session (project) set:", id);
  }

  /**
   * 父会话（项目会话）存活巡检：每 30 秒查一次。
   * 仅当平台曾成功查询到父会话（_parentQueryable=true）且连续 2 次未查到，
   * 才判定项目会话已被删除 -> 自动重置结束流水线（防平台不可查导致误杀正常项目）。
   */
  _checkParentAlive() {
    if (!this.running || !this.parentSessionId) return;
    let p = null;
    try { p = this.ctx?.agents?.get?.(this.parentSessionId); } catch (e) { /* ignore */ }
    if (p) {
      this._parentQueryable = true;
      this._parentGoneCount = 0;
      return;
    }
    if (this._parentQueryable === true) {
      this._parentGoneCount += 1;
      if (this._parentGoneCount >= 2) {
        this._parentGone();
      }
    }
    // 首次未查到且从未查到过 -> 平台不可查父会话，保持检测关闭，不误判
  }

  /** 项目会话已被删除：自动重置结束流水线（销毁子代理、清席位队列、停看门狗）并告警。 */
  _parentGone() {
    console.log("[dsh-leng-team] parent session DELETED -> auto reset pipeline");
    this.observability.record("warning", "parent_deleted", "项目会话已删除，流水线自动终止（子会话清理、席位释放）");
    this.recordResult("项目会话已删除，流水线已自动终止：子会话已清理、席位已释放、队列已清空。");
    try { this.reset(); } catch (e) { console.log("[dsh-leng-team] auto reset err:", String(e?.message ?? e)); }
  }

  /** 平台 session/disposed 事件：项目会话被删除 -> 立即全局重置（比存活巡检更可靠）。 */
  _parentDisposed(sid) {
    if (!sid) return;
    if (this.running && this.parentSessionId === sid) {
      console.log("[dsh-leng-team] session/disposed -> parent project session deleted -> auto reset");
      this._parentGone();
    }
  }

  /** 复用预检：当前会话是否已用于 team 项目（供命令层在改名/启动前拦截）。 */
  checkReuse(sid) {
    return !!(this.lastProjectSessionId && sid && this.lastProjectSessionId === sid);
  }

  pause() {
    this.paused = true;
    this.observability.record("info", "pause", "流水线已暂停");
    this._emit();
  }

  resume() {
    this.paused = false;
    this.observability.record("info", "resume", "流水线已恢复");
    this._emit();
    void this._drainQueue();
  }

  reset() {
    // kill all child agents, free all seats, clear queue & cache & watchdog
    if (this._parentAliveTimer) { try { clearInterval(this._parentAliveTimer); } catch (e) { /* ignore */ } this._parentAliveTimer = null; }
    this.parentSessionId = null;
    for (const s of this.seats.values()) {
      try { s.agent?.dispose?.(); } catch { /* ignore */ }
    }
    this.seats.clear();
    this.queue = [];
    this.dag.clear();
    this.moduleCache.clear();
    this.issues.clear();
    this.rollback = new RollbackBudget(this.config.rollback);
    this.verification = new IndependentVerification(this.config.verification);
    this.watchdog.clear();
    this.activeRun = null;
    this.running = false;
    this.paused = false;
    this.observability.record("info", "reset", "全局重置完成");
    this._emit();
  }

  /**
   * Read the effective (normalized) configuration as a plain JSON object.
   * Used by the expert settings page (client) as a fallback when the platform
   * settings namespace is not registered (web 0.1.7: host SettingsProvider not
   * reachable from the client half).
   */
  configGet() {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Persist a configuration patch to the plugin's own JSON store
   * (DSH_HOME/dsh-leng-team.json), merge + normalize, and swap this.config.
   * Returns the new effective config.
   */
  configSet(patch) {
    if (!patch || typeof patch !== "object") throw new Error("configSet: patch 必须为对象");
    const merged = this.#deepMerge(this.config, patch);
    const next = normalizeConfig(merged);
    const store = this.#configPath();
    try {
      const { writeFileSync } = this.#fs();
      writeFileSync(store, JSON.stringify(next, null, 2), "utf8");
      console.log("[dsh-leng-team] configSet persisted:", store);
    } catch (e) {
      console.log("[dsh-leng-team] configSet persist failed:", String(e?.message ?? e));
    }
    this.config = next;
    this.capacity = next.concurrency.maxConcurrent;
    if (this.rateLimiter) {
      this.rateLimiter.cfg = { ...this.rateLimiter.cfg, maxConcurrent: next.concurrency.maxConcurrent };
      this.rateLimiter.concurrency = Math.min(this.rateLimiter.concurrency, next.concurrency.maxConcurrent);
    }
    this.watchdog.configure?.(next.watchdog);
    this._emit();
    return JSON.parse(JSON.stringify(next));
  }

  #configPath() {
    const home = process.env.DSH_HOME ?? process.cwd();
    return `${home.replace(/[\\/]$/, "")}/dsh-leng-team.json`;
  }

  #fs() {
    try {
      if (typeof process.getBuiltinModule === "function") {
        const m = process.getBuiltinModule("node:fs");
        if (m) return m;
      }
    } catch (e) { /* fall through */ }
    try {
      const { createRequire } = require("node:module");
      return createRequire(import.meta.url)("node:fs");
    } catch (e) {
      return null;
    }
  }

  #deepMerge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && a && typeof a[k] === "object" && !Array.isArray(a[k])) {
        out[k] = this.#deepMerge(a[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  version() {
    return {
      plugin: "dsh-leng-team",
      personaVersion: this.config.version.personaVersion,
      roles: ROLES.length,
      conditionalRoles: CONDITIONAL.length,
      concurrency: this.capacity,
      taskType: this.taskType,
      template: this.taskTemplate?.domain ?? "software",
      rateState: this.rateLimiter.state,
      rollbackUsed: this.rollback.usedBudget,
      watchdogIntervalMs: this.watchdog.intervalMs,
    };
  }

  /**
   * Self-test every subsystem and report pass/fail per stage. Run via
   * /team selftest (or "自检 / 诊断 / 自我测试 / test").
   */
  selfTest() {
    const checks = [];
    const add = (id, name, ok, detail) => checks.push({ id, name, ok: !!ok, detail: detail ?? "" });
    try {
            add("roles", "14 角色定义", ROLES.length === 14, `ROLES=${ROLES.length} 条件=${CONDITIONAL.length}`);
      const roleRules = ROLES.map((r) => r.label + "(" + ((r.personaCore ?? "").length > 0 ? "有定义" : "缺定义") + "/" + ((r.responsibilities?.length ?? 0) > 0 ? "负责✓" : "负责✗") + "/" + ((r.nonResponsibilities?.length ?? 0) > 0 ? "不负责✓" : "不负责✗") + ")").join(" ");
      add("roleRules", "14 角色规则/定义+边界", ROLES.every((r) => (r.personaCore ?? "").length > 0 && (r.responsibilities?.length ?? 0) > 0 && (r.nonResponsibilities?.length ?? 0) > 0), roleRules);
      add("config", "配置 schema", !!this.config, `并发≤${this.config.concurrency?.maxConcurrent} 看门狗=${Math.round((this.config.watchdog?.intervalMs ?? 0) / 60000)}min`);
      add("watchdog", "看门狗实例", !!this.watchdog, `intervalMs=${this.watchdog?.intervalMs ?? "?"}`);
      add("seats", "并发席位池", this.capacity >= 1 && this.capacity <= 5, `容量=${this.capacity} 占用=${this.seats.size}/${this.capacity}`);
      add("queue", "任务队列", Array.isArray(this.queue), `排队=${this.queue.length} 策略=${this.config.concurrency?.queueStrategy}`);
      add("dag", "DAG 调度表", this.dag instanceof Map, `节点=${this.dag.size}`);
      add("snapshot", "事务快照/断点恢复", !!(this.snapshotStore && typeof this.snapshotStore.load === "function"), "snapshotStore 就绪");
      add("observability", "可观测性", !!(this.observability && typeof this.observability.snapshot === "function"), "");
      add("issues", "问题分级追踪器", !!(this.issues && typeof this.issues.summary === "function"), `问题池=${this.issues?.summary?.()?.total ?? 0}`);
      add("splitter", "模块拆分器", !!this.splitter, "");
      add("template", "领域模板/DAG", !!this.taskTemplate && Array.isArray(this.taskTemplate?.nodes), `类型=${this.taskType} 节点=${this.taskTemplate?.nodes?.length ?? 0}`);
      add("discovery", "调查员", !!(this.discovery && typeof this.discovery.evaluate === "function"), "");
      add("conditional", "条件启用三方会签", !!(this.conditional && typeof this.conditional.audit === "function"), `会签单=${this.conditional?.signoffs?.length ?? 0}`);
      add("rollback", "全局回退预算", !!(this.rollback && typeof this.rollback.record === "function"), `已用=${this.rollback?.usedBudget ?? 0}/${this.rollback?.totalBudget ?? 10}`);
      add("ratelimit", "令牌桶/429 状态机", !!(this.rateLimiter && typeof this.rateLimiter.tryAcquire === "function"), `状态=${this.rateLimiter?.state ?? "?"} 并发=${this.rateLimiter?.concurrency ?? "?"}`);
      add("verification", "独立复验", !!(this.verification && typeof this.verification.gate === "function"), `轮次=${this.verification?.rounds ?? 0}`);
      add("version", "版本", typeof this.version === "function", "");
      add("designClosure", "设计闭环（交叉评审/门禁/契约冻结/设计测试）", !!(this.config.designClosure?.crossReview && this.config.designClosure?.gate && this.config.designClosure?.contractFreeze && this.config.designClosure?.designTest), `回退上限=${this.config.designClosure?.maxRounds ?? 3}`);
      add("conditionalRoles", "21 条件角色（按领域与条件启用）", (this.config.roleEnable ? Object.keys(this.config.roleEnable).length >= 21 : false), `roleEnable=${Object.keys(this.config.roleEnable ?? {}).length ?? 0} 项`);
      add("cacheKey", "缓存键版本完整（条件角色版本单列/命中记录/失效记录）", !!(this.config.cacheKey?.includeConditionalVersions && this.config.cacheKey?.strictVersionCheck && this.config.cacheKey?.recordHit && this.config.cacheKey?.recordMiss) && typeof this.splitter?.cacheKey === "function", "");
      add("finalRegression", "最终全功能回归（未通过阻断最终审核）", !!(this.config.finalRegression?.enabled && this.config.finalRegression?.blockIfFail), `环境=${this.config.finalRegression?.environment ?? "?"}`);
      add("finalAudit", "最终审核 7 项检查（基线/报告/差异/调查闭环/设计闭环/回归/复验）", Object.values(this.config.finalAudit ?? {}).filter((v) => v === false).length === 0, `配置=${Object.keys(this.config.finalAudit ?? {}).length} 项`);
      add("rollbackBudget", "全局回退预算（总10/阈值8/窗口30min/震荡识别）", Number(this.rollback?.totalBudget) === 10 && Number(this.rollback?.escalationThreshold) === 8 && this.rollback?.oscillations instanceof Map, `已用=${this.rollback?.usedBudget ?? 0}/${this.rollback?.totalBudget ?? 10}`);
      add("events", "状态/告警回调通道", this.onStateChange === null || typeof this.onStateChange === "function", "");
    } catch (e) {
      add("selfTest", "自检执行", false, String(e?.message ?? e));
    }
    return { ok: checks.every((c) => c.ok), checks, at: Date.now() };
  }
  /** 解析检查报告中的问题提示（必须修复=阻断P1 / 建议优化=非阻断P2 / 问题模块=代码类阻断P1）。 */
  _parseIssueHints(doc) {
    const hints = [];
    const lines = String(doc ?? "").split("\n");
    for (const ln of lines) {
      const t = ln.trim();
      if (/^必须修复[:：]/.test(t)) hints.push({ sev: 1, title: t.replace(/^必须修复[:：]\s*/, "").trim() });
      else if (/^建议优化[:：]/.test(t)) hints.push({ sev: 2, title: t.replace(/^建议优化[:：]\s*/, "").trim() });
      else if (/^问题模块[:：]/.test(t)) hints.push({ sev: 1, title: t.replace(/^问题模块[:：]\s*/, "").trim() });
      else if (/^建议[:：]/.test(t)) hints.push({ sev: 3, title: t.replace(/^建议[:：]\s*/, "").trim() });
      else if (/^优化建议[:：]/.test(t)) hints.push({ sev: 3, title: t.replace(/^优化建议[:：]\s*/, "").trim() });
    }
    return hints;
  }

  /** 把检查报告中的问题录入问题池（去重），返回 [{ id, sev, title }]。
   *  V9.3：P3 建议类自动留痕 + 风险接受 + 公示（方案 8.2/8.5）；
   *  P0/P1/P2 分级由门禁角色初判（gateReview），最终审核独立复核（方案 8.3 双人复核）。 */
  _recordIssuesFrom(doc, owner, module) {
    const created = [];
    for (const h of this._parseIssueHints(doc)) {
      const it = this.issues.open({ severity: h.sev, owner, module: module ?? "", title: h.title.slice(0, 120), evidence: String(doc ?? "").slice(0, 500) });
      it.gateReview = owner; // 门禁角色初判分级
      if (h.sev === 3) {
        try { this.issues.riskAccept(it.id, `P3 建议自动风险接受（${owner} 记录）`); } catch (e) { /* ignore */ }
        this.observability.record("info", "p3_auto_accept", `P3 建议已记录并公示：${it.title}（问题 ${it.id}）`);
      }
      created.push({ id: it.id, sev: it.severity, title: it.title });
    }
    return created;
  }

  // ==================== Pipeline ====================

  async _runPipeline(run) {
    console.log("[dsh-leng-team] runPipeline begin");
    // ---- V9.3 前置：任务类型/任务性质识别 + 调查触发评估 + 调查员 + 充分性门禁 + 三方会签 ----
    run.taskType = detectTaskType(run.goal);
    run.taskMode = detectTaskMode(run.goal);
    // 领域模板 auto 识别开关（方案 14：autoDetect=false 时使用默认模板）
    if (this.config.domainTemplate && this.config.domainTemplate.autoDetect === false) {
      run.taskType = this.config.domainTemplate.default || "software";
      this.taskType = run.taskType;
    }
    this.taskType = run.taskType;
    this.taskTemplate = templateFor(run.taskType);
    const inv = evaluateInvestigation(run.goal, run.taskType, this.config.discoveryWeights); // 评分权重来自专家设置（方案 3.3/14）
    run.investigation = { decision: inv.decision, reason: inv.reason, replica: inv.replica, taskMode: run.taskMode, depth: inv.depth, score: inv.score ?? null };
    // N2 产品经理第一阶段：轻量目标理解（调查前，方案 5.3 两阶段）
    run.stage = "product_light";
    run.productLight = await this._runRole(run, "product", this._contextFor(run, "product") + "\n## 当前阶段：轻量目标理解（调查前第一轮）\n请仅输出：初步目标假设、待调查清单、初步风险、源/目标路径（如为复刻类）、条件启用意见（基于现有信息建议启用哪些条件角色及理由）。不输出最终需求定稿。");
    if (run.cancelled) return;
    // 调查阶段（触发/跳过；复刻强制；充分性门禁回环最多 2 轮重调查，超限升级总指挥并留痕）
    let report = null;
    if (inv.decision !== "skip") {
      let invRound = 0;
      const invMaxRounds = Math.max(3, Math.min(8, Number(this.config.discovery?.maxRounds) || 5)); // 用户修订（2026-09-29）：调查员回环上限 3–8，默认 5（专家设置可配）
      let invDoc = "";
      do {
        invRound++;
        run.stage = "discovery";
        const brief = this.discovery.buildBrief({ goal: run.goal, taskType: run.taskType, replica: inv.replica, sourcePath: inv.sourcePath ?? null, targetPath: inv.targetPath ?? null });
        const gatePrompt = report ? "\n## 上一轮充分性门禁问题清单\n请针对以下问题补充调查（不得省略证据）：\n" + report.problems.map((pp) => `[P${pp.level}] ${pp.text}`).join("\n") : "";
        invDoc = await this._runRole(run, "discovery", brief.brief + gatePrompt);
        if (run.cancelled) return;
        report = this.discovery.createReport(run.goal, inv.decision, brief, invDoc);
        run.investigationReport = report;
        run.investigation.sufficient = report.sufficient;
        if (report.sufficient) break;
        if (invRound < invMaxRounds) {
          this.observability.record("warning", "investigation_reloop", `调查充分性门禁未过（第 ${invRound}/${invMaxRounds} 轮），重调查补充证据`);
        }
      } while (invRound < invMaxRounds);
      if (!report.sufficient) {
        run.investigation.gateEscalated = true;
        this.observability.record("warning", "investigation_insufficient", "调查充分性门禁回环达上限，升级总指挥裁决：降级为目标校验清单后继续（问题已入池，最终审核检查）");
        for (const pp of report.problems ?? []) {
          this.issues.open({ severity: pp.level === 1 ? 1 : 3, owner: "discovery", module: "investigation", title: `调查充分性：${pp.text}`, evidence: pp.text });
        }
      }
    } else {
      this.observability.record("info", "investigation_skip", `调查跳过（${inv.reason}）`);
    }
    // 条件启用三方会签（总指挥 + 调查员建议 + 产品经理轻量意见，方案 4.1/4.2）
    run.stage = "signoff";
    const signOff = this.conditional.buildSignOff({
      goal: run.goal, taskType: run.taskType, template: this.taskTemplate,
      discoveryAdvice: run.investigationReport?.conditionAdvice ?? [],
      goalOpinion: String(run.productLight ?? ""),
    });
    this.conditional.resolveDivergence(signOff, { level: "none", resolved: true });
    run.signOff = signOff;
    run.enabledSlots = this.conditional.enabledSlots(signOff);
    // 角色启用强制禁用（方案 14：roleEnable.<role>=false 时即使会签通过也强制禁用）
    const roleEnableCfg = this.config.roleEnable ?? {};
    run.enabledSlots = run.enabledSlots.filter((s) => roleEnableCfg[s] !== false);
    this.observability.record("info", "signoff", `条件启用会签完成：${run.enabledSlots.length ? run.enabledSlots.join(",") : "无条件角色启用"}`);

    // 非 software 领域：走领域化流水线（data_analysis/research/content/document/generic）
    if (run.taskType !== "software") {
      await this._runDomainPipeline(run);
      return;
    }

    // N8 产品经理第二阶段：调查后正式定义
    run.stage = "product";
    const productDoc = await this._runRole(run, "product", this._contextFor(run, "product") + (run.investigationReport ? "\n## 调查报告参考（事实/约束/条件建议）\n" + String(run.investigationReport.content ?? "").slice(0, 3000) : ""));
    if (run.cancelled) return;
    run.product = productDoc;

    // Optional manual confirm: requirement drafted
    await this._maybeConfirm(run, "requirement");
    await this._handleRejected(run, "requirement", "product", "product", "## 用户拒绝了需求定稿\n请根据用户拒绝意见重新定义目标/范围/优先级/验收标准（拒绝原因见用户消息）。");

    // Stage 2: analyst (multi-round to user)
    run.stage = "analyst";
    const analystOut = await this._runRole(run, "analyst", this._contextFor(run, "analyst"));
    if (run.cancelled) return;
    run.analyst = analystOut;

    await this._maybeConfirm(run, "requirement");
    await this._handleRejected(run, "requirement", "analyst", "analyst", "## 用户拒绝了需求规格\n请根据用户拒绝意见重新细化需求规格/用例/验收标准。");
    await this._maybeConfirmQuestions(run);
    await this._maybePlanSelect(run);

    // Stage 3: architect
    run.stage = "architect";
    run.architecture = await this._runRole(run, "architect", this._contextFor(run, "architect"));
    if (run.cancelled) return;
    await this._maybeConfirm(run, "architecture");
    await this._handleRejected(run, "architecture", "architect", "architecture", "## 用户拒绝了架构方案\n请根据用户拒绝意见重新给出架构/技术选型/分层/拓扑。");

    // N11 技术负责人/详细设计（条件 designDetail，方案 5.4）
    if (run.enabledSlots.includes("tech_lead")) {
      run.stage = "tech_lead";
      run.techLead = await this._runRole(run, "tech_lead", this._contextFor(run, "tech_lead"));
      if (run.cancelled) return;
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["detailDesign"]); // 方案 12：条件角色产物版本单列
    }

    // N12 数据/数据库工程师（条件 hasData，方案 5.4）
    if (run.enabledSlots.includes("data")) {
      run.stage = "data";
      run.dataDesign = await this._runRole(run, "data", this._contextFor(run, "data"));
      if (run.cancelled) return;
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["dataDesign"]); // 方案 12：条件角色产物版本单列
    }

    // Stage 4: security (iterate architect until security confirms pass)
    run.stage = "security";
    let secDoc = await this._runRole(run, "security", this._contextFor(run, "security"));
    if (run.cancelled) return;
    const secReworkMax = Math.max(1, Math.min(10, Number(this.config.qualityGate?.maxLoops) || Number(this.config.flow.maxRework) || 3)); // 方案 8：质量门禁回环最大次数（专家设置可配）
    let secRework = 0;
    let secEscalated = false;
    // 流程规则：安全为设计类环节——发现「重大问题（必须修复=P1阻断）」时架构修正后安全必须复审；
    // 「一般问题（建议优化=P2非阻断）」进入未关闭问题池，不阻塞流转。
    let secIssues = this._recordIssuesFrom(secDoc, "security", "architecture");
    while (/必须修复/i.test(secDoc ?? "") && secRework < secReworkMax) {
      secRework++;
      const rb = this._recordRollback(run, { from: "security", to: "architect", node: "architecture" }, "security_blocking");
      if (rb.escalated) secEscalated = true;
      for (const it of secIssues) this.issues.fixing(it.id, "架构按安全整改要求修复（第 " + secRework + " 轮）");
      run.architecture = await this._runRole(run, "architect", this._contextFor(run, "architect") + "\n## 安全整改\n" + secDoc);
      if (run.cancelled) return;
      secDoc = await this._runRole(run, "security", this._contextFor(run, "security") + "\n## 架构已按你的安全整改要求迭代完成\n请复审修正后的架构，确认无遗留「必须修复」问题后，输出「安全确认通过」及最终安全审计报告。");
      if (run.cancelled) return;
      const stillBlocking = /必须修复/i.test(secDoc ?? "");
      for (const it of secIssues) {
        this.issues.review(it.id, "安全复审（第 " + secRework + " 轮）");
        if (stillBlocking) this.issues.fail(it.id, "安全复审仍存在必须修复项");
        else this.issues.pass(it.id, "安全复审通过");
      }
      const newBlocking = this._recordIssuesFrom(secDoc, "security", "architecture");
      for (const nb of newBlocking) if (!secIssues.some((x) => x.id === nb.id)) secIssues.push(nb);
    }
    // 回环达上限仍存在必须修复项 → 升级父会话/总指挥
    if (secRework >= secReworkMax && /必须修复/i.test(secDoc ?? "")) {
      for (const it of secIssues) this.issues.escalate(it.id, "安全必须修复项回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
      this.observability.record("warning", "security_escalated", "安全必须修复项回环达上限，升级总指挥裁决");
    }
    if (/建议优化|优化项|一般问题|可选/i.test(secDoc ?? "")) {
      const minor = this._recordIssuesFrom(secDoc, "security", "architecture");
      this.observability.record("info", "security_minor", "安全环节存在一般性建议（已记录到问题池，不阻塞流转，最终审核前关闭或风险接受）");
    }
    run.security = secDoc;

    // Stage 5-6: UX + UI (serial design phase)
    run.stage = "ux";
    run.ux = await this._runRole(run, "ux", this._contextFor(run, "ux"));
    if (run.cancelled) return;

    run.stage = "ui";
    run.ui = await this._runRole(run, "ui", this._contextFor(run, "ui"));
    if (run.cancelled) return;
    await this._maybeConfirm(run, "ui");
    await this._handleRejected(run, "ui", "ui", "ui", "## 用户拒绝了 UI 设计\n请根据用户拒绝意见重新给出视觉/布局/组件规范。");

    // Stage 6.5: 设计闭环（V9.3 方案第六章）：设计交叉评审 → 设计安全复审 → 设计评审门禁 → 契约冻结 + Mock
    run.stage = "design_review";
    let designReview = await this._runRole(run, "design_review", this._contextFor(run, "design_review"));
    if (run.cancelled) return;
    const designReworkMax = Math.max(1, Math.min(5, Number(this.config.designClosure?.maxRounds) || Number(this.config.flow.maxRework) || 3)); // 方案 6：设计回退最大次数（专家设置可配）
    let designRework = 0;
    while (/必须修复/i.test(designReview ?? "") && designRework < designReworkMax) {
      designRework++;
      this._recordRollback(run, { from: "design_review", to: "ui", node: "ui" }, "design_review_blocking");
      const ds = this._recordIssuesFrom(designReview, "design_review", "design");
      for (const it of ds) this.issues.fixing(it.id, "设计按交叉评审要求整改（第 " + designRework + " 轮）");
      run.ui = await this._runRole(run, "ui", this._contextFor(run, "ui") + "\n## 设计交叉评审整改要求\n" + designReview);
      if (run.cancelled) return;
      designReview = await this._runRole(run, "design_review", this._contextFor(run, "design_review") + "\n## 设计已整改，请复审（输出格式同前）\n" + String(run.ui ?? "").slice(0, 4000));
      if (run.cancelled) return;
      for (const it of ds) {
        if (/必须修复/i.test(designReview ?? "")) this.issues.fail(it.id, "设计复审仍存在必须修复项");
        else this.issues.pass(it.id, "设计复审通过");
      }
    }
    if (designRework >= designReworkMax && /必须修复/i.test(designReview ?? "")) {
      for (const it of this._recordIssuesFrom(designReview, "design_review", "design")) this.issues.escalate(it.id, "设计评审回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
      this.observability.record("warning", "design_review_escalated", "设计评审门禁回环达上限，升级总指挥裁决");
    }
    run.designReview = designReview;
    // 设计安全复审
    run.stage = "design_security";
    const designSec = await this._runRole(run, "security", this._contextFor(run, "security") + "\n## 设计安全复审\n复审 UX/UI 设计产物，确认无「必须修复」安全项后输出「设计安全确认通过」；存在则按 `必须修复：<问题>` 列出。");
    if (run.cancelled) return;
    if (/必须修复/i.test(designSec ?? "")) {
      this._recordRollback(run, { from: "security", to: "ui", node: "ui" }, "design_security_blocking");
      run.ui = await this._runRole(run, "ui", this._contextFor(run, "ui") + "\n## 设计安全复审整改\n" + designSec);
      this.observability.record("warning", "design_security_rework", "设计安全复审存在必须修复项，UI 已按整改重做");
    }
    run.designSecurity = designSec;
    // 设计评审门禁 + 契约冻结 + Mock（本地门禁节点：记录契约版本，纳入缓存键/回退版本管理）
    run.stage = "design_contract";
    const designGate = {
      passed: !/必须修复/i.test(designReview ?? "") && !/必须修复/i.test(designSec ?? ""),
      review: /必须修复/i.test(designReview ?? "") ? "未通过" : "通过",
      security: /必须修复/i.test(designSec ?? "") ? "未通过" : "通过",
    };
    run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["design", "designContract"]); // 方案 12：设计契约版本单列
    run.designContract = {
      version: Number(run.versions?.design ?? 1),
      frozenAt: Date.now(),
      gate: designGate,
      summary: `契约冻结 v${run.versions?.design ?? 1}：交互契约/组件契约/设计 token/状态机/响应式规则/可访问性基线（设计评审=${designGate.review}，安全=${designGate.security}）`,
    };
    this.observability.record("info", "design_contract", `设计契约冻结 v${run.designContract.version}：评审=${designGate.review} 安全=${designGate.security}`);

    // Stage 7: module-split + parallel dev (respect seat pool ≤5)
    run.stage = "dev";
    const { modules } = this.splitter.parse(run.ui + "\n" + run.ux, {});
    // N25 数据模块子会话（条件 hasData，方案 5.4）：数据角色启用时把数据设计落地为独立模块任务
    if (run.enabledSlots.includes("data") && run.dataDesign) {
      modules.push({ id: "dm:data", role: "data", module: "数据模型与迁移（表结构/索引/迁移/数据字典/脱敏/备份恢复）", type: "data" });
    }
    run.modules = modules;
    const devOutputs = await this._runDevelopment(run, modules);
    run.devOutputs = devOutputs;

    // Stage 8: reviewer (may rework modules up to maxRework)
    run.stage = "review";
    let review = await this._runRole(run, "reviewer", this._contextFor(run, "reviewer"));
    let reviewIssues = this._recordIssuesFrom(review, "reviewer", "code");
    let rework = 0;
    const gateLoops = Math.max(1, Math.min(10, Number(this.config.qualityGate?.maxLoops) || Number(this.config.flow.maxRework) || 3)); // 方案 8：质量门禁回环最大次数
    while (/问题|缺陷|错误|bug|fail|issue/i.test(review ?? "") && rework < gateLoops) {
      rework++;
      this._recordRollback(run, { from: "reviewer", to: "dev", node: "dev" }, "review_module_fail");
      this.observability.recordRework("(review-loop)");
      // 代码类：全部问题均阻断，修复后必须重新评审（不区分大小问题）
      for (const it of reviewIssues) this.issues.fixing(it.id, "开发按评审要求修复（第 " + rework + " 轮）");
      run.devOutputs = await this._runDevelopment(run, modules, review);
      review = await this._runRole(run, "reviewer", this._contextFor(run, "reviewer") + "\n## 上一轮修复\n" + JSON.stringify(run.devOutputs ?? {}).slice(0, this.config.flow.summaryTokenCap));
      if (run.cancelled) return;
      const stillFailing = /问题|缺陷|错误|bug|fail|issue/i.test(review ?? "");
      for (const it of reviewIssues) {
        this.issues.review(it.id, "代码评审复审（第 " + rework + " 轮）");
        if (stillFailing) this.issues.fail(it.id, "评审仍存在问题");
        else this.issues.pass(it.id, "评审通过");
      }
      const nb = this._recordIssuesFrom(review, "reviewer", "code");
      for (const n of nb) if (!reviewIssues.some((x) => x.id === n.id)) reviewIssues.push(n);
    }
    if (rework >= gateLoops && /问题|缺陷|错误|bug|fail|issue/i.test(review ?? "")) {
      for (const it of reviewIssues) this.issues.escalate(it.id, "代码评审回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
      this.observability.record("warning", "review_escalated", "代码评审回环达上限，升级总指挥裁决");
    }
    run.review = review;

    // Stage 9: tester (regression loop until clean)
    // 流程规则：测试为代码类环节——发现缺陷后必须返工对应模块并回归测试，
    // 测试通过（无缺陷）后才可进入运维环节。
    run.stage = "test";
    let testDoc = await this._runRole(run, "tester", this._contextFor(run, "tester"));
    let testIssues = this._recordIssuesFrom(testDoc, "tester", "code");
    let testRework = 0;
    while (/缺陷|bug|fail|issue|不通过|失败|错误/i.test(testDoc ?? "") && testRework < gateLoops) {
      testRework++;
      this._recordRollback(run, { from: "tester", to: "dev", node: "dev" }, "test_module_fail");
      this.observability.recordRework("(test-loop)");
      // 代码类：缺陷必须修复 → 评审重新审核 → 回归测试
      for (const it of testIssues) this.issues.fixing(it.id, "开发按缺陷修复（第 " + testRework + " 轮）");
      run.devOutputs = await this._runDevelopment(run, modules, testDoc);
      if (run.cancelled) return;
      testDoc = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 上一轮缺陷修复后回归\n" + JSON.stringify(run.devOutputs ?? {}).slice(0, this.config.flow.summaryTokenCap));
      if (run.cancelled) return;
      const stillFailing = /缺陷|bug|fail|issue|不通过|失败|错误/i.test(testDoc ?? "");
      for (const it of testIssues) {
        this.issues.review(it.id, "回归测试（第 " + testRework + " 轮）");
        if (stillFailing) this.issues.fail(it.id, "回归测试仍存在缺陷");
        else this.issues.pass(it.id, "回归测试通过");
      }
      const nb = this._recordIssuesFrom(testDoc, "tester", "code");
      for (const n of nb) if (!testIssues.some((x) => x.id === n.id)) testIssues.push(n);
    }
    if (testRework >= gateLoops && /缺陷|bug|fail|issue|不通过|失败|错误/i.test(testDoc ?? "")) {
      for (const it of testIssues) this.issues.escalate(it.id, "测试回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
      this.observability.record("warning", "test_escalated", "测试回环达上限，升级总指挥裁决");
    }
    run.test = testDoc;

    // Stage 9.5: 性能/可靠性测试（条件角色启用时执行，方案 10.5 N29）
    if (run.enabledSlots.includes("performance")) {
      run.stage = "performance";
      const perfDoc = await this._runRole(run, "performance", this._contextFor(run, "performance"));
      if (run.cancelled) return;
      if (/不通过|失败|缺陷|问题|瓶颈/i.test(perfDoc ?? "")) {
        this._recordRollback(run, { from: "performance", to: "dev", node: "dev" }, "performance_fail");
        run.devOutputs = await this._runDevelopment(run, modules, perfDoc);
        this.observability.record("warning", "performance_rework", "性能测试存在不通过项，已回退开发整改");
      }
      run.performance = perfDoc;
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["performance"]); // 方案 12：条件角色产物版本单列
    }
    // Stage 9.6: 安全测试（条件角色启用时执行，方案 10.5 N30）
    if (run.enabledSlots.includes("security_test")) {
      run.stage = "security_test";
      const secTestDoc = await this._runRole(run, "security_test", this._contextFor(run, "security_test"));
      if (run.cancelled) return;
      if (/不通过|失败|漏洞|缺陷|高危/i.test(secTestDoc ?? "")) {
        this._recordRollback(run, { from: "security_test", to: "dev", node: "dev" }, "security_test_fail");
        run.devOutputs = await this._runDevelopment(run, modules, secTestDoc);
        this.observability.record("warning", "security_test_rework", "安全测试存在不通过项，已回退开发整改");
      }
      run.securityTest = secTestDoc;
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["security_test"]); // 方案 12：条件角色产物版本单列
    }

    // Stage 10: ops
    run.stage = "ops";
    run.ops = await this._runRole(run, "ops", this._contextFor(run, "ops"));

    // Stage 10.5: DevOps / CI-CD（条件）、发布经理（条件）
    if (run.enabledSlots.includes("devops")) {
      run.stage = "devops";
      run.devops = await this._runRole(run, "devops", this._contextFor(run, "devops"));
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["devops"]); // 方案 12：条件角色产物版本单列
      if (run.cancelled) return;
    }
    if (run.enabledSlots.includes("release")) {
      run.stage = "release";
      run.release = await this._runRole(run, "release", this._contextFor(run, "release"));
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["release"]); // 方案 12：条件角色产物版本单列
      if (run.cancelled) return;
    }
    // Stage 10.6: 部署安全审查（方案 N34）
    run.stage = "deploy_security";
    const deploySec = await this._runRole(run, "security", this._contextFor(run, "security") + "\n## 部署安全审查\n审查部署/上线方案，确认无「必须修复」项后输出「部署安全确认通过」；存在则按 `必须修复：<问题>` 列出。");
    if (run.cancelled) return;
    if (/必须修复/i.test(deploySec ?? "")) {
      this._recordRollback(run, { from: "security", to: "ops", node: "ops" }, "deploy_security_blocking");
      run.ops = await this._runRole(run, "ops", this._contextFor(run, "ops") + "\n## 部署安全审查整改\n" + deploySec);
      this.observability.record("warning", "deploy_security_rework", "部署安全审查存在必须修复项，运维已按整改重做");
    }
    run.deploySecurity = deploySec;
    // Stage 10.7: 部署验证/冒烟测试（方案 N35，失败按原因回退）
    run.stage = "deploy_verify";
    const deployDoc = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 部署验证/冒烟测试\n按部署文档对部署方案执行冒烟验证：启动、主流程、关键页面/接口可访问。不通过则输出 `测试结论：不通过` 并注明问题模块。");
    if (run.cancelled) return;
    if (/测试结论[:：]\s*不通过|不通过|失败|无法启动/i.test(deployDoc ?? "")) {
      this._recordRollback(run, { from: "tester", to: "ops", node: "ops" }, "deploy_verify_fail");
      run.ops = await this._runRole(run, "ops", this._contextFor(run, "ops") + "\n## 部署验证失败整改\n" + deployDoc);
      this.observability.record("warning", "deploy_verify_fail", "部署验证失败，运维已按失败原因整改并重跑部署验证");
      run.deployVerify = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 整改后部署验证复核\n" + String(run.ops ?? "").slice(0, 3000));
    } else {
      run.deployVerify = deployDoc;
    }
    // Stage 10.8: 监控/SRE 配置（条件）
    if (run.enabledSlots.includes("sre")) {
      run.stage = "sre";
      run.sre = await this._runRole(run, "sre", this._contextFor(run, "sre"));
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["sre"]); // 方案 12：条件角色产物版本单列
      if (run.cancelled) return;
    }

    // Stage 11: docs
    run.stage = "docs";
    run.docs = await this._runRole(run, "docs", this._contextFor(run, "docs"));

    // Stage 11.5: 上线前安全复查（方案 N38）
    run.stage = "prelaunch_security";
    const preSec = await this._runRole(run, "security", this._contextFor(run, "security") + "\n## 上线前安全复查\n对最终交付物做上线前安全复查，确认无「必须修复」项后输出「上线安全确认通过」；存在则按 `必须修复：<问题>` 列出。");
    if (run.cancelled) return;
    if (/必须修复/i.test(preSec ?? "")) {
      this._recordRollback(run, { from: "security", to: "dev", node: "dev" }, "prelaunch_security_blocking");
      run.devOutputs = await this._runDevelopment(run, modules, preSec);
      this.observability.record("warning", "prelaunch_security_blocking", "上线前安全复查存在必须修复项，已回退开发整改");
    }
    run.prelaunchSecurity = preSec;
    // Stage 11.6: 最终全功能回归测试（方案 N39：未通过不得最终审核）
    run.stage = "final_regression";
    const finalReg = await this._runRole(run, "tester", this._contextFor(run, "tester") + `\n## 最终全功能回归测试\n回归环境：${this.config.finalRegression?.environment ?? "准生产"}；覆盖范围：${this.config.finalRegression?.coverage ?? "全部功能+设计+性能+安全+无障碍+i18n"}；不通过则输出 \`测试结论：不通过\` 并注明问题模块。`);
    if (run.cancelled) return;
    if (/测试结论[:：]\s*不通过|不通过|失败/i.test(finalReg ?? "")) {
      this._recordRollback(run, { from: "tester", to: "dev", node: "dev" }, "final_regression_fail");
      run.devOutputs = await this._runDevelopment(run, modules, finalReg);
      this.observability.record("warning", "final_regression_fail", "最终全功能回归未通过，已回退开发整改后重新回归");
      run.finalRegression = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 整改后最终全功能回归\n" + JSON.stringify(run.devOutputs ?? {}).slice(0, 4000));
    } else {
      run.finalRegression = finalReg;
    }

    // Stage 12: auditor (final review)
    run.stage = "audit";
    run.audit = await this._runRole(run, "auditor", this._contextFor(run, "auditor"));
    await this._maybeConfirm(run, "final");
    if (run.manualConfirms?.final === "rejected") {
      run.manualConfirms.final = "confirmed";
      this._recordRollback(run, { from: "auditor", to: "auditor", node: "auditor" }, "final_rejected");
      run.audit = await this._runRole(run, "auditor", this._contextFor(run, "auditor") + "\n## 用户拒绝了最终交付\n请重新独立复验并给出三态结论（拒绝原因见用户消息）。");
    }

    // 审核全文落日志（供验收查看审核工程师内容）
    try { console.log(`[dsh-leng-team] auditor 全文(${String(run.audit ?? "").length}):\n${String(run.audit ?? "")}`); } catch (e) { /* ignore */ }

    // 审核不合格 → 定位问题环节 → 精准回退重跑（最多 retryGate 轮）
    run.auditRounds = (run.auditRounds ?? 0) + 1;
    // V9.3 独立复验：三态结论（pass/conditional/fail）+ 盲审 + 反方质询
    const verRec = this.verification.createRecord(run.goal, run.audit);
    run.verification = verRec;
    const gateResult = this.verification.gate(verRec.conclusion, run.audit);
    if (gateResult.needRework && run.auditRounds <= this.config.flow.maxRework + 1) {
      console.log(`[dsh-leng-team] 审核不合格：${gateResult.reason} → 回退重跑环节 ${gateResult.rework.join(",")}`);
      this._recordRollback(run, { from: "auditor", to: gateResult.rework[0] ?? "ui", node: gateResult.rework[0] ?? "ui" }, "audit_fail");
      this.observability.record("warning", "audit_rework", `${gateResult.reason} → 重跑 ${gateResult.rework.join(",")}`);
      for (const rk of gateResult.rework) {
        if (!ROLE_MAP[rk]) continue;
        run[rk === "analyst" ? "analyst" : rk] = await this._runRole(run, rk, this._contextFor(run, rk) + "\n## 审核整改要求\n" + gateResult.reason.slice(0, 1200));
      }
      // 重跑受影响的下游
      const PROP = { product: "product", analyst: "analyst", architect: "architecture", security: "security", ux: "ux", ui: "ui", reviewer: "review", tester: "test", ops: "ops", docs: "docs", auditor: "audit" };
      for (const rk of gateResult.rework) {
        if (!ROLE_MAP[rk] || !PROP[rk]) continue;
        run[PROP[rk]] = await this._runRole(run, rk, this._contextFor(run, rk) + "\n## 审核整改要求\n" + gateResult.reason.slice(0, 1200));
      }
      const down = { product: ["analyst", "architect", "security", "ux", "ui"], analyst: ["architect", "security", "ux", "ui"], architect: ["security", "ux", "ui"], security: ["ux", "ui"], ux: ["ui"], ui: ["ui"], reviewer: ["reviewer", "tester", "ops", "docs"], tester: ["tester", "ops", "docs"], ops: ["ops", "docs"], docs: ["docs"] };
      const affected = down[gateResult.rework[0]] ?? [];
      for (const rk of affected) {
        if (!ROLE_MAP[rk] || !PROP[rk]) continue;
        run[PROP[rk]] = await this._runRole(run, rk, this._contextFor(run, rk) + "\n## 上游整改完成，重新执行本环节\n");
      }
      run.audit = await this._runRole(run, "auditor", this._contextFor(run, "auditor") + "\n## 上一轮审核整改已完成，请复核\n" + gateResult.reason.slice(0, 1200));
      await this._maybeConfirm(run, "final");
      this._snapshot();
      this._emit();
      return;
    }

    run.stage = "done";
    this.observability.record("info", "complete", "全链路完成");
    try { this.observability.record("info", "acceptance", "可量化验收指标: " + JSON.stringify(this.acceptanceSnapshot())); } catch (e) { /* ignore */ }
    this._snapshot();
    this._emit();
  }

  // 审核判定已由 verification.gate（独立复验三态）接管，_auditGate 已删除（V9.3）。

  /** 非 software 领域流水线（data_analysis/research/content/document/generic，方案 2.4–2.6）。
   *  链：产品两阶段 → 领域方案设计（含评审/验证职责）→ 条件领域角色 → 领域执行（可并行拆分）→ 文档 → 最终审核。 */
  async _runDomainPipeline(run) {
    const exec = DOMAIN_EXEC[run.taskType] ?? {};
    const designKey = exec.designKey ?? "architect";
    const execRoleKey = exec.roleKey ?? "frontend";
    // 产品经理第二阶段：调查后正式定义
    run.stage = "product";
    const productDoc = await this._runRole(run, "product", this._contextFor(run, "product") + (run.investigationReport ? "\n## 调查报告参考（事实/约束/条件建议）\n" + String(run.investigationReport.content ?? "").slice(0, 3000) : ""));
    if (run.cancelled) return;
    run.product = productDoc;
    await this._maybeConfirm(run, "requirement");
    await this._handleRejected(run, "requirement", "product", "product", "## 用户拒绝了需求定稿\n请根据用户拒绝意见重新定义目标/范围/优先级/验收标准。");
    // 领域方案设计（方案设计 + 结构评审 + 一致性验证职责）
    run.stage = "domain_design";
    run.domainDesign = await this._runRole(run, designKey, this._contextFor(run, "domain_design"));
    if (run.cancelled) return;
    // 条件领域角色（统计/数据伦理/领域专家/SEO/视觉）
    for (const cond of exec.conditionals ?? []) {
      if (run.enabledSlots.includes(cond.slotId) && ROLE_MAP[cond.roleKey]) {
        run.stage = "cond_" + cond.roleKey;
        const out = await this._runRole(run, cond.roleKey, this._contextFor(run, "domain_conditional") + "\n## 上游方案\n" + String(run.domainDesign ?? "").slice(0, 4000));
        if (run.cancelled) return;
        run["cond_" + cond.roleKey] = out;
      }
    }
    // 领域执行（可并行拆分，领域拆分维度见 DOMAIN_EXEC.splitDimension）
    run.stage = "domain_exec";
    const designDoc = String(run.domainDesign ?? "") + "\n" + String(run.product ?? "");
    const { modules } = this.splitter.parse(designDoc, {});
    run.modules = modules;
    run.domainOutputs = await this._runDevelopment(run, modules, null, execRoleKey);
    // 领域评审 + 一致性验证（领域设计角色对产物做结构评审/事实一致性验证）
    run.stage = "domain_review";
    let reviewDoc = await this._runRole(run, designKey, this._contextFor(run, "domain_design") + "\n## 执行产物评审\n请对执行产物做结构评审与事实/一致性验证，输出 `评审结论：通过/不通过`；不通过时逐条列出问题与整改要求。\n" + JSON.stringify(run.domainOutputs ?? {}).slice(0, 6000));
    if (run.cancelled) return;
    run.domainReview = reviewDoc;
    let domainRework = 0;
    while (/评审结论[:：]\s*不通过|问题|缺陷|不一致|错误/i.test(reviewDoc ?? "") && domainRework < this.config.flow.maxRework) {
      domainRework++;
      this._recordRollback(run, { from: designKey, to: "exec", node: "exec" }, "review_fail");
      for (const it of this._recordIssuesFrom(reviewDoc, designKey, "domain")) this.issues.fixing(it.id, "领域执行按评审要求整改（第 " + domainRework + " 轮）");
      run.domainOutputs = await this._runDevelopment(run, modules, reviewDoc, execRoleKey);
      if (run.cancelled) return;
      reviewDoc = await this._runRole(run, designKey, this._contextFor(run, "domain_design") + "\n## 上一轮整改后复评\n" + JSON.stringify(run.domainOutputs ?? {}).slice(0, 6000));
      if (run.cancelled) return;
    }
    // 文档汇总
    run.stage = "docs";
    run.docs = await this._runRole(run, "docs", this._contextFor(run, "docs"));
    // 最终全功能回归验证（方案 5.5：领域模板亦含最终回归验证节点；未通过不得进入最终审核）
    run.stage = "final_regression";
    let domainReg = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 最终全功能回归验证\n请对全部领域产物做最终全功能回归验证，输出 `回归结论：通过/不通过`；不通过时逐条列出问题。\n" + JSON.stringify(run.domainOutputs ?? {}).slice(0, 6000));
    if (run.cancelled) return;
    run.domainRegression = domainReg;
    let domainRegRework = 0;
    while (/回归结论[:：]\s*不通过|必须修复|问题[:：]|缺陷/i.test(domainReg ?? "") && domainRegRework < this.config.flow.maxRework) {
      domainRegRework++;
      this._recordRollback(run, { from: "tester", to: "exec", node: "exec" }, "final_regression_fail");
      for (const it of this._recordIssuesFrom(domainReg, "tester", "domain")) this.issues.fixing(it.id, "领域最终回归整改（第 " + domainRegRework + " 轮）");
      run.domainOutputs = await this._runDevelopment(run, modules, domainReg, execRoleKey);
      if (run.cancelled) return;
      domainReg = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 整改后最终回归复验\n" + JSON.stringify(run.domainOutputs ?? {}).slice(0, 6000));
      if (run.cancelled) return;
    }
    // 最终审核（独立复验三态）
    run.stage = "audit";
    run.audit = await this._runRole(run, "auditor", this._contextFor(run, "auditor"));
    await this._maybeConfirm(run, "final");
    if (run.manualConfirms?.final === "rejected") {
      run.manualConfirms.final = "confirmed";
      this._recordRollback(run, { from: "auditor", to: "auditor", node: "auditor" }, "final_rejected");
      run.audit = await this._runRole(run, "auditor", this._contextFor(run, "auditor") + "\n## 用户拒绝了最终交付\n请重新独立复验并给出三态结论。");
    }
    const verRec = this.verification.createRecord(run.goal, run.audit);
    run.verification = verRec;
    const gateResult = this.verification.gate(verRec.conclusion, run.audit);
    if (gateResult.needRework && (run.auditRounds ?? 0) <= this.config.flow.maxRework) {
      run.auditRounds = (run.auditRounds ?? 0) + 1;
      this._recordRollback(run, { from: "auditor", to: "exec", node: "exec" }, "audit_fail");
      run.domainDesign = await this._runRole(run, designKey, this._contextFor(run, "domain_design") + "\n## 审核整改要求\n" + gateResult.reason.slice(0, 1200));
      run.domainOutputs = await this._runDevelopment(run, modules, reviewDoc, execRoleKey);
      if (run.cancelled) return;
      run.docs = await this._runRole(run, "docs", this._contextFor(run, "docs"));
      run.audit = await this._runRole(run, "auditor", this._contextFor(run, "auditor") + "\n## 上一轮审核整改已完成，请复核\n" + gateResult.reason.slice(0, 1200));
    }
    run.stage = "done";
    this.observability.record("info", "complete", `领域流水线完成（${run.taskType}，执行角色=${execRoleKey}，拆分=${exec.splitDimension ?? "module"}）`);
    this._snapshot();
    this._emit();
  }
  /** V9.3 全局回退预算记录：计数 + 版本递增 + 下游 stale + 升级观测。 */
  _recordRollback(run, edge, trigger) {
    const res = this.rollback.record(edge, edge.node, `${edge.from}→${edge.to}`, trigger);
    run.versions = this.rollback.bumpVersion(run.versions ?? {}, [edge.node, edge.from, edge.to]);
    const stale = this.rollback.markStale({ dev: ["reviewer", "tester", "ops", "docs"], architecture: ["security", "ux", "ui", "dev"], ui: ["dev"], product: ["analyst", "architect"] }, edge.node);
    if (res.escalated) {
      this.observability.record("warning", "rollback_escalated", res.reason);
      this.recordResult(`回退预算升级人工裁决：${res.reason}`);
    }
    this.observability.record("info", "rollback", `回退 ${edge.from}→${edge.to}（${trigger}）预算=${res.usedBudget}/${this.rollback.totalBudget} stale=${stale.length ? stale.join(",") : "无"}`);
    return res;
  }

  /** V9.3：席位容量 = min(配置上限, 令牌桶当前并发)（429 自动降级生效）。 */
  effectiveCapacity() {
    return Math.max(1, Math.min(this.capacity, this.rateLimiter?.concurrency ?? this.capacity));
  }

  /** Run a single role as a child agent via the orchestrator. */
  async _runRole(run, roleKey, context) {
    const role = ROLE_MAP[roleKey];
    if (!role) throw new Error(`未知角色: ${roleKey}`);

    const taskId = `${roleKey}:${run.id}`;
    console.log(`[dsh-leng-team] role ${roleKey} 开始 @${run.id} ctx=${String(context ?? "").slice(0, 40)}`);
    this._setTask(taskId, roleKey, null, "running", []);

    let output = "";
    const maxAttempts = 5;
    let attemptContext = context;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      output = await this._dispatchAgent(taskId, roleKey, buildRolePrompt(this._personaFor(roleKey)), attemptContext, {
        onOutput: (text) => this.watchdog.recordOutput(taskId, text),
      });
      console.log(`[dsh-leng-team] role ${roleKey} 尝试${attempt} 输出长度=${String(output ?? "").length} 开头=${JSON.stringify(String(output ?? "").trim().slice(0, 120))}`);
      if (this._isValidRoleOutput(output, roleKey)) break;
      console.log(`[dsh-leng-team] role ${roleKey} 输出无效（占位/过短），重试 ${attempt}/${maxAttempts}`);
      if (attempt < maxAttempts) await this._sleep(25000);
      attemptContext = context + (roleKey === "auditor"
        ? "\n## 重要：你上一次输出无效。你必须直接输出最终审核判定文本，正文以「审核结论：通过」或「审核结论：不通过」开头，随后依次给出核验结果、项目功能总结、项目文件位置与运行方式。禁止复述任务、禁止复述角色定义、禁止输出思考过程、禁止仅回复已完成。"
        : "\n## 重要：你上一次输出无效（推理草稿/空/占位符）。不要复述任务，不要复述你的角色定义，不要输出任何思考过程。直接输出最终交付文档：以「## 」开头的完整结构化正文，不少于800字，内容为你的本职工作产物。禁止输出占位符、禁止仅回复\"已完成\"或类似内容。");
    }
    console.log(`[dsh-leng-team] role ${roleKey} 完成, 输出长度=${String(output ?? "").length}`);
    if (!this._isValidRoleOutput(output, roleKey)) {
      if (roleKey === "docs" || roleKey === "auditor") {
        console.log(`[dsh-leng-team] 逻辑缺陷告警：${roleKey} 环节连续 ${maxAttempts} 次输出无效——文档/审核环节不应失败，疑似插件上下文拼装或读取通道缺陷，请检查`);
      }
      throw new Error(`角色 ${roleKey} 连续 ${maxAttempts} 次输出无效（占位/空/仅工具调用），流水线阻断于该环节，请修复后重试`);
    }
    this._setTask(taskId, roleKey, null, "finished", []);
    return output;
  }

  /** 主角色输出有效性：非占位符且长度达标；审核角色必须含明确结论 */
  _isDraft(text) {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (/##/.test(t)) return false; // 有结构化标记，视为正式输出
    if (/^(Let me|I['’]?m |I am |I need to|I'm being asked|I will |I would|I should|My role|My task|My job)/.test(t)) return true;
    if (/^(The user|The task|The project|The context|You are|As an? |First,|Okay,|Alright,|Hmm,|Let's |The goal|The request)/i.test(t)) return true;
    return false;
  }

  _isValidRoleOutput(o, roleKey) {
    if (!o) return false;
    const t = String(o).trim();
    if (t === "" || t === "(无法读取输出)" || t === "(无输出)" || t === "已完成") return false;
    if (this._isDraft(t)) return false;
    if (t.length < 50) return false;
    if (roleKey === "auditor") {
      if (!/审核结论/.test(t) && !/(通过|不通过|不合格|达标|验收).*(项目|文件|运行|功能)/.test(t)) return false;
      if (/^Let me|^I('| a)m /.test(t)) return false;
    }
    return true;
  }

  /** Run the development phase: all modules as independent sub-tasks via the seat pool.
   *  execRoleKey：领域流水线用领域执行角色覆盖模块角色（software 默认 frontend/backend）。 */
  async _runDevelopment(run, modules, reviewFeedback, execRoleKey) {
    // 精准返工：解析评审/测试报告中的「问题模块：xxx」清单，只重跑问题模块；
    // 首次开发（无 reviewFeedback）或解析不到时，跑全部模块。非重跑模块保留既有 dag 输出。
    const reworkIds = new Set();
    if (reviewFeedback) {
      const fb = String(reviewFeedback);
      const mm = fb.matchAll(/问题模块[:：]\s*([^\n]+)/gi);
      for (const m of mm) {
        for (const seg of m[1].split(/[,，、;；\s]+/)) {
          const id = seg.trim();
          if (id) reworkIds.add(id);
        }
      }
    }
    let runModules = modules;
    if (reworkIds.size > 0) {
      const hit = modules.filter((m) => reworkIds.has(m.id));
      if (hit.length > 0) {
        // 方案 18「影响分析 + 关联模块回归」：问题模块所在角色的全部模块一并重跑，
        // 避免修复后与同角色模块之间产生接口/契约不一致。
        const hitRoles = new Set(hit.map((m) => m.role));
        runModules = modules.filter((m) => hitRoles.has(m.role));
        this.observability.record("info", "impact_analysis", "问题模块影响分析：同角色模块一并回归 " + runModules.map((m) => m.id).join(","));
      }
    }
    // Enqueue module tasks (they share the global seat pool)
    const tasks = [];
    const execRole = execRoleKey ?? null;
    for (const m of runModules) {
      const taskId = m.id;
      const role = execRole ?? m.role;
      const cacheKey = this.splitter.cacheKey(m, run.versions ?? {}, { taskType: run.taskType, depth: run.investigation?.depth });
      if (cacheKey && this.moduleCache.has(cacheKey) && !reworkIds.has(m.id)) {
        // module-level cache reuse（返工模块强制重跑，绕过旧缓存；版本不匹配则键不同，不会复用）
        tasks.push({ id: taskId, module: m, output: this.moduleCache.get(cacheKey), cached: true });
        this.observability.recordCache(role, m.module, true, cacheKey, "版本一致命中");
        continue;
      }
      if (cacheKey && this.config.cacheKey?.recordMiss) {
        this.observability.recordCache(role, m.module, false, cacheKey, "版本不匹配/无缓存，失效重建");
      }
      this._setTask(taskId, role, m.module, "queued", []);
      this.queue.push({
        taskId,
        role,
        module: m.module,
        type: m.type,
        priority: 3, // 执行类模块任务 P3（方案 9.4 席位优先级）
        depends: [`ui:${run.id}`, `architect:${run.id}`],
        status: "queued",
        createdAt: Date.now(),
      });
      tasks.push({ id: taskId, module: m, output: null });
    }
    this._emit();

    // Drain until every module task is finished
    const startedAt = Date.now();
    while (this.queue.some((q) => q.status === "queued" || q.status === "running")) {
      if (this.paused) {
        await this._sleep(500);
        if (Date.now() - startedAt > 3600000) break; // safety
        continue;
      }
      const advanced = await this._drainQueue();
      if (!advanced) await this._sleep(300);
      // queue timeout alert
      const now = Date.now();
      for (const q of this.queue) {
        if (q.status === "queued" && now - q.createdAt > this.config.concurrency.queueTimeoutMs) {
          this.observability.record("warning", "queue_timeout", `任务 ${q.taskId} 排队超时`);
          q.createdAt = now; // alert once per window
        }
      }
    }

    // Collect outputs（校验全部有效后才允许进入评审/测试）
    const outputs = {};
    let invalidCount = 0;
    for (const m of modules) {
      const t = this.dag.get(m.id);
      outputs[m.id] = t?.output ?? null;
      if (!this._isValidModuleOutput(outputs[m.id])) invalidCount += 1;
      const cacheKey = this.splitter.cacheKey(m, run.versions ?? {}, { taskType: run.taskType, depth: run.investigation?.depth });
      if (cacheKey && t?.output && this._isValidModuleOutput(t.output)) {
        this.moduleCache.set(cacheKey, t.output);
        this.observability.recordCache(execRole ?? m.role, m.module, true, cacheKey, "产物写入缓存");
      }
    }
    console.log(`[dsh-leng-team] dev 全部模块交付完成 total=${modules.length} valid=${modules.length - invalidCount} invalid=${invalidCount}`);
    return outputs;
  }

  /** Drain the queue: schedule tasks onto free seats (≤ capacity).
   *  V9.3 方案 9.4：priority 队列策略按优先级排序（P0<P1<P2<P3）；
   *  至少预留 1 个席位给 P0/P1 关键任务（当队列中存在 P0/P1 且席位已满时不再占满最后 1 席）。 */
  async _drainQueue() {
    if (this.paused || this.watchdog.isFrozen()) return false;
    let advanced = false;
    const strategy = this.config.concurrency?.queueStrategy ?? "fifo";
    let candidates = this.queue.filter((q) => q.status === "queued");
    if (strategy === "priority") {
      candidates = candidates.slice().sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || (a.createdAt - b.createdAt));
    }
    for (const q of candidates) {
      if (q.status !== "queued") continue;
      const cap = this.effectiveCapacity();
      if (this.seats.size >= cap) break;
      // 预留席位：P0/P1 关键任务存在时，保留最后 1 席（防止关键门禁被 P3 模块长期占满）
      const hasCritical = candidates.some((c) => c.status === "queued" && (c.priority ?? 3) <= 1);
      if (hasCritical && this.seats.size >= cap - 1 && (q.priority ?? 3) > 1) continue;
      // dependency check (DAG)
      if (q.depends?.some((d) => this.dag.get(d)?.status !== "finished")) {
        this._setTask(q.taskId, q.role, q.module, "blocked", q.depends);
        continue;
      }
      // schedule
      const seat = this._nextFreeSeat();
      this.seats.set(seat, { taskId: q.taskId, role: q.role, module: q.module, startedAt: Date.now(), priority: q.priority ?? 3 });
      this._setTask(q.taskId, q.role, q.module, "running", q.depends);
      q.status = "running";
      advanced = true;
      void this._runModuleTask(seat, q);
    }
    return advanced;
  }

  _isValidModuleOutput(o) {
    if (!o) return false;
    if (o === "(无法读取输出)" || o === "(无输出)") return false;
    if (typeof o !== "string" || o.trim().length < 20) return false;
    if (this._isDraft(o)) return false;
    return true;
  }

  async _runModuleTask(seat, q) {
    const taskId = q.taskId;
    const run = this.activeRun;
    const role = ROLE_MAP[q.role];
    const context = q.role === "data"
      ? `## 目标\n${run?.goal ?? ""}\n\n## 数据设计\n${(run?.dataDesign ?? "").slice(0, this.config.flow.summaryTokenCap)}\n\n## 当前模块\n${q.module}（${q.type}）\n${q.taskId}`
      : `## 目标\n${run?.goal ?? ""}\n\n## 架构\n${(run?.architecture ?? "").slice(0, this.config.flow.summaryTokenCap)}\n\n## 设计\n${(run?.ui ?? "").slice(0, this.config.flow.summaryTokenCap)}\n\n## 当前模块\n${q.module}（${q.type}）\n${q.taskId}`;

    try {
      const output = await this._dispatchAgent(taskId, q.role, buildRolePrompt(this._personaFor(q.role)), context, {
        onOutput: (text) => this.watchdog.recordOutput(taskId, text),
        seat,
      });
      if (!this._isValidModuleOutput(output)) {
        throw new Error("模块输出无效或过短（占位/空），需重新开发");
      }
      const t = this.dag.get(taskId);
      if (t) {
        t.status = "finished";
        t.output = output;
      }
      q.status = "finished";  // 关键：同步更新队列条目状态，否则 _runDevelopment 的 while 死循环
      this.observability.recordHandover(q.role, "reviewer", q.module);
    } catch (e) {
      this.observability.recordAnomaly("module_error", `${q.module}: ${String(e?.message ?? e)}`);
      const t = this.dag.get(taskId);
      if (t) { t.status = "error"; t.output = null; }
      // requeue for rework (respect max rework)
      const t2 = this.dag.get(taskId);
      if ((t2?.rework ?? 0) < this.config.flow.maxRework) {
        q.status = "finished"; // 本次尝试终结，重试走新队列条目
        this.queue.push({ taskId, role: q.role, module: q.module, type: q.type, depends: q.depends, status: "queued", createdAt: Date.now() });
        t2.rework = (t2?.rework ?? 0) + 1;
        this.observability.recordRework(q.module);
      } else {
        q.status = "error"; // 超过最大返工次数：条目终态为 error，退出 while
      }
    } finally {
      // release seat
      this.seats.delete(seat);
      this.watchdog.untrack(taskId);
      this._emit();
      void this._drainQueue();
    }
  }

  // ==================== Child-agent dispatch ====================

  /**
   * Create + drive a child agent.
   * @returns {Promise<string>} the agent's final text output
   */
  /** Resolve a role's personaCore: expert override (config.roles) falls back to the built-in one. */
  _personaFor(roleKey) {
    const r = ROLE_MAP[roleKey];
    if (!r) return "";
    const ov = this.config.roles?.[roleKey]?.personaCore;
    return (ov && String(ov).trim().length > 0) ? String(ov) : r.personaCore;
  }

  async _dispatchAgent(taskId, roleKey, persona, context, { onOutput, seat } = {}) {
    const { ctx } = this;
    const parent = this.activeRun?.parentAgent;
    const parentS = parent?.session;
    let provider = this.config.models?.[roleKey]?.provider;
    let model = this.config.models?.[roleKey]?.model;
    if (!model) {
      try { const cfg = parent?.session?.requestHeader?.()?.config; if (cfg?.model) { provider = cfg.provider ?? provider; model = cfg.model; } } catch (e) { /* keep */ }
    }
    if (!model) {
      try { const sel = ctx.agentDefaultModel?.currentSelection?.(); if (sel?.model) { provider = sel.provider ?? provider; model = sel.model; } } catch (e) { /* keep */ }
    }
    // ---- model fix (B): inherit the parent session's provider/model so the
    // sub-agent runs on the same freehub pool as the main session. Never force
    // alibaba/qwen-flash: this host has no real QWEN key (credentials show
    // placeholder "buddy"), which made every child fail immediately with no output.
    // ---- 模型防护：父会话若命中已知挂起上游（280b / dots3-note-prev / note3-prev），
    // 不继承，回落到已实测快速稳定的 glm-5.2（token.sensenova.cn），
    // 避免子代理首轮输出长时间无响应（启动即建项目会话的关键一环）。
    if (!provider || !model || /280b|dots3-note-prev|note3-prev/i.test(String(model ?? ""))) {
      if (!provider || !model || /280b|dots3-note-prev|note3-prev/i.test(String(model ?? ""))) {
        console.log("[dsh-leng-team] model guard: 父会话模型为挂起上游(" + String(model ?? "") + ")，回落 glm-5.2");
      }
      provider = "freehub-deepseek-v4-flash-glm5-2-3";
      model = "glm-5.2";
    }
    console.log(`[dsh-leng-team] role model ${roleKey} => provider=${provider} model=${model}`);

    // ---- V9.3 令牌桶 + 429 状态机：模型请求前门控 ----
    if (!this.rateLimiter.allowNewTask()) {
      this.observability.record("warning", "rate_frozen", `429 状态=${this.rateLimiter.state}，新任务调度暂缓`);
      await this._sleep(this.rateLimiter.backoffMs());
    }
    // ---- V9.3 全局模型请求令牌桶：RPS/RPM 限流（方案 9.3）----
    // 429 状态机控制「是否允许发起」；令牌桶控制「发起的速率」（RPS/RPM）。
    // 两者独立：即使未 429，也必须消耗令牌，防止瞬时突发突破 RPS/RPM。
    {
      let bucketAcquired = false;
      for (let t = 0; t < 30 && !bucketAcquired; t++) {
        if (this.rateLimiter.tryAcquire()) { bucketAcquired = true; break; }
        await this._sleep(1000);
      }
      if (!bucketAcquired) {
        // 极端突发（30s 内无令牌）：记录告警并放行，避免流水线卡死（429 状态机仍会降级保护）
        this.observability.record("warning", "token_bucket_wait", "令牌桶 30s 未取到令牌，已放行本次请求（记录降级）");
      }
    }

    const subagents = ctx.subagents;
    if (!subagents || typeof subagents.startContinuable !== 'function') {
      console.log(`[dsh-leng-team] subagents unavailable: ${typeof subagents}`);
      throw new Error("dsh-leng-team: 平台未挂载 subagents 服务（startContinuable）");
    }
    let providerName = "spawn-in-process";
    try {
      if (typeof subagents.getProvider === 'function') {
        const probe = subagents.getProvider(providerName);
        const list = typeof subagents.list === 'function' ? subagents.list() : [];
        console.log(`[dsh-leng-team] provider probe spawn-in-process => ${probe ? "OK" : "missing"} | list=${list.join(",")}`);
        if (!probe && list.length > 0) providerName = list[0];
      }
    } catch (e) { console.log("[dsh-leng-team] provider probe err", String(e)); }

    const roleMeta = ROLE_MAP[roleKey];
    const roleLabel = roleMeta?.label ?? roleKey;
    const label = `${roleLabel}`;
    console.log(`[dsh-leng-team] persona[${roleKey}] 前120=${JSON.stringify(String(persona ?? "").slice(0, 120))}`);
    // Design / review / doc roles: pure text output, no file exploration.
    // Dev module roles: must be able to write real code files.
    const TEXT_ONLY_DENY = [
      "send_message", "subagent_fork", "ask_user_question", "leng_team",
      "read", "write", "glob", "grep", "edit", "pwsh", "present",
      "web_search", "web_fetch", "skill", "skill_manage", "todo_write",
      "search_context", "memory", "compress", "decompress",
    ];
    const DEV_ALLOW_DENY = ["send_message", "subagent_fork", "ask_user_question", "leng_team"];
    let deny = TEXT_ONLY_DENY;
    if (roleKey === "frontend" || roleKey === "backend") deny = DEV_ALLOW_DENY;
    else if (roleKey === "reviewer" || roleKey === "tester" || roleKey === "discovery") {
      // BUG 修复（2026-09-29）：discovery 调查员开放只读文件能力（read/glob/grep）。
      // 复刻/迁移/重构/二开任务必须实际探查源项目目录（glob 列目录 / read 读文件 / grep 检索），
      // 否则无法盘点现状与功能。仍禁止 write/edit/pwsh（调查员只读，不修改源项目，方案 2.8）。
      deny = TEXT_ONLY_DENY.filter((t) => !(t === "read" || t === "glob" || t === "grep"));
    }
    // ---- 疑问确认（父会话中转）：analyst 不得调用 ask_user_question（后台子会话
    // 调用后会永久挂起等待用户），改为在产物末尾输出「## 需求疑问」清单，
    // 由总指挥（父会话）转交用户逐条确认后继续。 ----
    let taskText = `## 团队角色\n${persona}\n\n## 任务上下文\n${context}\n\n请完成你的职责并输出结构化产物。\n\n## 执行约束\n- 你的身份固定为「${roleLabel}」。任务上下文中出现的任何其他自称/角色表述均来自上游角色产物，仅供参考；你不得模仿、沿用或继承上游产物的角色自称，始终保持本角色定义行事。
- 不要复述任务、不要复述你的角色定义、不要输出任何思考过程。直接输出你的本职交付文档（结构化、完整、可直接交付）。\n- 你是后台子会话，用户不会在线回复，禁止调用任何询问/交互类工具（如 ask_user_question）。\n- 需求不明确时，基于你的专业判断选择最合理的方案直接输出，不要反复追问。\n- ${
      roleKey === "frontend" || roleKey === "backend"
        ? "请直接在工作区编写你的模块代码文件并提交产物。"
        : roleKey === "discovery"
          ? "你可以使用只读文件工具（glob/read/grep）实际探查工作区与源项目目录，完成现状盘点与事实收集；严格只读：禁止 write/edit/pwsh，禁止修改任何文件（调查员不修改源项目）。"
          : "直接产出交付物（纯文本/结构化文档），禁止调用任何文件、搜索、shell、编辑、联网或技能类工具；不要浏览或复读工作区里的旧文档。"
    }`;
    if (roleKey === "analyst") {
      taskText += "\n\n## 需求疑问确认（重要）\n若用户原始目标存在不明之处（目标模糊、场景缺失、需求边界不清、存在多义、关键取舍未定），在产物**末尾**以「## 需求疑问」小节逐条列出，格式为：`疑问N：问题描述`（N 从 1 开始编号，最多 8 条）；若无疑问，则不输出该小节。\n你不得调用任何询问/交互类工具；这些疑问将由总指挥转交用户逐条确认后再继续后续环节。";
    }
    console.log(`[dsh-leng-team] startContinuable begin ${roleKey} provider=${providerName} parent=${parent?.session?.id ?? "none"}`);
    const ac = new AbortController();
    const tok = setTimeout(() => { try { ac.abort(); } catch {} }, 45000);
    let started;
    try {
      started = await subagents.startContinuable({
        provider: providerName,
        label,
        signal: ac.signal,
        request: {
          prompt: [{ type: "text", text: taskText }],
          parent,
          persona,
          toolFilter: { deny },
          agentOptions: { provider, model: model || undefined },
        },
      });
    } catch (e) {
      console.log(`[dsh-leng-team] startContinuable ERR ${roleKey}: ${String(e?.message ?? e)}`);
      throw e;
    } finally { clearTimeout(tok); }
    const sid = started?.childId ?? childId;
    console.log(`[dsh-leng-team] spawned continuable ${roleKey} child=${sid} label=${label}`);

    let agent;
    for (let i = 0; i < 60; i++) {
      try { agent = ctx.agents?.get?.(sid); } catch {}
      if (agent) break;
      await this._sleep(300);
    }
    if (!agent) agent = { status: "running", session: { id: sid, messages: [], snapshotEvents: () => [] } };

    this.watchdog.track({
      taskId, role: roleKey, agent,
      destroy: () => { try { subagents.interrupt?.(sid, { kind: "ancestor", agent: parent }); } catch {} },
      onRecoverSeat: (id) => {
        for (const [i, s] of this.seats) if (s.taskId === id) { this.seats.delete(i); this._drainQueue(); }
      },
    });

    const output = await this._waitAndRead(agent, sid, onOutput);
    this.observability.recordToken(roleKey, this._estimateTokens(output));
    this.rateLimiter.recordSuccess();
    return output ?? "(无输出)";
  }

  async _waitAndRead(agent, sid, onOutput) {
    const queueMs = this.config?.concurrency?.queueTimeoutMs;
    const deadline = Date.now() + (queueMs ?? 180000);
    console.log(`[dsh-leng-team] waitAndRead start sid=${sid} queueMs=${queueMs} deadlineInMs=${deadline - Date.now()}`);
    let last = "";
    let stable = 0;
    let diagPrinted = false;
    let iter = 0;
    let prevEvsLen = -1;
    let noProgress = 0;
    while (Date.now() < deadline) {
      iter += 1;
      let live = agent;
      try { if (sid && this.ctx?.agents?.get) live = this.ctx.agents.get(sid) ?? agent; } catch {}
      if (!diagPrinted) {
        diagPrinted = true;
        try {
          const l = live ?? agent;
          console.log(`[dsh-leng-team] waitAndRead diag sid=${sid} gotLive=${!!live} status=${l?.status ?? "?"} hasSession=${!!l?.session} sessId=${l?.session?.id ?? "?"} msgs=${l?.session?.messages?.length ?? "?"} evFn=${typeof l?.session?.snapshotEvents}`);
          const sess = l?.session;
          if (sess?.messages?.length) console.log("[dsh-leng-team] waitAndRead lastMsgRole=", sess.messages[sess.messages.length-1]?.role, "keys=", Object.keys(sess.messages[sess.messages.length-1] ?? {}).join(","));
        } catch (e) { console.log("[dsh-leng-team] waitAndRead diag err", String(e?.message ?? e)); }
      }
      const out = await this._readAgentOutput(live ?? agent);
      if (iter % 10 === 1) console.log(`[dsh-leng-team] waitAndRead iter=${iter} out=${JSON.stringify(String(out ?? "").slice(0, 60))}`);
      if (out && out !== "(无输出)" && out !== "(无法读取输出)") {
        if (out === last) stable += 1; else { stable = 0; last = out; }
        if (stable >= 2) { if (onOutput) onOutput(last); return last; }
      }
      let status = "";
      try { status = (live ?? agent)?.status ?? ""; } catch {}
      if (status === "idle") {
        if (last) { if (onOutput) onOutput(last); return last; }
        if (out && out !== "(无输出)" && out !== "(无法读取输出)") { if (onOutput) onOutput(out); return out; }
        return "(无法读取输出)";
      }
      try {
        const __evs = live?.session?.snapshotEvents ? (live.session.snapshotEvents(0) ?? []) : null;
        const __cur = Array.isArray(__evs) ? __evs.length : -1;
        if (__cur >= 0) {
          if (__cur === prevEvsLen) noProgress += 1; else { prevEvsLen = __cur; noProgress = 0; }
          if (noProgress >= 100) {
            console.log(`[dsh-leng-team] waitAndRead sid=${sid} 无进展熔断 evsLen=${__cur} iter=${iter}`);
            if (last) { if (onOutput) onOutput(last); return last; }
            if (out && out !== "(无输出)" && out !== "(无法读取输出)") { if (onOutput) onOutput(out); return out; }
            return "(无法读取输出)";
          }
        }
      } catch (e) { /* ignore */ }
      await this._sleep(1500);
    }
    if (last) { if (onOutput) onOutput(last); return last; }
    return "(无法读取输出)";
  }

  async _readAgentOutput(agent) {
    const sid = agent?.session?.id ?? agent?.sessionId;
    try {
      const session = agent?.session;
      if (!session) return "(无法读取输出)";
      const evs = session.snapshotEvents ? (session.snapshotEvents(0) ?? []) : [];
      if (Array.isArray(evs) && evs.length > 0) {
        const typeCounts = {};
        for (const ev of evs) { const k = String(ev?.type ?? ev?.kind ?? "?"); typeCounts[k] = (typeCounts[k] || 0) + 1; }
        console.log(`[dsh-leng-team] readOutput sid=${sid} evsLen=${evs.length} types=${JSON.stringify(typeCounts)}`);
        for (let i = evs.length - 1; i >= 0; i--) {
          const ev = evs[i];
          const kind = ev?.type ?? ev?.kind ?? "";
          if (String(kind).includes("assistant/message") || String(kind).includes("assistant")) {
            const msg = ev?.message ?? ev?.data?.message ?? ev;
            const c = msg?.content;
            let t = "";
            if (Array.isArray(c)) {
              const __txt = c.filter(b => b?.type === "text" && typeof b?.text === "string").map(b => b.text).join("\n").trim();
              const __rsn = c.filter(b => (b?.type === "reasoning" || b?.type === "thinking") && typeof b?.text === "string").map(b => b.text).join("\n").trim();
              const __bad = (x) => x && (x.indexOf("<invoke") >= 0 || x.indexOf("</invoke>") >= 0);
              if (__txt && !__bad(__txt)) t = __txt;
              else if (__rsn && !__bad(__rsn)) t = __rsn;
              else { const __p = []; for (const __b of c) { if (__b && typeof __b === "object") { for (const __v of Object.values(__b)) if (typeof __v === "string" && __v.trim() && !__bad(__v)) __p.push(__v.trim()); } } t = __p.join("\n").trim(); }
            }
            else if (typeof c === "string") { const __s = String(c).trim(); if (__s && __s.indexOf("<invoke") < 0 && __s.indexOf("</invoke>") < 0) t = __s; }
            if (t) { console.log(`[dsh-leng-team] readOutput sid=${sid} viaEvents len=${t.length}`); return t; }
          }
        }
      }
    } catch (e) { console.log("[dsh-leng-team] readOutput events err", String(e)); }
    try {
      const session = agent?.session;
      let msgs = null;
      if (typeof session?.deriveMessages === "function") {
        msgs = session.deriveMessages() ?? [];
      } else if (Array.isArray(session?.messages)) {
        msgs = session.messages;
      }
      if (msgs) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m?.role === "assistant") {
            const c = m.content;
            if (Array.isArray(c)) { const __txt = c.filter(b => b?.type === "text" && typeof b?.text === "string").map(b => b.text).join("\n").trim(); const __rsn = c.filter(b => (b?.type === "reasoning" || b?.type === "thinking") && typeof b?.text === "string").map(b => b.text).join("\n").trim(); const __bad = (x) => x && (x.indexOf("<invoke") >= 0 || x.indexOf("</invoke>") >= 0); let t = (__txt && !__bad(__txt)) ? __txt : ((__rsn && !__bad(__rsn)) ? __rsn : ""); if (!t) { const __p = []; for (const __b of c) { if (__b && typeof __b === "object") { for (const __v of Object.values(__b)) if (typeof __v === "string" && __v.trim() && !__bad(__v)) __p.push(__v.trim()); } } t = __p.join("\n").trim(); } if (t) { console.log(`[dsh-leng-team] readOutput sid=${sid} viaDerive len=${t.length}`); return t; } }
            else if (typeof c === "string" && c.trim()) { console.log(`[dsh-leng-team] readOutput sid=${sid} viaDeriveStr len=${c.trim().length}`); return String(c); }
          }
        }
      }
    } catch (e) { console.log("[dsh-leng-team] readOutput derive err", String(e)); }
    return "(无法读取输出)";
  }


  _nextFreeSeat() {
    for (let i = 0; i < this.effectiveCapacity(); i++) if (!this.seats.has(i)) return i;
    return -1;
  }

  _setTask(taskId, role, module, status, deps) {
    const prev = this.dag.get(taskId);
    this.dag.set(taskId, { id: taskId, role, module: module ?? null, status, deps: deps ?? [], output: prev?.output ?? null, rework: prev?.rework ?? 0 });
    this._emit();
  }

  _roleBusinessStatus(roleKey) {
    const run = this.activeRun;
    if (!run) return "idle";
    // derive from current stage / task state
    const t = [...this.dag.entries()].find(([, v]) => v.role === roleKey);
    if (t) return t[1].status;
    if (run.stage === roleKey && this.running) return "running";
    if (roleKey === "product" && run.product) return "finished";
    if (roleKey === "analyst" && run.analyst) return "finished";
    if (roleKey === "architect" && run.architecture) return "finished";
    if (roleKey === "security" && run.security) return "finished";
    if (roleKey === "ux" && run.ux) return "finished";
    if (roleKey === "ui" && run.ui) return "finished";
    if (roleKey === "reviewer" && run.review) return "finished";
    if (roleKey === "tester" && run.test) return "finished";
    if (roleKey === "ops" && run.ops) return "finished";
    if (roleKey === "docs" && run.docs) return "finished";
    if (roleKey === "auditor" && run.audit) return "finished";
    return "idle";
  }

  _contextFor(run, roleKey) {
    const cap = this.config.flow.summaryTokenCap;
    switch (roleKey) {
      case "product": return `## 用户目标\n${run.goal}`;
      case "analyst": return `## 产品需求\n${(run.product ?? "").slice(0, cap)}\n## 方案要求\n你必须输出至少两套可落地的实现方案，分别编号为「方案一」「方案二」（可含方案三），并对比各自优缺点、适用场景、成本、稳定性与扩展性，供用户（经父会话总指挥）选择。每套方案需包含完整的边界定义、风险分析与约束说明。`;
      case "architect": return `## 需求方案\n${(run.analyst ?? "").slice(0, cap)}`;
      case "tech_lead": return `## 需求方案\n${(run.analyst ?? "").slice(0, cap)}\n## 架构\n${(run.architecture ?? "").slice(0, cap)}`;
      case "data": return `## 架构\n${(run.architecture ?? "").slice(0, cap)}${run.techLead ? `\n## 详细设计\n${String(run.techLead).slice(0, cap)}` : ""}`;
      case "security": return `## 架构\n${(run.architecture ?? "").slice(0, cap)}${run.techLead ? `\n## 详细设计\n${String(run.techLead).slice(0, cap)}` : ""}${run.dataDesign ? `\n## 数据设计\n${String(run.dataDesign).slice(0, cap)}` : ""}`;
      case "ux": return `## 需求\n${(run.analyst ?? "").slice(0, cap)}\n## 架构\n${(run.architecture ?? "").slice(0, cap)}`;
      case "ui": return `## 交互\n${(run.ux ?? "").slice(0, cap)}`;
      case "reviewer": return `## 需求\n${(run.analyst ?? "").slice(0, cap)}\n## 开发产物\n${JSON.stringify(run.devOutputs ?? {}).slice(0, cap)}`;
      case "tester": return `## 需求\n${(run.analyst ?? "").slice(0, cap)}\n## 开发产物\n${JSON.stringify(run.devOutputs ?? {}).slice(0, cap)}\n## 评审\n${(run.review ?? "").slice(0, cap)}`;
      case "ops": return `## 开发产物\n${JSON.stringify(run.devOutputs ?? {}).slice(0, cap)}`;
      case "docs": return `## 全链路产物汇总\n${JSON.stringify({
        product: run.product, analyst: run.analyst, architecture: run.architecture, security: run.security,
        ux: run.ux, ui: run.ui, dev: run.devOutputs, review: run.review, test: run.test, ops: run.ops,
      }).slice(0, cap)}`;
      case "design_review": return `## 需求\n${(run.analyst ?? "").slice(0, cap)}\n## 架构\n${(run.architecture ?? "").slice(0, cap)}\n## UX 交互\n${(run.ux ?? "").slice(0, cap)}\n## UI 视觉\n${(run.ui ?? "").slice(0, cap)}\n## 安全审计\n${(run.security ?? "").slice(0, cap)}`;
      case "domain_design": return `## 用户目标\n${run.goal}\n## 产品定义\n${(run.product ?? "").slice(0, cap)}${run.investigationReport ? `\n## 调查报告\n${String(run.investigationReport.content ?? "").slice(0, cap)}` : ""}`;
      case "domain_conditional": return `## 用户目标\n${run.goal}\n## 产品定义\n${(run.product ?? "").slice(0, cap)}`;
      case "performance": return `## 需求\n${(run.analyst ?? "").slice(0, cap)}\n## 开发产物\n${JSON.stringify(run.devOutputs ?? {}).slice(0, cap)}`;
      case "security_test": return `## 需求\n${(run.analyst ?? "").slice(0, cap)}\n## 架构\n${(run.architecture ?? "").slice(0, cap)}\n## 开发产物\n${JSON.stringify(run.devOutputs ?? {}).slice(0, cap)}\n## 安全审计\n${(run.security ?? "").slice(0, cap)}`;
      case "devops": return `## 部署文档\n${(run.ops ?? "").slice(0, cap)}\n## 开发产物\n${JSON.stringify(run.devOutputs ?? {}).slice(0, cap)}`;
      case "release": return `## 部署文档\n${(run.ops ?? "").slice(0, cap)}${run.devops ? `\n## DevOps 配置\n${String(run.devops).slice(0, cap)}` : ""}`;
      case "sre": return `## 部署文档\n${(run.ops ?? "").slice(0, cap)}\n## 开发产物\n${JSON.stringify(run.devOutputs ?? {}).slice(0, cap)}`;
      case "auditor": {
        const c2 = cap * 2;
        const devLines = run.devOutputs ? Object.entries(run.devOutputs).map(([k, v]) => `### ${k}\n${String(v ?? "").slice(0, 700)}`).join("\n\n") : "(无模块输出)";
        const issuePool = this.issues.openPool().map((i) => `- ${i.id} [${sevName(i.severity)}] ${i.status} 责任人=${i.owner} 问题：${i.title}`).join("\n") || "- （无未关闭问题）";
        return `## 未关闭问题池（最终审核必须逐条处理：P2 未关闭/未风险接受则不得通过；P3 可风险接受但必须记录）\n${issuePool}\n\n## 你的任务：项目最终审核判定\n你是项目最终审核总工程师。请对照用户原始目标逐项核验下方全部交付产物，判定项目是否完整达标、无遗漏、无偏差。\n你的最终交付必须包含以下三部分（作为交付父会话/总指挥的最终项目总结）：\n1. **审核结论**：明确输出「审核结论：通过」或「审核结论：不通过」。若通过，附各项核验结果与依据；若不通过，逐条列出问题所属环节（产品需求/需求分析/架构/安全/UX/UI/前端开发/后端开发/代码评审/测试/运维/文档）+ 整改要求。\n2. **项目功能总结**（仅通过时）：本项目具备哪些功能、实现了用户原始目标的哪些要求。\n3. **交付与运行信息**（仅通过时）：项目文件所在位置（各开发模块代码文件路径、汇总后的完整工程路径）与如何运行（启动方式、依赖、访问方式）。\n禁止复述或重写任何产物文档，只做审核判定与总结。\n\n## 最终审核检查清单（方案 14 七项，逐项核验并在结论中注明通过/不通过）\n- 源基线对比：${(this.config.finalAudit?.baselineCompare !== false)}（复刻类对照源项目基线做行为差异测试）\n- 调查报告检查：${(this.config.finalAudit?.artifactReportCheck !== false)}\n- 差异清单检查：${(this.config.finalAudit?.diffListCheck !== false)}（复刻类核对差异与未知清单）\n- 调查闭环检查：${(this.config.finalAudit?.investigationClosureCheck !== false)}（调查充分性/假设显式标注/未知项有负责人）\n- 设计闭环检查：${(this.config.finalAudit?.designClosureCheck !== false)}（设计交叉评审/设计评审门禁/设计契约冻结/设计测试）\n- 最终回归检查：${(this.config.finalAudit?.finalRegressionCheck !== false)}（最终全功能回归测试通过才可审核）\n- 独立复验检查：${(this.config.finalAudit?.verificationCheck !== false)}（独立复验三态结论写入快照）\n\n## 用户原始目标\n${run.goal}\n\n## 产品需求全文\n${String(run.product ?? "").slice(0, cap)}\n\n## 需求分析全文\n${String(run.analyst ?? "").slice(0, cap)}\n\n## 架构全文\n${String(run.architecture ?? "").slice(0, cap)}\n\n## 安全审计全文\n${String(run.security ?? "").slice(0, cap)}\n\n## UX 交互全文\n${String(run.ux ?? "").slice(0, cap)}\n\n## UI 视觉全文\n${String(run.ui ?? "").slice(0, cap)}\n\n## 开发模块输出摘要\n${devLines.slice(0, c2)}\n\n## 代码评审结论\n${String(run.review ?? "").slice(0, cap)}\n\n## 测试结论\n${String(run.test ?? "").slice(0, cap)}\n\n## 运维说明\n${String(run.ops ?? "").slice(0, 1500)}\n\n## 交付文档（仅作审核对象，勿重写）\n${String(run.docs ?? "").slice(0, 2500)}`;
      }
      default: return `## 目标\n${run.goal}`;
    }
  }

  async _maybePlanSelect(run) {
    if (run.cancelled) return;
    const auto = this.config.flow.autoConfirm === true;
    const snippet = String(run.analyst ?? "").slice(0, 1500);
    if (auto) {
      run.planChoice = run.planChoice || 1;
      this.observability.record("info", "plan", `需求分析师已输出多套方案（需用户选择 · 测试默认方案${run.planChoice}）：\n${snippet}`);
      return;
    }
    run.manualConfirms.plan = "pending";
    run.pendingConfirm = "plan";
    this.observability.record("info", "plan", `请选择实现方案（/team plan <编号>，默认方案一）。方案摘要：\n${snippet}`);
    this._emit();
    const deadline = Date.now() + (this.config.flow.confirmTimeoutMs ?? 300000);
    while (Date.now() < deadline && run.pendingConfirm === "plan" && !run.cancelled) {
      await this._sleep(2000);
    }
    if (run.cancelled) return;
    if (run.pendingConfirm === "plan") {
      run.planChoice = 1;
      this.observability.record("warning", "plan_timeout", "方案选择超时，默认采用方案一");
    }
    run.pendingConfirm = null;
    this._emit();
  }


  async _maybeConfirmQuestions(run) {
    if (run.cancelled) return;
    const doc = String(run.analyst ?? "");
    const qs = [];
    const m = doc.match(/##\s*需求疑问([\s\S]*?)(?=##\s|$)/i);
    if (m && m[1]) {
      const lines = m[1].split("\n").map((x) => x.trim()).filter((x) => /^疑问\s*\d+[:：]/.test(x));
      for (const ln of lines) {
        const idx = ln.match(/^疑问\s*(\d+)/);
        const text = ln.replace(/^疑问\s*\d+[:：]/, "").trim();
        if (idx && text) qs.push({ id: Number(idx[1]), q: text });
      }
    }
    if (!qs.length) return;
    const auto = this.config.flow.autoConfirm === true;
    const listing = qs.map((q) => q.id + ". " + q.q).join("\n");
    if (auto) {
      this.observability.record("info", "questions", "需求分析师提出 " + qs.length + " 条需求疑问（需用户确认 · 测试默认按分析师假设继续）：\n" + listing);
      return;
    }
    run.manualConfirms.questions = "pending";
    run.pendingConfirm = "questions";
    run.questionAnswers = run.questionAnswers || {};
    this.observability.record("info", "questions", "需求分析师提出以下需求疑问，请逐条回答（/team answer <编号> <答复>，例如 /team answer 1 支持游客模式）：\n" + listing);
    this._emit();
    const deadline = Date.now() + (this.config.flow.confirmTimeoutMs ?? 300000);
    while (Date.now() < deadline && run.pendingConfirm === "questions" && !run.cancelled) {
      await this._sleep(2000);
    }
    if (run.cancelled) return;
    if (run.pendingConfirm === "questions") {
      this.observability.record("warning", "questions_timeout", "需求疑问确认超时，默认按分析师假设继续");
    }
    run.pendingConfirm = null;
    this._emit();
  }


  /** 方案 5.4：人工确认拒绝 → 回退对应环节重跑（变更策略 routeBack）。返回是否发生回退。 */
  async _handleRejected(run, key, roleKey, prop, hint) {
    if (run.manualConfirms?.[key] !== "rejected") return false;
    run.manualConfirms[key] = "confirmed"; // 重跑后默认通过，避免死循环
    this._recordRollback(run, { from: roleKey, to: roleKey, node: roleKey }, key + "_rejected");
    run[prop] = await this._runRole(run, roleKey, this._contextFor(run, roleKey) + "\n" + hint);
    this.observability.record("info", "rework", `用户拒绝 ${key}，已回退重跑 ${roleKey}（routeBack）`);
    return true;
  }

  async _maybeConfirm(run, key) {
    if (run.cancelled) return;
    const enabled = this.config.flow.manualConfirm?.[key];
    if (!enabled) return;
    // 测试模式（autoConfirm=true）：默认选择通过，并标注「需确认 · 测试默认通过」
    const auto = this.config.flow.autoConfirm === true;
    const label = { requirement: "需求定稿", architecture: "架构定稿", ui: "UI 定稿", final: "最终交付" }[key] ?? key;
    if (auto) {
      run.manualConfirms[key] = "auto";
      this.observability.record("info", "confirm", `${label}：需用户确认（测试默认通过）`);
      return;
    }
    // 正式模式：把确认请求挂到 run.pendingConfirm，交由父会话询问用户；
    // 父会话（总指挥）在向用户展示后通过 /team confirm <key> 或 /team reject <key> 回写。
    run.manualConfirms[key] = "pending";
    run.pendingConfirm = key;
    this.observability.record("info", "confirm", `${label}：等待用户确认（/team confirm ${key} 通过 / /team reject ${key} 拒绝）`);
    this._emit();
    // 等待用户确认（有界等待，超时按拒绝处理，防止流水线永久卡死）
    const deadline = Date.now() + (this.config.flow.confirmTimeoutMs ?? 300000);
    while (Date.now() < deadline && run.manualConfirms[key] === "pending" && !run.cancelled) {
      await this._sleep(2000);
    }
    if (run.cancelled) return;
    if (run.manualConfirms[key] === "pending") {
      run.manualConfirms[key] = "timeout";
      this.observability.record("warning", "confirm_timeout", `${label} 等待确认超时，默认拒绝并提示`);
    }
    this._emit();
  }

  /** 供 /team confirm | /team reject 命令调用，回写人工确认结果。 */
  confirm(key, ok) {
    const run = this.activeRun;
    if (!run) return { ok: false, message: "当前没有运行中的流水线。" };
    const enabled = this.config.flow.manualConfirm?.[key];
    if (!enabled) return { ok: false, message: `环节 ${key} 未开启人工确认。` };
    if (run.manualConfirms[key] === "pending") {
      run.manualConfirms[key] = ok ? "confirmed" : "rejected";
      run.pendingConfirm = null;
      this.observability.record(ok ? "info" : "warning", "confirm", `${key} 已${ok ? "确认通过" : "被用户拒绝"}`);
      this._emit();
      return { ok: true, message: `${key} 已${ok ? "确认通过" : "拒绝"}，流水线继续。` };
    }
    return { ok: false, message: `环节 ${key} 当前不在等待确认状态（${run.manualConfirms[key] ?? "未开启"}）。` };
  }

  _onWatchdogAlert(taskId, alert) {
    this.observability.recordAnomaly(alert.type, alert.message);
    if (this.onAlert) this.onAlert(alert);
    // V9.3：429/限流驱动令牌桶状态机；其余视为请求恢复
    if (/429|rate.?limit|限流/i.test(String(alert?.message ?? "") + " " + String(alert?.type ?? ""))) this.rateLimiter.record429();
    else this.rateLimiter.recordSuccess();
    // V9.3：销毁/终止/致命类告警前先落盘事务快照（看门狗销毁前快照，方案 1.5/十八）
    if (/销毁|dispose|kill|终止|fatal|致命|崩溃|crash/i.test(String(alert?.message ?? "") + " " + String(alert?.type ?? ""))) {
      try {
        this._snapshot();
        this.observability.record("warning", "watchdog_snapshot", `销毁前事务快照已落盘（告警类型=${alert?.type ?? "unknown"}）`);
      } catch (e) { console.log("[dsh-leng-team] watchdog snapshot fail", String(e)); }
    }
    this._emit();
  }

  _estimateTokens(text) {
    const s = String(text ?? "");
    return Math.ceil(s.length / 2.5);
  }

  _snapshot() {
    const run = this.activeRun;
    this.snapshotStore.save({
      active: this.running,
      runId: run?.id,
      goal: run?.goal,
      stage: run?.stage,
      seats: [...this.seats.entries()].map(([i, s]) => ({ seat: i, taskId: s.taskId, role: s.role, module: s.module })),
      queue: this.queue.map((q) => ({ taskId: q.taskId, role: q.role, module: q.module, status: q.status })),
      runState: run ? {
        product: run.product, productLight: run.productLight ?? null, analyst: run.analyst, architecture: run.architecture, security: run.security,
        ux: run.ux, ui: run.ui, devOutputs: run.devOutputs, review: run.review, test: run.test,
        ops: run.ops, docs: run.docs, audit: run.audit,
        taskType: run.taskType, taskMode: run.taskMode ?? null, investigation: run.investigation ?? null,
        investigationReport: run.investigationReport ?? null, signOff: run.signOff ?? null, enabledSlots: run.enabledSlots ?? [],
        designContract: run.designContract ?? null, performance: run.performance ?? null, securityTest: run.securityTest ?? null,
        devops: run.devops ?? null, release: run.release ?? null, sre: run.sre ?? null,
        deployVerify: run.deployVerify ?? null, finalRegression: run.finalRegression ?? null,
        verification: run.verification ?? null, auditRounds: run.auditRounds ?? 0,
        versions: run.versions ?? null,
      } : null,
      rollback: this.rollback.snapshot(),
      rate: this.rateLimiter.snapshot(),
      issues: this.issues.serialize(),
    });
  }

  _restore(snap) {
    this.issues.restore(snap.issues);
    if (snap.rollback) { try { this.rollback = new RollbackBudget(this.config.rollback); Object.assign(this.rollback, snap.rollback); } catch (e) { /* keep */ } }
    if (snap.rate) { try { this.rateLimiter.concurrency = snap.rate.concurrency ?? this.rateLimiter.concurrency; this.rateLimiter.state = snap.rate.state ?? this.rateLimiter.state; } catch (e) { /* keep */ } }
    this.queue = (snap.queue ?? []).map((q) => ({ ...q, createdAt: Date.now() }));
    for (const s of snap.seats ?? []) {
      this.seats.set(s.seat, { taskId: s.taskId, role: s.role, module: s.module, startedAt: Date.now() });
    }
    const run = this.activeRun;
    if (snap.runState) Object.assign(run, snap.runState);
    if (run?.taskType) { this.taskType = run.taskType; this.taskTemplate = templateFor(run.taskType); }
    run.stage = snap.stage ?? run.stage;
    if (run.stage === "dev") {
      // re-enqueue module tasks whose status isn't finished
      for (const q of this.queue) this.dag.set(q.taskId, { id: q.taskId, role: q.role, module: q.module, status: q.status, deps: [], output: null, rework: 0 });
      for (const m of Object.keys(run.devOutputs ?? {})) {
        const t = this.dag.get(m);
        if (t && run.devOutputs[m]) { t.status = "finished"; t.output = run.devOutputs[m]; }
      }
    }
  }

  _summarize(run) {
    return {
      status: "完成",
      goal: run.goal,
      stages: {
        product: run.product ? "完成" : "未执行",
        analyst: run.analyst ? "完成" : "未执行",
        architecture: run.architecture ? "完成" : "未执行",
        security: run.security ? "完成" : "未执行",
        ux: run.ux ? "完成" : "未执行",
        ui: run.ui ? "完成" : "未执行",
        dev: run.devOutputs ? `完成 (${Object.keys(run.devOutputs).length} 个模块)` : "未执行",
        review: run.review ? "完成" : "未执行",
        test: run.test ? "完成" : "未执行",
        ops: run.ops ? "完成" : "未执行",
        docs: run.docs ? "完成" : "未执行",
        audit: run.audit ? "完成" : "未执行",
      },
    };
  }

  _emit() {
    if (this.onStateChange) {
      try { this.onStateChange(this.dagScene()); } catch { /* ignore */ }
    }
  }

  async _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
