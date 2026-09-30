/**
 * LengTeamOrchestrator — parent-session director.
 *
 * Owns:
 *  - Seat pool (≤3 concurrent sub-sessions, hard cap), task queue, DAG dependencies
 *  - Child-agent lifecycle for all 14 core roles + 21 conditional roles (35 actors total),
 *    plus fine-grained module dev tasks
 *  - Handover via central dispatch (all data goes through the orchestrator)
 *  - Transactional snapshot + breakpoint recovery
 *  - Manual confirmation nodes
 *  - Wiring to watchdog, observability, and dagScene (business truth only)
 */

import { ROLES, ROLE_MAP, ORCHESTRATOR, PIPELINE_ORDER, CONDITIONAL, buildRolePrompt, BOUNDARY_RULES, ROLE_COUNT, ROLE_PACKS } from "./roles.js";
import { LengWatchdog, STATUS } from "./watchdog.js";
import { ModuleSplitter } from "./module-splitter.js";
import { Observability } from "./observability.js";
import { SnapshotStore } from "./snapshot.js";
import { IssueTracker, sevName, sevNum } from "./issues.js";
import { normalizeConfig, DISCOVERY_MAX_ROUNDS } from "./config.js";
import { similarity, normalizeText } from "./similarity.js";
import { Discovery } from "./discovery.js";
import { ConditionalActivation } from "./conditional.js";
import { RollbackBudget } from "./rollback-budget.js";
import { RateLimiter } from "./rate-limiter.js";
import { IndependentVerification } from "./verification.js";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
/** 显式版本号单一数据源：package.json 的 release 字段（回退到 version）。 */
const pkg = _require("../package.json");
import { detectTaskType, detectTaskMode, evaluateInvestigation, buildReplicaRe, templateFor, DOMAIN_EXEC, CROSS_DOMAIN_CONDITIONALS, GATE_BLOCKING, GATE_PASS_CRITERIA, GATE_EXECUTORS, VERSION_RULES } from "./domain-templates.js";
// 第十二轮 K-12B：阶段级复用的声明面（阶段 → 产物字段 → 主责角色），
// 校验见 scripts/check-declarations.mjs；消费见下方 _runRole() 的恢复态分支。
import { STAGE_REUSE } from "./stage-reuse.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
    // #53：DSH 平台并发上限探测——平台上限低于配置时自动降级并记录（平台上限优先）
    const platformCap = Math.max(1, Math.min(5, Number(this.config.concurrency?.platformCap ?? 5)));
    this.capacity = Math.min(this.config.concurrency.maxConcurrent, platformCap);
    if (this.capacity < this.config.concurrency.maxConcurrent) {
      console.log(`[dsh-leng-team] DSH 平台并发上限 ${platformCap} < 配置 ${this.config.concurrency.maxConcurrent}，自动降级并发为 ${this.capacity}`);
    }
    this.seats = new Map();      // seatIndex -> { taskId, role, agent, startedAt, status }
    // #16：席位状态机 IDLE(无条目) → RESERVED(预留) → OCCUPIED(占用) → RELEASING(释放) → IDLE；含 SUSPENDED/FAILED
    this.SEAT_STATES = { IDLE: "IDLE", RESERVED: "RESERVED", OCCUPIED: "OCCUPIED", RELEASING: "RELEASING", SUSPENDED: "SUSPENDED", FAILED: "FAILED" };
    this._seatTimers = new Map(); // RESERVED 超时定时器
    this.queue = [];             // { taskId, role, module, depends, status, createdAt }
    this.dag = new Map();        // taskId -> { status, deps, ... }
    this.activeRun = null;
    this.running = false;
    this.paused = false;
    this.pausedUntil = 0; // 第九轮 R4：看门狗 pause 策略的自动恢复期限（0 = 无期限，人工 /team pause 走这条）
    this._rollbackBudgetNotified = new Set(); // 第十一轮 M6：回退预算升级通知去重（按回退节点）
    // 第十轮 M5：看门狗告警去重/限次状态 —— 同一任务的 pause 告警不重复续期、不重复通知父会话。
    this._wdHandled = new Map(); // "pause:<taskId>" -> 次数
    this._wdPauseTask = null;    // 当前处于「暂停处置中」的任务标识
    // 第十轮 M4：门禁软阻断重复计数（同一未关闭阻断项反复软阻断 → 升级父会话裁决）。
    this._gateSoftSeen = new Map();
    this.lastResult = null;   // { ts, text } 最近一次需通知的命令结果（供 client 轮询弹 toast）

    // ---- Cache (cost control) ----
    this.moduleCache = new Map(); // cacheKey -> output

    // ---- 统一回环规则：问题分级状态机 ----
    this.issues = new IssueTracker();

    // ---- V9.3：调查员 / 条件启用三方会签 / 全局回退预算 / 令牌桶+429 / 独立复验 ----
    // 修复第十轮 K-5：原传 `this.config.conditional`（布尔），导致 discovery.* 整族配置读不到；
    // Discovery 只应接 discovery 子配置。
    this.discovery = new Discovery(this.config.discovery ?? {});
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
    this.childEvents = [];               // #25：子会话完成事件日志 { childId, role, status, artifacts, ts, version }（父轮询兜底补偿事件丢失）

    // #22：全局异步写锁——快照写入/子会话产物写入/DAG 状态变更/看门狗销毁串行化（防竞态捕获中间状态）
    this._lockChain = Promise.resolve();
    this._p0RecoveryTimer = null;        // P0 硬阻断恢复定时器

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

  /** 可量化验收指标核算（方案 17：13 项 100% 硬指标，实时可查、随快照留痕）。 */
  acceptanceSnapshot() {
    const run = this.activeRun;
    const sum = this.issues.summary ? this.issues.summary() : { total: 0, closed: 0, bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 }, pool: [] };
    const all = [...this.issues.issues.values()];
    // 修复 R4：此处此前把 ESCALATED 也算作「已关闭」，而 issues._closed()（门禁 blocking()/openPool()/
    // summary() 使用的权威定义）不含 ESCALATED。两套定义不一致会产出自相矛盾的验收报告：
    // 同一条「升级人工待裁决」的 P0，门禁判定其未关闭并持续阻断，验收指标却报 P0/P1 阻断率 100%。
    // 统一以 issues._closed() 为准（ESCALATED = 未裁决 = 未关闭）。
    const closedSt = (i) => (typeof this.issues?._closed === "function"
      ? this.issues._closed(i)
      : (i && (i.status === "CLOSED" || i.status === "RISK_ACCEPTED" || i.status === "REVIEW_PASSED")));
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
      rollbackVersionRate: pct(rb?.events?.filter((e) => e.versionBumped).length, rb?.events?.length ?? 0), // 回退必版本递增
      staleRate: pct(rb?.events?.filter((e) => e.staleMarked).length, rb?.events?.length ?? 0),       // 回退必标记下游 stale
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

  /** 方向A：把用户可见提示推送到父会话聊天（agent.followup，与「项目会话已建立」横幅同通道），
   *  无 agent 时回退 recordResult（client 轮询 toast）。 */
  _notifyUser(run, text) {
    const msg = String(text ?? "").trim();
    if (!msg) return;
    const agent = run?.parentAgent;
    if (agent && typeof agent.followup === "function") {
      try {
        agent.followup({
          role: "user",
          id: "team-notify-" + randomUUID(),
          content: [{ type: "text", text: msg }],
          source: { kind: "user" },
        });
        this.recordResult(msg); // 同时供 client 轮询 toast
        return;
      } catch (e) { /* fallback below */ }
    }
    this.recordResult(msg);
  }

  /** 方向A：确认环节对应的待确认内容摘要（前 800 字，让用户知道「确认的是什么」）。 */
  _confirmSummary(run, key) {
    const srcMap = {
      requirement: run?.product || run?.analyst,
      architecture: run?.architecture,
      ui: run?.ui,
      final: run?.docs || run?.audit || "",
      plan: run?.analyst,
      questions: run?.analyst,
      conditional: run?.conditionalReason,
    };
    const t = String(srcMap[key] ?? "").trim();
    if (!t) return "";
    return t.slice(0, 800);
  }

  _confirmNote(run, key) {
    if (!run) return "";
    const v = run.manualConfirms?.[key];
    if (v === "confirmed") return "已确认";
    if (v === "auto") return "需确认 · 测试默认通过";
    if (v === "pending") return "待确认 · /team confirm " + key;
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
      return {
        status: "reuse",
        summary: { goal: this.lastGoal ?? "" },
        activeRunId: null,
        hint: "本会话已用于 team 项目，无法再次 start：请在 DSH 新建会话后重试，或执行 leng_team reset --all（/team reset --all）清除会话标记后重启。",
      };
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
    // 修复复刻交付物不可用：确定项目输出目录。
    // 复刻类：若用户目标中解析出 targetPath，则用之；否则自动创建 ./dsh-output/<run-id>。
    // 非复刻类：统一自动创建，避免各模块子会话把文件写到不确定位置。
    run.outputDir = this._resolveOutputDir(run);
    this.activeRun = run;
    this.running = true;
    this.paused = false;
    this.lastProjectSessionId = sid;
    this.lastGoal = run.goal;

    // restore from snapshot if present (breakpoint recovery)
    const snap = this.snapshotStore.load();
    // 修复 R15：主快照损坏/缺失时 load() 会逐级回退到 .prev/.full-N，此处如实上报降级，
    // 避免「静默用了旧状态」被当成正常恢复。
    if (snap && this.snapshotStore.lastLoadedFrom && this.snapshotStore.lastLoadedFrom !== "primary") {
      this.observability.record("warning", "snapshot_fallback",
        `主快照不可用，已回退到备份 ${this.snapshotStore.lastLoadedFrom}`);
    }
    if (snap?.active) {
      if (snap.goal === run.goal) {
        this._restore(snap);
        this.observability.record("info", "recovery", `从快照恢复流水线 ${snap.runId ?? "?"}`);
      } else {
        // 修复：旧快照（不同目标）清理并提示，避免静默忽略
        this.snapshotStore.clear();
        this.observability.record("warning", "stale_snapshot",
          `发现旧目标快照（${String(snap.goal ?? "").slice(0, 40)}），已清理。当前目标：${String(run.goal ?? "").slice(0, 40)}`);
      }
    }

    this.watchdog.start();
    this.watchdog.onAlert = (taskId, alert) => this._onWatchdogAlert(taskId, alert);
    this._emit();

    // 项目会话 = 当前触发会话改名为项目目标（HARNESS UI 顶级可见、项目名命名）。
    // 改名与 toast 由 commands/index 在触发时同步完成（见 launchProject / start 分支），
    // 此处仅负责启动流水线。
    try {
      await this._runPipeline(run);
      // 修复 E3：原实现无条件返回 status:"complete"，即使开发阶段零交付（devOutputs={}）
      // 也报「完成」。现按 run.delivered 如实返回（零交付 → "incomplete"）。
      // 修复第十一轮 K-8：取消后的终态需如实返回 "cancelled"（此前取消路径不可达，永远走不到）。
      // E3/K-9 语义保持：未取消时按 run.delivered 返回 complete / incomplete。
      return { status: run.cancelled ? "cancelled" : (run.delivered === false ? "incomplete" : "complete"), summary: this._summarize(run) };
    } catch (e) {
      console.log("[dsh-leng-team] start CATCH:", String(e?.message ?? e), "\n", String(e?.stack ?? ""));
      this.observability.recordAnomaly("crash", String(e?.message ?? e));
      // 修复第十轮 K-11：此处原为 `this._snapshot();`（未 await）。_snapshot() 经 _withLock
      // （`this._lockChain.then(fn, fn)`）返回 Promise，回调被排入微任务，会在下面 finally 把
      // this.running 置 false **之后**才执行，于是落盘的 `active: this.running` 恒为 false；
      // 而 start() 只在 snap.active 为真时才 _restore，崩溃后的断点恢复因此永远不生效
      // （实测：part1 崩溃后 snapActive=false → part2 同目标重跑 restoreCalled=false）。
      // 改为 await：保证快照在 running 仍为 true 时写入、且写盘完成后才返回。
      await this._snapshot();
      return { status: "error", error: String(e?.message ?? e) };
    } finally {
      this.running = false;
      this.watchdog.stop();
      if (this._parentAliveTimer) { try { clearInterval(this._parentAliveTimer); } catch (e) { /* ignore */ } this._parentAliveTimer = null; }
      // 修复 F11：P0 恢复定时器也必须随流水线结束清理，否则残留定时器会在结束后
      // 改写 this.paused / 令牌桶状态，覆盖用户主动停止的意图。
      if (this._p0RecoveryTimer) { try { clearTimeout(this._p0RecoveryTimer); } catch (e) { /* ignore */ } this._p0RecoveryTimer = null; }
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

  /**
   * 第十一轮 K-8/K-14：取消当前运行中的流水线。
   * 修复前：run.cancelled 被约 50 处读取（含各阶段「流水线已取消」早退与确认等待循环），
   * 但全仓没有任何代码把它置为 true，且 /team 子命令里没有 cancel/stop/abort
   * → 整条取消路径是不可达的死代码（第十轮 C6「确认等待中取消」因此无从测试）。
   * 本编排器同一时刻只运行一条流水线（this.running），故取消即释放全部席位。
   */
  cancelActive(reason = "用户取消（/team cancel）") {
    const run = this.activeRun;
    if (!run || !this.running) {
      return { ok: false, message: "当前没有运行中的流水线，无需取消。" };
    }
    run.cancelled = true;
    run.cancelReason = String(reason);
    let freed = 0;
    for (const seat of [...this.seats.keys()]) {
      this.releaseSeat(seat);
      freed += 1;
    }
    this.observability.record("warning", "cancel", `${reason}；已释放席位 ${freed} 个，流水线将在当前阶段边界退出`);
    this._notifyUser?.(`🛑 流水线已取消：${reason}\n不再进入下一阶段；已产出的中间产物与问题池保留在磁盘（/team status 可查看），需要时用 /team start 重新发起。`);
    this._emit();
    return { ok: true, message: `已请求取消流水线（释放席位 ${freed} 个）。` };
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

  reset({ all = false } = {}) {
    // kill all child agents, free all seats, clear queue & cache & watchdog
    if (this._parentAliveTimer) { try { clearInterval(this._parentAliveTimer); } catch (e) { /* ignore */ } this._parentAliveTimer = null; }
    if (this._p0RecoveryTimer) { try { clearTimeout(this._p0RecoveryTimer); } catch (e) { /* ignore */ } this._p0RecoveryTimer = null; }
    this.parentSessionId = null;
    for (const s of this.seats.values()) {
      try { s.agent?.dispose?.(); } catch { /* ignore */ }
    }
    for (const t of this._seatTimers.values()) { try { clearTimeout(t); } catch { /* ignore */ } }
    this._seatTimers.clear();
    this.seats.clear();
    this.queue = [];
    this.dag.clear();
    this.moduleCache.clear();
    this.issues.clear();
    this.rollback = new RollbackBudget(this.config.rollback);
    this.verification = new IndependentVerification(this.config.verification);
    // 修复 E7（第八轮生命周期真跑实测发现）：原 reset() 声称「全局重置」，却唯独不复位
    // 429 限流状态机 —— 而「P0 硬阻断」是**两半机制**（this.paused + rateLimiter 的
    // GLOBAL_PAUSE/并发=1），reset() 只复位了前半、留着后半：
    //   实测 reset({all:true}) 后仍为 {state:"GLOBAL_PAUSE", concurrency:1, tokens:0,
    //   allowNewTask:false, backoffMs:24000}；下一个 start() 因此多出 1 条
    //   `rate_frozen: 429 状态=GLOBAL_PAUSE，新任务调度暂缓` 告警 + 24160ms 调度停顿
    //   （对照干净基准 0 条 / 0ms；24160ms ≈ backoffMs() = 3000×8）。
    // 与 rollback / verification 同构：整体重建，令 state/concurrency/令牌桶/_429Count
    // /_trickleAt/stateLog 全部回到初值。
    this.rateLimiter = new RateLimiter(this.config.concurrency);
    this.watchdog.clear();
    this.activeRun = null;
    this.running = false;
    this.paused = false;
    this.pausedUntil = 0; // 第九轮 R4：reset 必须一并清掉自动恢复期限
    this._rollbackBudgetNotified = new Set(); // 第十一轮 M6：重置时一并清空升级通知去重表
    // 第十轮 M5/M4：看门狗告警去重计数与门禁软阻断计数必须随 reset 归零，
    // 否则「重置后重新 start」会带着上一轮的告警历史，导致新运行一开始就被判重复。
    this._wdHandled = new Map();
    this._wdPauseTask = null;
    this._gateSoftSeen = new Map();
    if (all) {
      // 方案1：显式 --all 才清除「会话使用标记」，允许同会话重新 start（默认保留单会话单项目防重复设计）
      this.lastProjectSessionId = null;
      this.lastGoal = null;
    }
    this.observability.record("info", "reset", all ? "全局重置（含会话标记清除）" : "全局重置完成");
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
    // 修复：完整重建受影响实例，确保配置变更实时生效
    if (this.rateLimiter) {
      this.rateLimiter.cfg = { ...this.rateLimiter.cfg, maxConcurrent: next.concurrency.maxConcurrent };
      this.rateLimiter.concurrency = Math.min(this.rateLimiter.concurrency, next.concurrency.maxConcurrent);
    }
    this.watchdog.configure?.(next.watchdog);
    if (this.discovery) this.discovery = new Discovery(next.discovery ?? {});
    if (this.conditional) this.conditional = new ConditionalActivation(next.conditional);
    if (this.rollback) this.rollback = new RollbackBudget(next.rollback);
    if (this.verification) this.verification = new IndependentVerification(next.verification);
    if (this.splitter) this.splitter = new ModuleSplitter(next.moduleSplit);
    if (this.observability) this.observability = new Observability(next.observability);
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
      release: pkg.release || pkg.version,
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
      // 第十轮 K-1/K-3 交叉校验：角色包声明与域执行角色声明此前无任何消费者与校验，
      // 漂移（缺 document/fiction 包、designKey 悬空、roleKey 不在角色表）不会被发现。
      add("rolePacks", "角色包声明自洽（含总指挥且角色均在角色表）", (() => {
        const keys = Object.keys(ROLE_PACKS ?? {});
        if (!keys.length) return false;
        const bad = [];
        for (const k of keys) {
          const bs = ROLE_PACKS[k]?.slotBindings;
          if (!Array.isArray(bs) || !bs.length) { bad.push(k + ":空"); continue; }
          if (!ROLE_COUNT?.[k]) bad.push(k + ":缺 ROLE_COUNT 表述");
          if (Number(ROLE_PACKS[k]?.declaredCount) !== bs.length) bad.push(k + ":declaredCount≠绑定数");
          if (bs.filter((b) => b.roleKey === ORCHESTRATOR).length !== 1) bad.push(k + ":总指挥≠1");
          for (const b of bs) if (b.roleKey !== ORCHESTRATOR && !ROLE_MAP[b.roleKey]) bad.push(k + ":" + b.roleKey + "未定义");
        }
        return bad.length === 0;
      })(), `包=${Object.keys(ROLE_PACKS ?? {}).join("/")}`);
      add("domainExec", "域执行/设计角色声明有效", (() => {
        const bad = [];
        for (const k of Object.keys(DOMAIN_EXEC ?? {})) {
          const e = DOMAIN_EXEC[k] ?? {};
          if (!e.roleKey || !ROLE_MAP[e.roleKey]) bad.push(k + ":exec=" + e.roleKey);
          if (e.designKey && !ROLE_MAP[e.designKey]) bad.push(k + ":design=" + e.designKey);
        }
        return bad.length === 0;
      })(), `域=${Object.keys(DOMAIN_EXEC ?? {}).join("/")}`);
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
      add("gateBlocking", "门禁阻断三级（P0硬/P1软/P2-P3警告）", GATE_BLOCKING.P0 === "hard" && GATE_BLOCKING.P1 === "soft" && GATE_BLOCKING.P2 === "warn" && typeof this._applyGateBlocking === "function", "");
      add("gatePassCriteria", "门禁通过标准量化（阈值/未关闭上限/签字角色）", !!GATE_PASS_CRITERIA && GATE_PASS_CRITERIA.maxOpenIssues > 0 && (GATE_PASS_CRITERIA.signers?.length ?? 0) >= 2, "");
      add("gateExecutors", "门禁执行者（调查=总指挥+架构师/设计=review/最终=final_review/安全审查=risk/安全测试=security_test）", GATE_EXECUTORS.investigation_sufficiency?.includes("orchestrator") && GATE_EXECUTORS.investigation_sufficiency?.includes("architect") && GATE_EXECUTORS.final_audit?.includes("final_review") && GATE_EXECUTORS.security_audit?.includes("risk") && GATE_EXECUTORS.security_test?.includes("security_test"), "");
      add("roleCount", "角色数量统一表述（总指挥+专业角色）", ["software", "data_analysis", "research", "content", "document", "fiction", "generic"].every((k) => !!ROLE_COUNT?.[k]), Object.values(ROLE_COUNT ?? {}).join(" / "));
      add("boundaryRules", "角色边界强制（BOUNDARY_RULES ≥7 组 + 输出声明机制）", (BOUNDARY_RULES?.length ?? 0) >= 7 && typeof this._checkBoundaryDeclaration === "function", "");
      add("cacheLayered", "缓存键分层（第一层强约束/第二层条件版本弱约束）", typeof this.splitter?.cacheKey === "function" && (this.splitter?.cacheKey?.toString?.() ?? "").includes("strong"), "");
      add("versionRules", "版本递增规则（#43）", !!VERSION_RULES?.scheme && VERSION_RULES.bumpOnRollback === true, "");
      add("mirrorBudget", "镜像复验成本控制（Token 预算 10%，超限降级语义比对）", Number(this.config.verification?.mirrorBudgetRatio ?? 0.1) > 0 && Number(this.config.verification?.mirrorBudgetRatio ?? 0.1) <= 1, "");
      add("conditionalConfirm", "有条件合格用户确认（超时默认不合格）", typeof this._conditionalConfirm === "function", "");
      add("p3Audit", "P3 自动接受抽查（20% 采样可撤销）", typeof this.issues?.auditP3 === "function", "");
      add("platformCap", "平台并发探测降级（#53）", this.capacity <= this.config.concurrency?.maxConcurrent && this.capacity >= 1 && this.capacity <= 5, "capacity=" + this.capacity);
      add("deployEnv", "环境适配器（#54：local/container/remote/simulated 降级标记 conditional）", typeof this._resolveDeployEnv === "function" && (this.config.deployEnv?.adapters?.length ?? 0) >= 4, "");
      add("regressionTiers", "最终回归分层（#57：核心必跑/条件执行/可选抽样+时间预算）", !!this.config.finalRegression?.tiers && Number(this.config.finalRegression?.timeBudgetMs ?? 0) > 0, "");
      add("tokenBucketParams", "令牌桶容量/速率/降级恢复（#58）", typeof this.rateLimiter?.bucket?.degrade === "function" && typeof this.rateLimiter?.bucket?.restore === "function", "burst=" + (this.rateLimiter?.bucket?.capacity ?? "?"));
    } catch (e) {
      add("selfTest", "自检执行", false, String(e?.message ?? e));
    }
    // #8 版本指纹：cacheKey 相关版本号汇总快照（排查缓存复用问题时直接使用）
    const fingerprint = {
      release: pkg.release || pkg.version,
      personaVersion: this.config.version?.personaVersion,
      domainTemplateVersion: this.config.domainTemplate?.version,
      discoveryArtifactsVersion: this.config.discoveryArtifacts?.version,
      discoveryMaxRounds: { min: DISCOVERY_MAX_ROUNDS.min, max: DISCOVERY_MAX_ROUNDS.max, default: DISCOVERY_MAX_ROUNDS.default },
      rollbackBudget: this.rollback?.totalBudget,
      cacheKey: {
        includeConditionalVersions: !!this.config.cacheKey?.includeConditionalVersions,
        strictVersionCheck: !!this.config.cacheKey?.strictVersionCheck,
        recordHit: !!this.config.cacheKey?.recordHit,
        recordMiss: !!this.config.cacheKey?.recordMiss,
      },
    };
    return { ok: checks.every((c) => c.ok), checks, at: Date.now(), fingerprint };
  }
  /** 解析检查报告中的问题提示（必须修复=阻断P1 / 建议优化=非阻断P2 / 问题模块=代码类阻断P1）。 */
  _parseIssueHints(doc) {
    const hints = [];
    const lines = String(doc ?? "").split("\n");
    for (const raw of lines) {
      // 修复 E6（端到端实测发现）：原实现只 trim 后要求行首就是 `必须修复：`，
      // 于是合规产物里极常见的列表写法「- 必须修复：xxx」「1. 必须修复：xxx」「> 必须修复：xxx」
      // 全部漏检 —— 真实缺陷被静默丢弃（问题池为空 → 门禁 none → 无人返工）。
      // 现容许行首的列表符号/序号/引用符。
      const t = raw.trim().replace(/^[-*•·>]+\s*/, "").replace(/^\d+[.、)]\s*/, "");
      // 修复第九轮 N2（真实数据实测发现）：行首否定写法必须识别为「无问题」。
      // 原实现只看「标记 + 冒号」，冒号后的「无」被当成问题标题，于是干净报告被判硬返工：
      // 实测 `R9_MODE=noisy` 产生幻影问题单 `ISS-0002[P1]无`、design_gate 软阻断 1 项、
      // reviewer→dev 幻影回退 3 次触发 rollback_escalated、security_escalated，
      // 角色调用 51 次 vs 干净 run 21 次（2.4 倍 LLM 成本）。
      const m = /^(必须修复|建议优化|问题模块|建议|优化建议)[:：]\s*(.*)$/.exec(t);
      if (!m) continue;
      const body = String(m[2] ?? "").trim();
      if (this._isNegatedFinding(body)) continue;
      const sev = m[1] === "必须修复" || m[1] === "问题模块" ? 1 : m[1] === "建议优化" ? 2 : 3;
      hints.push({ sev, title: body });
    }
    return hints;
  }

  /**
   * 第九轮 N2：判断「标记：<内容>」里的内容是否为**空/否定**写法。
   * 中文评审报告里「缺陷：无」「漏洞：未发现」「问题模块：无」「必须修复：无」「建议：暂无」
   * 是标准的*无问题*写法；只有整个剩余内容就是一个否定词（可带程度/类别修饰）才算无问题。
   * 反例必须保持为真实缺陷：「必须修复：无法保存数据」「缺陷：无重试导致丢数据」
   * 都不匹配（`无法…`/`无重试…` 不是纯否定词），仍会被判为失败条目。
   * @returns {boolean} true = 该条不是有效失败条目，应跳过
   */
  _isNegatedFinding(text) {
    const s = String(text ?? "").replace(/[\s。．.,，;；、:：!！?？'"]+/g, "");
    if (!s) return true; // 「缺陷：」后为空同样不算有效条目
    return /^(无|没有|暂无|未发现|未涉及|未出现|不存在|不适用|不涉及|无误|已修复|已整改|none|nil|null|na|n\/a|-|—)(高危|中危|低危|严重|重大|任何|明显|相关|阻断|新增|遗留|已知|其他)?(漏洞|问题|缺陷|风险|异常|项|发现|故障|隐患)?$/i.test(s);
  }

  /** 把检查报告中的问题录入问题池（去重），返回 [{ id, sev, title }]。
   *  V9.3：P3 建议类自动留痕 + 风险接受 + 公示（方案 8.2/8.5）；
   *  P0/P1/P2 分级由门禁角色初判（gateReview），最终审核独立复核（方案 8.3 双人复核）。 */
  _recordIssuesFrom(doc, owner, module) {
    const created = [];
    for (const h of this._parseIssueHints(doc)) {
      const it = this.issues.open({ severity: h.sev, owner, module: module ?? "", title: h.title.slice(0, 120), evidence: String(doc ?? "").slice(0, 500) });
      it.gateReview = owner; // 门禁角色初判分级
      if (h.sev === 3 && this.config.finalReview?.p3LimitedScope !== false) {
        try { this.issues.riskAccept(it.id, `P3 建议自动风险接受（${owner} 记录）`); } catch (e) { /* ignore */ }
        this.observability.record("info", "p3_auto_accept", `P3 建议已记录并公示：${it.title}（问题 ${it.id}）`);
      } else if (h.sev === 3) {
        // 第十一轮 K-15 接线：finalReview.p3LimitedScope=false 时改为「仅记录不自动接受」，等待人工裁决。
        this.observability.record("info", "p3_manual_review", `P3 建议已记录（未自动风险接受，等待人工裁决）：${it.title}（问题 ${it.id}）`);
      }
      created.push({ id: it.id, sev: it.severity, title: it.title });
    }
    return created;
  }

  /**
   * 修复 E4（端到端真跑实测发现，本轮最高危）：返工/门禁统一判定入口。
   *
   * 原实现在 20 处直接对**自由文本**做失败词嗅探，例如
   *   `while (this._needRework(review).needRework && rework < gateLoops)`
   * 这类判定是「否定盲」的：干净产物里一句「命名、分层、异常处理与错误返回符合约定」
   * 就会命中 `/错误/`，被判为「评审未通过」。
   *
   * 端到端实测（software 主路径，mock 让每个角色都输出「逐条自报无问题」的干净产物）：
   *   3 次幻影回退 reviewer→dev（trigger=review_module_fail），frontend 被重跑 4 次、
   *   dev 版本被推高 3 次、global 到 7；第 3 次因 perEdgeBudget(3) 耗尽 → escalated=true，
   *   escalationReason「回退边 reviewer>dev 超单边预算(3/3)，升级人工裁决」。
   *   **一次完全干净的成功运行被升级为「人工裁决」。**
   *
   * 现统一改为读取**结构化判定信号**（与 _parseIssueHints 及角色产物契约一致 ——
   * 各阶段 prompt 明确要求「存在则按 `必须修复：<问题>` 列出」并输出
   * `<阶段>结论：通过/不通过`）：
   *   1) 行首 `必须修复：` / `问题模块：`（P0/P1 硬返工项，经 _parseIssueHints）；
   *   2) `<任意>结论：不通过|未通过|不合格|失败`（显式三态裁决）；
   *   3) 行首 `缺陷：` / `失败项：` / `不通过项：` / `问题项：` / `漏洞：`（显式失败清单）。
   *   4) 独占一行的 `不通过` / `不合格` / `失败`。
   * 说明性叙述（「错误返回」「异常路径」「未发现问题」「无需整改」「无高危漏洞」）不再误判。
   * @returns {{needRework:boolean, reason:string, hints:Array}}
   */
  _needRework(doc) {
    const txt = String(doc ?? "");
    if (txt.trim().length === 0) return { needRework: false, reason: "空产物", hints: [] };
    let hints = [];
    try { hints = this._parseIssueHints(txt); } catch (e) { hints = []; }
    const hard = hints.filter((h) => h.sev <= 1);
    if (hard.length > 0) {
      return { needRework: true, reason: `结构化硬返工项 ${hard.length} 条：${hard.map((h) => h.title).join("；").slice(0, 160)}`, hints };
    }
    const verdict = /^[^\n]{0,16}?结论\s*[:：]\s*(不通过|未通过|不合格|失败)/m.exec(txt);
    if (verdict) return { needRework: true, reason: `显式裁决「…结论：${verdict[1]}」`, hints };
    // 修复第九轮 N2：行首失败清单同样要排除否定写法（「缺陷：无」「问题项：无」「漏洞：未发现」），
    // 并容许列表符号/序号（与 _parseIssueHints 保持一致）。原实现只取第一个匹配、且完全不看冒号后内容。
    const itemRe = /^[ \t]*(?:[-*•·>]+|\d+[.、)])?[ \t]*(缺陷|失败项|不通过项|问题项|漏洞)[ \t]*[:：][ \t]*(.*)$/gm;
    let im = null;
    while ((im = itemRe.exec(txt)) !== null) {
      const body = String(im[2] ?? "").trim();
      if (this._isNegatedFinding(body)) continue;
      return { needRework: true, reason: `显式失败条目「${im[1]}：${body.slice(0, 40)}」`, hints };
    }
    const bare = /^[ \t]*(不通过|不合格|失败)[。.]?[ \t]*$/m.exec(txt);
    if (bare) return { needRework: true, reason: `独占行裁决「${bare[1]}」`, hints };
    return { needRework: false, reason: "无结构化失败信号", hints };
  }

  // ==================== Pipeline ====================

  async _runPipeline(run) {
    console.log("[dsh-leng-team] runPipeline begin");
    // ---- V9.3 前置：任务类型/任务性质识别 + 调查触发评估 + 调查员 + 充分性门禁 + 三方会签 ----
    // 修复第十轮 K-5：taskType.enabled（关闭类型识别）、taskType.intentDetection（关闭意图识别）
    // 此前都是死旋钮（设置里可改、代码从不读）。现接线；未配置时行为与修复前完全一致。
    const ttCfg = this.config.taskType ?? {};
    const replicaCfg = this.config.replicate ?? {};
    const discCfg = this.config.discovery ?? {};
    // 修复第十一轮 K-6：`discoveryTrigger.*` 此前整块是死配置（设置页可改、lib/ 内零消费者，
    // 属第十轮 K-6 判定）。现接线 enabled / mode / threshold / recordSkip / escalation 五键。
    const dtCfg = this.config.discoveryTrigger ?? {};
    run.taskType = detectTaskType(run.goal, { enabled: ttCfg.enabled !== false });
    run.taskMode = detectTaskMode(run.goal, { intentDetection: ttCfg.intentDetection !== false });
    // 领域模板 auto 识别开关（方案 14：autoDetect=false 时使用默认模板）
    if (this.config.domainTemplate && this.config.domainTemplate.autoDetect === false) {
      run.taskType = this.config.domainTemplate.default || "software";
      this.taskType = run.taskType;
    }
    this.taskType = run.taskType;
    this.taskTemplate = templateFor(run.taskType);
    // 修复第十轮 K-5：taskType.replicateKeywords / replicate.forceInvestigation / replicate.depth /
    // replicate.skipAllowed 此前全是死旋钮（设置里可改、代码恒用硬编码 REPLICA_RE + deep + 禁止跳过）。
    // 现把配置派生项传入触发评估；未配置时行为与修复前一致。
    const inv = evaluateInvestigation(run.goal, run.taskType, this.config.discoveryWeights, { // 评分权重来自专家设置（方案 3.3/14）
      replicaRe: buildReplicaRe(ttCfg.replicateKeywords),
      pathPattern: ttCfg.pathPattern, // 第十二轮接线：路径箭头字符集（默认 "source→target"）
      forceInvestigation: replicaCfg.forceInvestigation !== false,
      skipAllowed: replicaCfg.skipAllowed === true,
      replicaDepth: replicaCfg.depth,
      // K-6：discoveryTrigger.threshold（默认 6）= 自动触发的最低评分档；deep 档保证高于它。
      thresholds: (() => {
        const t = Number(dtCfg.threshold);
        if (!Number.isFinite(t)) return undefined;
        const std = Math.min(Math.max(1, Math.round(t)), 10);
        return { standard: std, deep: Math.max(10, std + 1) };
      })(),
      onReplicaDowngrade: (msg) => this.observability.record("warning", "replica_downgraded", msg),
    });
    // 修复第十轮 K-5：discovery.enabled（整段调查可关）/ discovery.skipWhenClear（不允许「目标清晰
    // 即跳过调查」）两键接线。
    // 第十二轮接线 discovery.depth：原默认 "standard" 会把复刻/高风险评估出的 "deep" 降级，属行为变更，
    // 故第十轮列为待裁决。现改为**显式覆盖**语义并新增默认值 "auto"（=沿用决策推导的深度，零行为变更）：
    // 选 light/standard/deep 才覆盖，且覆盖发生在全部决策推导（含 mode=force）之后，即「显式配置最后生效」。
    if (discCfg.enabled === false && inv.decision !== "skip") {
      inv.reason = `调查已按配置关闭（discovery.enabled=false），原触发决策：${inv.decision}`;
      inv.decision = "skip";
      this.observability.record("info", "discovery_disabled", inv.reason);
    } else if (discCfg.skipWhenClear === false && inv.decision === "skip") {
      inv.decision = "auto";
      inv.depth = "light";
      inv.evidenceRequired = false;
      inv.skipAllowed = false;
      inv.reason = "配置不允许「目标清晰即跳过调查」（discovery.skipWhenClear=false），升级为轻量调查";
      this.observability.record("info", "discovery_no_skip", inv.reason);
    }
    // 修复第十一轮 K-6（续）：mode / enabled 两键覆盖触发决策。
    // 未配置时（默认 mode="auto"、enabled=true）此块不产生任何变更，行为与修复前逐字一致。
    const preDecision = inv.decision;
    if (dtCfg.mode === "force") {
      inv.decision = "force";
      inv.depth = "deep";
      inv.evidenceRequired = true;
      inv.skipAllowed = false;
      inv.reason = `配置强制调查（discoveryTrigger.mode=force），原决策：${preDecision}`;
      this.observability.record("info", "discovery_trigger_force", inv.reason);
    } else if (dtCfg.mode === "skip") {
      inv.decision = "skip";
      inv.evidenceRequired = false;
      inv.reason = `配置强制跳过调查（discoveryTrigger.mode=skip），原决策：${preDecision}`;
      this.observability.record("info", "discovery_trigger_skip", inv.reason);
    } else if (dtCfg.enabled === false && inv.decision === "auto") {
      // 关闭「自动触发评估」：评分卡判出的 auto 决策不再调查；领域强制调查（force）与复刻强制保留。
      inv.decision = "skip";
      inv.reason = `自动触发评估已关闭（discoveryTrigger.enabled=false），原决策：${preDecision}`;
      this.observability.record("info", "discovery_trigger_disabled", inv.reason);
    }
    // 第十二轮接线 discovery.depth（默认 "auto"）：显式覆盖调查深度；"auto"/非法值 = 不覆盖。
    // 覆盖只对「确实会执行调查」的决策生效（skip 档覆盖无意义，反而会让留痕误导人）。
    const depthOverride = ["light", "standard", "deep"].includes(String(discCfg.depth ?? "")) ? String(discCfg.depth) : null;
    if (depthOverride && inv.decision !== "skip") {
      if (inv.depth !== depthOverride) {
        this.observability.record("info", "discovery_depth_override", `调查深度按配置覆盖：${inv.depth} → ${depthOverride}（discovery.depth）`);
      }
      inv.depth = depthOverride;
      inv.evidenceRequired = depthOverride !== "light";
    }
    // 第十二轮接线：Discovery.validatorFor 的返回值此前无人消费（#35 声明了「跳过调查时目标校验执行者
    // 按任务类型决定」却从未落地）。现随调查决策进入 run.investigation，作为目标偏离问题的责任角色。
    run.investigation = { decision: inv.decision, reason: inv.reason, replica: inv.replica, taskMode: run.taskMode, depth: inv.depth, score: inv.score ?? null, validator: inv.validator ?? null };
    // 第十二轮接线 replicate.sourceReadonly（默认 true）：复刻类目标把源/目标路径落到 run 上，
    // 供 _runRole 注入「源目录只读」约束并在产物里检测写入意图（软强制，见 _sourceReadonlyNotice）。
    if (inv.replica) run.replicaPaths = { sourcePath: inv.sourcePath ?? null, targetPath: inv.targetPath ?? null };
    // N4 产品经理第一阶段：轻量目标理解（调查前，方案 5.3 两阶段；#1：任务类型识别/调查触发评估已前置到本阶段之前）
    // #2：复刻/迁移/重构/二开类取消产品经理第一阶段（目标明确，调查前无源项目信息无法定义范围/优先级/风险）——直接进入强制调查
    if (!inv.replica) {
      run.stage = "product_light";
      run.productLight = await this._runRole(run, "product", this._contextFor(run, "product") + "\n## 当前阶段：轻量目标理解（调查前第一轮）\n请仅输出：初步目标假设、待调查清单、初步风险、源/目标路径（如为复刻类）、条件启用意见（基于现有信息建议启用哪些条件角色及理由）。不输出最终需求定稿。");
      if (run.cancelled) return;
      // #31/#6：目标假设一致性校验门禁（总指挥执行）：逐条比对产品经理假设与用户原始需求快照；偏离退回重做，二次仍偏离入池 P2 并由最终审核检查
      // 第十二轮 K-12B（幂等性补强）：product_light 阶段被复用时，第 960 行的重算会覆盖从快照
      // 恢复的 goalCheck 对象（连带丢掉 .second 裁决）；先留存再重算，否则「回退重做」会在续跑时白烧一次 product。
      const reusedLight = run.lastRoleReused?.stage === "product_light";
      const priorSecond = reusedLight ? run.goalCheck?.second : null;
      run.goalCheck = this._goalConsistencyCheck(run.goal, run.productLight);
      if (priorSecond) run.goalCheck.second = priorSecond;
      if (!run.goalCheck.ok) {
        if (priorSecond) {
          this.observability.record("info", "goal_check_reuse", "product_light 阶段复用：目标一致性第二轮校验已在崩溃前完成，跳过回退重做（问题池随快照恢复）");
        } else {
          run.productLight = await this._runRole(run, "product", this._contextFor(run, "product") + "\n## 目标假设一致性校验未通过（总指挥裁定）\n你的初步目标假设与用户原始需求快照不一致（偏离项见下）。请逐条对齐原始需求重新输出，禁止引入用户未提出的目标。\n" + JSON.stringify(run.goalCheck));
          if (run.cancelled) return;
          run.goalCheck.second = this._goalConsistencyCheck(run.goal, run.productLight);
          if (!run.goalCheck.second.ok) {
            this.issues.open({ severity: 2, owner: run.investigation?.validator === "design" ? "architect" : "orchestrator", module: "goal_check", title: "目标假设偏离原始需求快照（二次未通过）", evidence: JSON.stringify(run.goalCheck).slice(0, 500) });
            this.observability.record("warning", "goal_check_fail", "目标假设二次校验仍偏离原始需求，已入池 P2（最终审核检查）");
          }
        }
      }
    } else {
      run.productLight = null;
      this.observability.record("info", "product_light_skip", "复刻类取消产品经理第一阶段，直接进入强制调查");
    }
    // 调查阶段（触发/跳过；复刻强制；充分性门禁回环最多 2 轮重调查，超限升级总指挥并留痕）
    let report = null;
    if (inv.decision !== "skip") {
      let invRound = 0;
      const invMaxRounds = Math.max(DISCOVERY_MAX_ROUNDS.min, Math.min(DISCOVERY_MAX_ROUNDS.max, Number(this.config.discovery?.maxRounds) || DISCOVERY_MAX_ROUNDS.default)); // 单一数据源：config.js DISCOVERY_MAX_ROUNDS（3–8 默认 5）
      let invDoc = "";
      do {
        invRound++;
        run.stage = "discovery";
        // 修复第十轮 K-5：把编排器算出的评估结果（含配置派生项）注入调查任务，避免 Discovery
        // 内部重算出与 inv 不一致的决策/深度/范围（此前 brief 的任务头与复刻强制块依据不同）。
        const brief = this.discovery.buildBrief({ eval: inv, goal: run.goal, taskType: run.taskType, replica: inv.replica, sourcePath: inv.sourcePath ?? null, targetPath: inv.targetPath ?? null });
        const gatePrompt = report ? "\n## 上一轮充分性门禁问题清单\n请针对以下问题补充调查（不得省略证据）：\n" + report.problems.map((pp) => `[P${pp.level}] ${pp.text}`).join("\n") : "";
        invDoc = await this._runRole(run, "discovery", brief.brief + gatePrompt);
        if (run.cancelled) return;
        report = this.discovery.createReport(run.goal, inv.decision, brief, invDoc);
        run.investigationReport = report;
        run.investigation.sufficient = report.sufficient;
        // 修复第十轮 K-5：discovery.sufficiencyGate=false 时门禁不阻断（report.sufficient 已由
        // Discovery 置 true），但问题清单必须照常入池——「不阻断」不等于「不记录」。
        if (report.gateResult?.gateDisabled && (report.problems ?? []).length) {
          this.observability.record("warning", "sufficiency_gate_off", "discovery.sufficiencyGate=false：本次不做充分性回环，问题清单直接入池");
          for (const pp of report.problems ?? []) {
            this.issues.open({ severity: pp.level === 1 ? 1 : 3, owner: "discovery", module: "investigation", title: "调查充分性（门禁已关）：" + pp.text, evidence: pp.text });
          }
        }
        if (report.sufficient) {
          // #3：调查充分性门禁审核者=总指挥主审 + 架构师交叉确认（产品经理不当主审，避免用初步假设审核事实调查）
          run.investigation.gateAuditor = "orchestrator+architect_cross";
          break;
        }
        if (invRound < invMaxRounds) {
          this.observability.record("warning", "investigation_reloop", `调查充分性门禁未过（第 ${invRound}/${invMaxRounds} 轮），重调查补充证据`);
        }
      } while (invRound < invMaxRounds);
      if (!report.sufficient) {
        const hasP1 = (report.problems ?? []).some((pp) => pp.level === 1);
        const hasP2 = (report.problems ?? []).some((pp) => pp.level === 2);
        if (!hasP1 && hasP2 && !inv.replica) {
          // #12/#65：调查充分但存在 P2 假设冲突 → 回退产品经理第一阶段重对齐（不升级人工）
          run.investigation.gateEscalated = false;
          this.observability.record("warning", "investigation_p2_only", "调查充分但存在 P2 假设冲突，回退产品经理第一阶段重对齐");
          if (run.productLight) {
            run.productLight = await this._runRole(run, "product", this._contextFor(run, "product") + "\n## 调查报告揭示 P2 假设冲突（见问题清单）\n请基于调查报告修正第一阶段目标假设，重新输出（修正与推翻项必须说明原因，将进入问题池 P2）。\n" + (report.problems ?? []).map((pp) => "[P" + pp.level + "] " + pp.text).join("\n"));
            if (run.cancelled) return;
            run.goalCheck = this._goalConsistencyCheck(run.goal, run.productLight);
          }
        } else {
          run.investigation.gateEscalated = true;
          // 修复第十一轮 K-6（续）：escalation 键接线——作为「超限升级策略」文案进入留痕与问题证据；
          // 仅当策略文案含「通知」时才额外通知父会话，故默认值「人工裁决」下行为与修复前完全一致。
          const escPolicy = String(dtCfg.escalation ?? "").trim();
          const escMsg = "调查充分性门禁回环达上限，升级总指挥裁决：降级为目标校验清单后继续（问题已入池，最终审核检查）" + (escPolicy ? `（超限升级策略：${escPolicy}）` : "");
          this.observability.record("warning", "investigation_insufficient", escMsg);
          if (escPolicy.includes("通知")) this._notifyUser?.(`⚠️ ${escMsg}`);
          for (const pp of report.problems ?? []) {
            this.issues.open({ severity: pp.level === 1 ? 1 : 3, owner: "discovery", module: "investigation", title: "调查充分性：" + pp.text, evidence: pp.text + (escPolicy ? `\n超限升级策略：${escPolicy}` : "") });
          }
        }
      }
    } else {
      // 修复第十一轮 K-6（续）：recordSkip=false 时不再为「跳过调查」写留痕（默认 true，行为不变）。
      if (dtCfg.recordSkip !== false) this.observability.record("info", "investigation_skip", `调查跳过（${inv.reason}）`);
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
    const productDoc = await this._runRole(run, "product", this._contextFor(run, "product")
      + (run.investigationReport ? "\n## 调查报告参考（事实/约束/条件线索）\n" + String(run.investigationReport.content ?? "").slice(0, 3000) : "")
      + (run.productLight ? "\n## 第一阶段假设对账基线（#10/#63）\n逐条对照第一阶段产出，显式说明哪些假设被【确认】【修正】【推翻】；修正与推翻必须给出原因（将进入问题池 P2，最终审核检查）。" : "")
      + "\n## 不做清单（#11/#64）\n复刻/迁移/重构类任务：不做清单必须逐条关联调查报告功能项并说明理由（范围外/成本高/风险高/用户明确不要），不得凭空列出。");
    if (run.cancelled) return;
    run.product = productDoc;
    // 第十二轮 K-12B（幂等性）：product 阶段被复用时不重复入池——该 P2 在崩溃前的运行里
    // 已经开过，而问题池本身随快照恢复，重复执行会产生同一条问题的第二份条目。
    if (run.lastRoleReused?.stage !== "product" && /推翻|修正|不再成立|调整为|作废/i.test(productDoc ?? "")) {
      this.issues.open({ severity: 2, owner: "product", module: "baseline_reconcile", title: "第二阶段对账：第一阶段假设存在修正/推翻", evidence: String(productDoc ?? "").slice(0, 400) });
      this.observability.record("info", "baseline_reconcile", "第二阶段对账发现假设被修正/推翻，已入池 P2（最终审核检查）");
    }

    // Optional manual confirm: requirement drafted
    await this._maybeConfirm(run, "requirement");
    await this._handleRejected(run, "requirement", "product", "product", "## 用户拒绝了需求定稿\n请根据用户拒绝意见重新定义目标/范围/优先级/验收标准（拒绝原因见用户消息）。");

    // Stage 2: analyst (multi-round to user)
    run.stage = "analyst";
    const analystOut = await this._runRole(run, "analyst", this._contextFor(run, "analyst"));
    if (run.cancelled) return;
    run.analyst = analystOut;

    // A 修复：需求定稿确认已在 N8 后完成（仅需求定稿默认人工确认）；分析师细化规格不再重复确认
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
    while (this._needRework(secDoc).needRework && secRework < secReworkMax) {
      secRework++;
      const rb = this._recordRollback(run, { from: "security", to: "architect", node: "architecture" }, "security_blocking");
      if (rb.escalated) secEscalated = true;
      for (const it of secIssues) this.issues.fixing(it.id, "架构按安全整改要求修复（第 " + secRework + " 轮）");
      run.architecture = await this._runRole(run, "architect", this._contextFor(run, "architect") + "\n## 安全整改\n" + secDoc);
      if (run.cancelled) return;
      secDoc = await this._runRole(run, "security", this._contextFor(run, "security") + "\n## 架构已按你的安全整改要求迭代完成\n请复审修正后的架构，确认无遗留「必须修复」问题后，输出「安全确认通过」及最终安全审计报告。");
      if (run.cancelled) return;
      const stillBlocking = this._needRework(secDoc).needRework;
      for (const it of secIssues) {
        this.issues.review(it.id, "安全复审（第 " + secRework + " 轮）");
        if (stillBlocking) this.issues.fail(it.id, "安全复审仍存在必须修复项");
        else this.issues.pass(it.id, "安全复审通过");
      }
      const newBlocking = this._recordIssuesFrom(secDoc, "security", "architecture");
      for (const nb of newBlocking) if (!secIssues.some((x) => x.id === nb.id)) secIssues.push(nb);
    }
    // 回环达上限仍存在必须修复项 → 升级父会话/总指挥
    if (secRework >= secReworkMax && this._needRework(secDoc).needRework) {
      // 修复 E5（端到端实测发现）：原实现无条件先 escalate 再打升级告警，
      // 但 secIssues 可能为空（报告里有返工信号却抽不出结构化条目），
      // 于是「升级总指挥裁决」的告警会在**零条问题被升级**时也出现（幻影升级）。
      // 实测证据：问题池 summary = {total:0, ...}，warnings 里却有
      // "review_escalated: 代码评审回环达上限，升级总指挥裁决"。
      if (secIssues.length > 0) {
        for (const it of secIssues) this.issues.escalate(it.id, "安全必须修复项回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
        this.observability.record("warning", "security_escalated", `安全必须修复项回环达上限（${secIssues.length} 项），升级总指挥裁决`);
      } else {
        this.observability.record("warning", "security_rework_unaccounted", "安全返工信号未落到结构化条目，无法升级（检查报告是否含行首「必须修复：」或「结论：不通过」）");
      }
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
    while (this._needRework(designReview).needRework && designRework < designReworkMax) {
      designRework++;
      this._recordRollback(run, { from: "design_review", to: "ui", node: "ui" }, "design_review_blocking");
      const ds = this._recordIssuesFrom(designReview, "design_review", "design");
      for (const it of ds) this.issues.fixing(it.id, "设计按交叉评审要求整改（第 " + designRework + " 轮）");
      run.ui = await this._runRole(run, "ui", this._contextFor(run, "ui") + "\n## 设计交叉评审整改要求\n" + designReview);
      if (run.cancelled) return;
      designReview = await this._runRole(run, "design_review", this._contextFor(run, "design_review") + "\n## 设计已整改，请复审（输出格式同前）\n" + String(run.ui ?? "").slice(0, 4000));
      if (run.cancelled) return;
      for (const it of ds) {
        if (this._needRework(designReview).needRework) this.issues.fail(it.id, "设计复审仍存在必须修复项");
        else this.issues.pass(it.id, "设计复审通过");
      }
    }
    if (designRework >= designReworkMax && this._needRework(designReview).needRework) {
      // 修复 E5：同安全门禁 —— 空集合不得打出「已升级」告警。
      const dsEsc = this._recordIssuesFrom(designReview, "design_review", "design");
      if (dsEsc.length > 0) {
        for (const it of dsEsc) this.issues.escalate(it.id, "设计评审回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
        this.observability.record("warning", "design_review_escalated", `设计评审门禁回环达上限（${dsEsc.length} 项），升级总指挥裁决`);
      } else {
        this.observability.record("warning", "design_review_rework_unaccounted", "设计评审返工信号未落到结构化条目，无法升级（检查报告是否含行首「必须修复：」或「结论：不通过」）");
      }
    }
    run.designReview = designReview;
    // 设计安全复审
    run.stage = "design_security";
    const designSec = await this._runRole(run, "security", this._contextFor(run, "security") + "\n## 设计安全复审\n复审 UX/UI 设计产物，确认无「必须修复」安全项后输出「设计安全确认通过」；存在则按 `必须修复：<问题>` 列出。");
    if (run.cancelled) return;
    if (this._needRework(designSec).needRework) {
      this._recordRollback(run, { from: "security", to: "ui", node: "ui" }, "design_security_blocking");
      run.ui = await this._runRole(run, "ui", this._contextFor(run, "ui") + "\n## 设计安全复审整改\n" + designSec);
      this.observability.record("warning", "design_security_rework", "设计安全复审存在必须修复项，UI 已按整改重做");
    }
    run.designSecurity = designSec;
    // #36：设计闭环顺序固定为 设计交叉评审 → 设计安全复审 → 设计评审门禁（串行）；
    //   安全复审通过后不重跑交叉评审，除非安全复审要求修改 UX/UI（此时 UX/UI 已按整改重做，见上方整改分支）
    this.observability.record("info", "design_closure", "设计闭环顺序：交叉评审→安全复审→设计评审门禁（#36 串行规则）");
    // 设计评审门禁 + 契约冻结 + Mock（本地门禁节点：记录契约版本，纳入缓存键/回退版本管理）
    run.stage = "design_contract";
    const designGate = {
      passed: !this._needRework(designReview).needRework && !this._needRework(designSec).needRework,
      review: this._needRework(designReview).needRework ? "未通过" : "通过",
      security: this._needRework(designSec).needRework ? "未通过" : "通过",
    };
    run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["design", "designContract"]); // 方案 12：设计契约版本单列
    run.designContract = {
      version: Number(run.versions?.design ?? 1),
      frozenAt: Date.now(),
      frozen: true,
      thawed: false,
      thawConditions: ["回退触发", "人工批准", "设计评审门禁不通过"], // #38：解冻条件（冻结后默认不可修改）
      gate: designGate,
      summary: `契约冻结 v${run.versions?.design ?? 1}：交互契约/组件契约/设计 token/状态机/响应式规则/可访问性基线（设计评审=${designGate.review}，安全=${designGate.security}）`,
    };
    this.observability.record("info", "design_contract", `设计契约冻结 v${run.designContract.version}：评审=${designGate.review} 安全=${designGate.security}`);
    await this._enforceGate(run, "design_gate"); // F13：设计评审门禁真实接入

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
    while (this._needRework(review).needRework && rework < gateLoops) {
      rework++;
      this._recordRollback(run, { from: "reviewer", to: "dev", node: "dev" }, "review_module_fail");
      this.observability.recordRework("(review-loop)");
      // 代码类：全部问题均阻断，修复后必须重新评审（不区分大小问题）
      for (const it of reviewIssues) this.issues.fixing(it.id, "开发按评审要求修复（第 " + rework + " 轮）");
      run.devOutputs = await this._runDevelopment(run, modules, review);
      review = await this._runRole(run, "reviewer", this._contextFor(run, "reviewer") + "\n## 上一轮修复\n" + JSON.stringify(run.devOutputs ?? {}).slice(0, this.config.flow.summaryTokenCap));
      if (run.cancelled) return;
      const stillFailing = this._needRework(review).needRework;
      for (const it of reviewIssues) {
        this.issues.review(it.id, "代码评审复审（第 " + rework + " 轮）");
        if (stillFailing) this.issues.fail(it.id, "评审仍存在问题");
        else this.issues.pass(it.id, "评审通过");
      }
      const nb = this._recordIssuesFrom(review, "reviewer", "code");
      for (const n of nb) if (!reviewIssues.some((x) => x.id === n.id)) reviewIssues.push(n);
    }
    if (rework >= gateLoops && this._needRework(review).needRework) {
      // 修复 E5：空集合不得打出「已升级」告警。
      if (reviewIssues.length > 0) {
        for (const it of reviewIssues) this.issues.escalate(it.id, "代码评审回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
        this.observability.record("warning", "review_escalated", `代码评审回环达上限（${reviewIssues.length} 项），升级总指挥裁决`);
      } else {
        this.observability.record("warning", "review_rework_unaccounted", "代码评审返工信号未落到结构化条目，无法升级（检查报告是否含行首「必须修复：」或「结论：不通过」）");
      }
    }
    run.review = review;
    await this._enforceGate(run, "code_review"); // F13：代码评审门禁真实接入

    // Stage 9: tester (regression loop until clean)
    // 流程规则：测试为代码类环节——发现缺陷后必须返工对应模块并回归测试，
    // 测试通过（无缺陷）后才可进入运维环节。
    run.stage = "test";
    let testDoc = await this._runRole(run, "tester", this._contextFor(run, "tester"));
    let testIssues = this._recordIssuesFrom(testDoc, "tester", "code");
    let testRework = 0;
    while (this._needRework(testDoc).needRework && testRework < gateLoops) {
      testRework++;
      this._recordRollback(run, { from: "tester", to: "dev", node: "dev" }, "test_module_fail");
      this.observability.recordRework("(test-loop)");
      // 代码类：缺陷必须修复 → 评审重新审核 → 回归测试
      for (const it of testIssues) this.issues.fixing(it.id, "开发按缺陷修复（第 " + testRework + " 轮）");
      run.devOutputs = await this._runDevelopment(run, modules, testDoc);
      if (run.cancelled) return;
      testDoc = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 上一轮缺陷修复后回归\n" + JSON.stringify(run.devOutputs ?? {}).slice(0, this.config.flow.summaryTokenCap));
      if (run.cancelled) return;
      const stillFailing = this._needRework(testDoc).needRework;
      for (const it of testIssues) {
        this.issues.review(it.id, "回归测试（第 " + testRework + " 轮）");
        if (stillFailing) this.issues.fail(it.id, "回归测试仍存在缺陷");
        else this.issues.pass(it.id, "回归测试通过");
      }
      const nb = this._recordIssuesFrom(testDoc, "tester", "code");
      for (const n of nb) if (!testIssues.some((x) => x.id === n.id)) testIssues.push(n);
    }
    if (testRework >= gateLoops && this._needRework(testDoc).needRework) {
      // 修复 E5：空集合不得打出「已升级」告警。
      if (testIssues.length > 0) {
        for (const it of testIssues) this.issues.escalate(it.id, "测试回环达上限，升级总指挥裁决（测试模式默认按当前状态继续）");
        this.observability.record("warning", "test_escalated", `测试回环达上限（${testIssues.length} 项），升级总指挥裁决`);
      } else {
        this.observability.record("warning", "test_rework_unaccounted", "测试返工信号未落到结构化条目，无法升级（检查报告是否含行首「必须修复：」或「结论：不通过」）");
      }
    }
    run.test = testDoc;
    await this._enforceGate(run, "test"); // F13：测试门禁真实接入

    // Stage 9.4（第十一轮 K-7 修复）：跨领域条件角色——无障碍专家 / 本地化专家。
    // 修复前：lib/roles.js 声明了这两个条件角色（slotId accessibility/i18n），但 SOFTWARE_DAG
    // 没有承载节点、流水线也没有调用点 → conditionalCandidates() 看不到它们 → 会签单里永远
    // 没有这两个候选 → 运行期不可达（K-7）。现在补上 DAG 节点（N28a/N28b）+ 此处调用点。
    // 仅当三方会签启用（run.enabledSlots 含 slotId）时执行；二者均为技术域候选，
    // 必须由调查线索点名才启用 → **默认不启用，默认行为不变**。
    for (const cd of CROSS_DOMAIN_CONDITIONALS) {
      if (!run.enabledSlots.includes(cd.slotId) || !ROLE_MAP[cd.roleKey]) continue;
      run.stage = cd.roleKey;
      const crossDoc = await this._runRole(run, cd.roleKey, this._contextFor(run, cd.roleKey));
      if (run.cancelled) return;
      if (this._needRework(crossDoc).needRework) {
        this._recordRollback(run, { from: cd.roleKey, to: "ui", node: "ui" }, cd.roleKey + "_blocking");
        run.ui = await this._runRole(run, "ui", this._contextFor(run, "ui") + `\n## 上游整改要求（来自 ${cd.roleName}）\n` + String(crossDoc ?? "").slice(0, 3000));
        if (run.cancelled) return;
        this.observability.record("warning", cd.roleKey + "_rework", cd.roleName + "存在不通过项，已回退 UI 设计整改");
      }
      run[cd.roleKey] = crossDoc;
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, [cd.roleKey]); // 方案 12：条件角色产物版本单列
    }

    // Stage 9.5: 性能/可靠性测试（条件角色启用时执行，方案 10.5 N29）
    if (run.enabledSlots.includes("performance")) {
      run.stage = "performance";
      const perfDoc = await this._runRole(run, "performance", this._contextFor(run, "performance"));
      if (run.cancelled) return;
      if (this._needRework(perfDoc).needRework) {
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
      if (this._needRework(secTestDoc).needRework) {
        this._recordRollback(run, { from: "security_test", to: "dev", node: "dev" }, "security_test_fail");
        run.devOutputs = await this._runDevelopment(run, modules, secTestDoc);
        this.observability.record("warning", "security_test_rework", "安全测试存在不通过项，已回退开发整改");
      }
      run.securityTest = secTestDoc;
      run.versions = this.rollback.bumpVersion(run.versions ?? {}, ["security_test"]); // 方案 12：条件角色产物版本单列
    }

    // Stage 10: ops
    run.stage = "ops";
    run.deployEnv = this._resolveDeployEnv();
    // L1修复：环境适配器降级为 conditional 时走 _conditionalConfirm 通道
    if (run.deployEnv?.conditional) {
      const cc = await this._conditionalConfirm(run, `环境适配器降级为 ${run.deployEnv.adapter}（${run.deployEnv.degraded ? "不可用降级模拟" : "降级"}），需人工确认+风险接受`);
      if (cc?.ok === false) { this._recordRollback(run, { from: "ops", to: "ops", node: "ops" }, "deploy_env_conditional_rejected"); }
    }
    run.ops = await this._runRole(run, "ops", this._contextFor(run, "ops") + "\n## 环境适配\n" + JSON.stringify(run.deployEnv ?? {}));

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
    if (this._needRework(deploySec).needRework) {
      this._recordRollback(run, { from: "security", to: "ops", node: "ops" }, "deploy_security_blocking");
      run.ops = await this._runRole(run, "ops", this._contextFor(run, "ops") + "\n## 部署安全审查整改\n" + deploySec);
      this.observability.record("warning", "deploy_security_rework", "部署安全审查存在必须修复项，运维已按整改重做");
    }
    run.deploySecurity = deploySec;
    // Stage 10.7: 部署验证/冒烟测试（方案 N35，失败按原因回退）
    run.stage = "deploy_verify";
    const deployDoc = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 部署验证/冒烟测试\n按部署文档对部署方案执行冒烟验证：启动、主流程、关键页面/接口可访问。不通过则输出 `测试结论：不通过` 并注明问题模块。");
    if (run.cancelled) return;
    if (this._needRework(deployDoc).needRework) {
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
    if (this._needRework(preSec).needRework) {
      this._recordRollback(run, { from: "security", to: "dev", node: "dev" }, "prelaunch_security_blocking");
      run.devOutputs = await this._runDevelopment(run, modules, preSec);
      this.observability.record("warning", "prelaunch_security_blocking", "上线前安全复查存在必须修复项，已回退开发整改");
    }
    run.prelaunchSecurity = preSec;
    // Stage 11.6: 最终全功能回归测试（方案 N39：未通过不得最终审核）
    run.stage = "final_regression";
    // #39：准生产环境降级——首选真实准生产；不可用时降级本地部署验证（需人工确认+风险接受+最终审核 conditional+禁止进入缓存复用）
    const regEnv = this.config.finalRegression?.environment ?? "准生产";
    run.regressionEnv = regEnv;
    if (regEnv !== "本地" && this.config.finalRegression?.degradeToLocal) {
      run.regressionDegraded = true;
      this.issues.open({ severity: 2, owner: "orchestrator", module: "env_degrade", title: "准生产环境不可用降级本地部署验证", evidence: regEnv });
      this.observability.record("warning", "env_degrade", "准生产环境降级本地部署验证（人工确认+风险接受记录，最终审核标记 conditional，禁止缓存复用）");
      // L2/L3修复：准生产降级走 _conditionalConfirm 通道
      const cc = await this._conditionalConfirm(run, `准生产环境不可用，降级本地部署验证（环境：${regEnv}→本地），需人工确认+风险接受`);
      if (cc?.ok === false) { this._recordRollback(run, { from: "tester", to: "tester", node: "tester" }, "env_degrade_rejected"); }
    }
    const finalReg = await this._runRole(run, "tester", this._contextFor(run, "tester") + `\n## 最终全功能回归测试\n回归环境：${run.regressionEnv}${run.regressionDegraded ? "（已降级本地，标记 conditional）" : ""}；覆盖范围：${this.config.finalRegression?.coverage ?? "全部功能+设计+性能+安全+无障碍+i18n"}；不通过则输出 \`测试结论：不通过\` 并注明问题模块。`);
    if (run.cancelled) return;
    if (this._needRework(finalReg).needRework) {
      // #37：按失败类型定位重跑范围（代码/设计/文档/安全/架构五类，各配独立重跑集合）
      const scope = this._regressionScope(finalReg);
      this.observability.record("warning", "final_regression_fail", "最终全功能回归未通过，影响范围=" + scope + "，回退对应环节重跑");
      this.issues.open({ severity: 1, owner: "tester", module: "final_regression", title: "最终全功能回归未通过（范围=" + scope + "）", evidence: String(finalReg).slice(0, 400) });
      this._recordRollback(run, { from: "tester", to: "dev", node: "dev" }, "final_regression_fail");
      this.observability.recordWhy("final_regression", "最终回归失败回退开发", null);
      run.devOutputs = await this._runDevelopment(run, modules, finalReg);
      this.observability.record("warning", "final_regression_fail", "最终全功能回归未通过，已回退开发整改后重新回归");
      run.finalRegression = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 整改后最终全功能回归\n" + JSON.stringify(run.devOutputs ?? {}).slice(0, 4000));
    } else {
      run.finalRegression = finalReg;
    }
    await this._enforceGate(run, "final_regression"); // F13：最终回归门禁真实接入

    // Stage 12: auditor (final review)
    run.stage = "audit";
    // #47：P3 自动接受抽查（20% 采样，可撤销）——最终审核前执行
    const p3Audit = typeof this.issues.auditP3 === "function" ? this.issues.auditP3() : null;
    if (p3Audit) this.observability.record("info", "p3_audit", `P3 自动接受抽查：${p3Audit.sampled}/${p3Audit.total} 采样`);
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
    // 修复：增加 auditRounds 上限检查，防止无限审核回环
    const maxAuditRounds = this.config.flow.maxRework + 1;
    if ((run.auditRounds ?? 0) >= maxAuditRounds) {
      this.observability.record("warning", "audit_rounds_exhausted",
        `审核回环已达上限（${maxAuditRounds} 轮），升级总指挥裁决，不再重跑`);
      this.issues.escalate(
        this.issues.open({ severity: 1, owner: "auditor", module: "audit", title: "审核回环达上限，需人工裁决", evidence: String(run.audit ?? "").slice(0, 200) })?.id ?? "",
        "审核回环达上限，升级人工裁决"
      );
    } else {
      run.auditRounds = (run.auditRounds ?? 0) + 1;
    }
    // V9.3 独立复验：三态结论（pass/conditional/fail）+ 盲审 + 反方质询
    const verRec = this.verification.createRecord(run.goal, run.audit);
    run.verification = verRec;
    const gateResult = this.verification.gate(verRec.conclusion, run.audit);
    if (gateResult.needRework && (run.auditRounds ?? 0) <= this.config.flow.maxRework + 1) {
      console.log(`[dsh-leng-team] 审核不合格：${gateResult.reason} → 回退重跑环节 ${gateResult.rework.join(",")}`);
      this._recordRollback(run, { from: "auditor", to: gateResult.rework[0] ?? "ui", node: gateResult.rework[0] ?? "ui" }, "audit_fail");
      this.observability.record("warning", "audit_rework", `${gateResult.reason} → 重跑 ${gateResult.rework.join(",")}`);
      // 修复 F19：原实现先用 run[rk] 跑一遍（对 architect/reviewer/tester/auditor 写入了
      // 幻影字段 run.architect/run.reviewer/run.tester/run.auditor），随后又用 PROP 映射
      // 把同一角色再跑一遍，导致状态污染 + 双倍 LLM 开销。此处只保留 PROP 映射这一次执行。
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

    // F13：交付前最后一道门禁——P0/P1 未关闭阻断项必须在交付前处置或风险接受
    await this._enforceGate(run, "final_audit");
    // F17：最终审核通过后把风险接受项归档关闭（RISK_ACCEPTED → CLOSED），
    //      使问题池关闭态可达，并让 close() 具备真实调用点。
    try {
      for (const i of [...this.issues.issues.values()]) {
        if (i.status === "RISK_ACCEPTED") this.issues.close(i.id);
      }
      this.observability.record("info", "issues_archived", `风险接受项已归档关闭：${this.issues.summary().closed}/${this.issues.summary().total}`);
    } catch (e) { /* ignore */ }
    run.stage = "done";
    this.observability.record("info", "complete", "全链路完成");
    try { this.observability.record("info", "acceptance", "可量化验收指标: " + JSON.stringify(this.acceptanceSnapshot())); } catch (e) { /* ignore */ }
    // 修复复刻交付物不可用：流水线完成后汇总磁盘文件清单并通知用户项目位置。
    try { this._notifyProjectDelivery(run, "software"); } catch (e) { /* ignore */ }
    this._snapshot();
    this._emit();
  }

  // 审核判定已由 verification.gate（独立复验三态）接管，_auditGate 已删除（V9.3）。

  /** 非 software 领域流水线（data_analysis/research/content/document/generic，方案 2.4–2.6）。
   *  链：产品两阶段 → 领域方案设计（含评审/验证职责）→ 条件领域角色 → 领域执行（可并行拆分）→ 文档 → 最终审核。 */
  async _runDomainPipeline(run) {
    const exec = DOMAIN_EXEC[run.taskType] ?? {};
    const designKey = exec.designKey ?? "architect";
    const execRoleKey = exec.roleKey ?? "docs";
    // 修复第十轮 K-3：任务类型未在 DOMAIN_EXEC 声明时，此前静默回落到「前端开发工程师」——
    // 实测非软件类产物（实验室危化品管理制度、都市温情短篇小说）由前端角色的人格与工具白名单
    // 产出。现回落通用执行角色「文档工程师」，并把「未声明」这件事显式记进可观测性，
    // 便于二次开发补齐 DOMAIN_EXEC 声明而不是靠猜。
    if (!DOMAIN_EXEC[run.taskType]) {
      try { this.observability.record("warning", "domain_exec_fallback", `任务类型「${run.taskType}」未在 DOMAIN_EXEC 声明专用角色，回退 designKey=architect / roleKey=docs（建议为该类型补充声明）`); } catch (e) { /* ignore */ }
    }
    // 产品经理第二阶段：调查后正式定义
    run.stage = "product";
    const productDoc = await this._runRole(run, "product", this._contextFor(run, "product") + (run.investigationReport ? "\n## 调查报告参考（事实/约束/条件建议）\n" + String(run.investigationReport.content ?? "").slice(0, 3000) : ""));
    if (run.cancelled) return;
    run.product = productDoc;
    await this._maybeConfirm(run, "requirement");
    await this._handleRejected(run, "requirement", "product", "product", "## 用户拒绝了需求定稿\n请根据用户拒绝意见重新定义目标/范围/优先级/验收标准。");
    // 修复第九轮 N5：域路径此前只接 requirement/final 两个人机确认点，
    // `_maybeConfirmQuestions`/`_maybePlanSelect` 仅被软件路径调用 → data_analysis/research/
    // content/fiction/document/generic 六种任务类型永远不会把「需求疑问」「多套实现方案」
    // 输出到父会话，直接违反第九轮「需要用户确定方案/方向时父会话必须输出供选择」的要求。
    // 域路径无 analyst 角色，疑问/方案正文以 product 定稿为来源（见两个函数内的读取源改动）。
    if (run.cancelled) return;
    await this._maybeConfirmQuestions(run);
    if (run.cancelled) return;
    // 领域方案设计（方案设计 + 结构评审 + 一致性验证职责）
    run.stage = "domain_design";
    run.domainDesign = await this._runRole(run, designKey, this._contextFor(run, "domain_design"));
    if (run.cancelled) return;
    // 修复第九轮 N5：方案选择必须发生在**领域设计产出之后**——「多套实现方案」出自设计稿
    // （软件路径同理：analyst 出方案后才问）。放在需求定稿之后会让读取源只能看到 PRD 而恒跳过。
    await this._maybePlanSelect(run);
    if (run.cancelled) return;
    // 条件领域角色（统计/数据伦理/领域专家/SEO/视觉）
    // 第十一轮 K-7：领域路径同样承载跨领域条件角色（accessibility / i18n），
    // 否则它们在 data_analysis/research/content/document/fiction/generic 路径下仍不可达。
    for (const cond of [...(exec.conditionals ?? []), ...CROSS_DOMAIN_CONDITIONALS]) {
      if (run.enabledSlots.includes(cond.slotId) && ROLE_MAP[cond.roleKey]) {
        run.stage = "cond_" + cond.roleKey;
        const out = await this._runRole(run, cond.roleKey, this._contextFor(run, "domain_conditional") + "\n## 上游方案\n" + String(run.domainDesign ?? "").slice(0, 4000));
        if (run.cancelled) return;
        run["cond_" + cond.roleKey] = out;
      }
    }
    // 修复 G1（第八轮全覆盖真跑实测发现）：域路径原本**一个门禁都没有**，软件主路径有 5 个
    // （design_gate / code_review / test / final_regression / final_audit）。实测域路径零交付时
    // _runDevelopment 会开出 P0「开发阶段零交付」，却没有任何门禁接管它 —— 不阻断、不升级人工
    // 裁决、不冻结新任务，只在最终报告里留一条 OPEN P0。现按软件主路径同构补 3 个门禁。
    await this._enforceGate(run, "domain_design_gate");
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
    while (this._needRework(reviewDoc).needRework && domainRework < this.config.flow.maxRework) {
      domainRework++;
      this._recordRollback(run, { from: designKey, to: "exec", node: "exec" }, "review_fail");
      for (const it of this._recordIssuesFrom(reviewDoc, designKey, "domain")) this.issues.fixing(it.id, "领域执行按评审要求整改（第 " + domainRework + " 轮）");
      run.domainOutputs = await this._runDevelopment(run, modules, reviewDoc, execRoleKey);
      if (run.cancelled) return;
      reviewDoc = await this._runRole(run, designKey, this._contextFor(run, "domain_design") + "\n## 上一轮整改后复评\n" + JSON.stringify(run.domainOutputs ?? {}).slice(0, 6000));
      if (run.cancelled) return;
    }
    // G1 补齐（第八轮）：这一处才是实战中接住「域路径零交付 P0」的门禁 —— domain_exec 先执行，
    // 若 _runDevelopment 开出 P0，领域评审阶段会照常跑完（P0 并不阻断角色执行），必须在这里拦住，
    // 否则流程会带着一个未关闭的 P0 一路走到最终审核，并对外报告「完成」。
    await this._enforceGate(run, "domain_review_gate");
    // 文档汇总
    run.stage = "docs";
    run.docs = await this._runRole(run, "docs", this._contextFor(run, "docs"));
    // 最终全功能回归验证（方案 5.5：领域模板亦含最终回归验证节点；未通过不得进入最终审核）
    run.stage = "final_regression";
    let domainReg = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 最终全功能回归验证\n请对全部领域产物做最终全功能回归验证，输出 `回归结论：通过/不通过`；不通过时逐条列出问题。\n" + JSON.stringify(run.domainOutputs ?? {}).slice(0, 6000));
    if (run.cancelled) return;
    run.domainRegression = domainReg;
    let domainRegRework = 0;
    while (this._needRework(domainReg).needRework && domainRegRework < this.config.flow.maxRework) {
      domainRegRework++;
      this._recordRollback(run, { from: "tester", to: "exec", node: "exec" }, "final_regression_fail");
      for (const it of this._recordIssuesFrom(domainReg, "tester", "domain")) this.issues.fixing(it.id, "领域最终回归整改（第 " + domainRegRework + " 轮）");
      run.domainOutputs = await this._runDevelopment(run, modules, domainReg, execRoleKey);
      if (run.cancelled) return;
      domainReg = await this._runRole(run, "tester", this._contextFor(run, "tester") + "\n## 整改后最终回归复验\n" + JSON.stringify(run.domainOutputs ?? {}).slice(0, 6000));
      if (run.cancelled) return;
    }
    // G1 补齐（第八轮）：进入最终审核前最后一次关门 —— 与软件主路径 final_audit 门禁同构，
    // 保证任何未关闭的 P0/P1 在最终裁决前都经过一次阻断/升级人工处置。
    await this._enforceGate(run, "domain_final_regression_gate");
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
      // 修复 H6（第八轮全覆盖真跑实测发现）：审核整改阶段必须把**本轮审核整改要求**交给
      // 执行角色（与软件主路径 7 处 _runDevelopment(..., <本轮失败文档>) 的语义一致）。
      // 原实现传的是上一轮领域评审 reviewDoc —— _runDevelopment 会据此提取「问题模块」
      // 做精准返工，等于按旧账返工、完全看不到最终审核提出的要求。
      run.domainOutputs = await this._runDevelopment(run, modules, gateResult.reason, execRoleKey);
      if (run.cancelled) return;
      run.docs = await this._runRole(run, "docs", this._contextFor(run, "docs"));
      run.audit = await this._runRole(run, "auditor", this._contextFor(run, "auditor") + "\n## 上一轮审核整改已完成，请复核\n" + gateResult.reason.slice(0, 1200));
    }
    run.stage = "done";
    this.observability.record("info", "complete", `领域流水线完成（${run.taskType}，执行角色=${execRoleKey}，拆分=${exec.splitDimension ?? "module"}）`);
    try { this._notifyProjectDelivery(run, run.taskType); } catch (e) { /* ignore */ }
    this._snapshot();
    this._emit();
  }
  /** V9.3 全局回退预算记录：计数 + 版本递增 + 下游 stale + 升级观测。 */
  /** #22：写锁——串行化快照/销毁/席位/状态变更（看门狗销毁前必须先获取写锁再落快照再销毁）。 */
  _withLock(fn) {
    const run = this._lockChain.then(fn, fn);
    this._lockChain = run.then(() => {}, () => {});
    return run;
  }

  _recordRollback(run, edge, trigger) {
    const res = this.rollback.record(edge, edge.node, `${edge.from}→${edge.to}`, trigger);
    run.versions = this.rollback.bumpVersion(run.versions ?? {}, [edge.node, edge.from, edge.to]);
    const stale = this.rollback.markStale({ dev: ["reviewer", "tester", "ops", "docs"], architecture: ["security", "ux", "ui", "dev"], ui: ["dev"], product: ["analyst", "architect"] }, edge.node);
    if (res.escalated) {
      this.observability.record("warning", "rollback_escalated", res.reason);
      this.recordResult(`回退预算升级人工裁决：${res.reason}`);
      // 修复第十一轮 M6：lib/config.js:506 的 label 承诺「达到即强制人工裁决并通知父会话」，
      // 但原实现只留痕、从不通知（第十轮实测 budgetUsed 17/2 而父会话零通知）。
      // 现按回退节点去重通知一次，并把可选动作一并给出；**不改变回退控制流**（预算仍非硬停机上限）。
      const bk = edge.node ?? edge.from;
      if (!this._rollbackBudgetNotified.has(bk)) {
        this._rollbackBudgetNotified.add(bk);
        this._notifyUser?.(`⚠️ 回退预算已达上限（${bk}）：${res.reason}\n可选：1) 继续（风险由最终审核标记）；2) /team rollback 人工指定回退点；3) /team pause 暂停后人工修复。`);
      }
    }
    this.observability.record("info", "rollback", `回退 ${edge.from}→${edge.to}（${trigger}）预算=${res.usedBudget}/${this.rollback.totalBudget} stale=${stale.length ? stale.join(",") : "无"}`);
    this.observability.recordWhy("rollback:" + trigger, edge.from + "→" + edge.to, res.issueId ?? null);
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

    // ---- 第十二轮 K-12B：断点续跑的阶段级复用 ----
    // 恢复态下，若本阶段在崩溃前已完成、快照里留着合法产物，则直接复用，不再调用 Agent。
    // 声明面见 lib/stage-reuse.js（唯一数据源），校验见 scripts/check-declarations.mjs。
    // 安全门（缺一不可）：① 本次运行来自快照恢复；② flow.stageReuse 未被显式关闭（默认开）；
    // ③ 本阶段已声明可复用；④ 同一阶段在一次续跑里只尝试一次；
    // ⑤ 本阶段不是崩溃时正在执行的那个阶段（该阶段产物不完整，必须重跑）。
    const srCfg = this.config.flow ?? {};
    run.lastRoleReused = null;
    const srEntry = run?.restored && srCfg.stageReuse !== false ? STAGE_REUSE[String(run.stage ?? "")] : null;
    if (srEntry && run.stageReuseUsed?.[run.stage] !== true && run.restoredInflight !== run.stage) {
      run.stageReuseUsed = run.stageReuseUsed ?? {};
      run.stageReuseUsed[run.stage] = true;
      const roleOk = srEntry.role === "*" || srEntry.role === roleKey;
      const saved = run[srEntry.field];
      if (roleOk && typeof saved === "string" && this._isValidRoleOutput(saved, roleKey)) {
        run.lastRoleReused = { stage: run.stage, role: roleKey, field: srEntry.field };
        this.observability.record("info", "stage_reuse", `阶段 ${run.stage}（${srEntry.label}）复用断点前产物，跳过 Agent 调用`);
        this._setTask(`${roleKey}:${run.id}`, roleKey, null, "finished", []);
        return saved;
      }
      if (roleOk && typeof saved === "string" && saved.length > 0) {
        this.observability.record("warning", "stage_reuse_invalid", `阶段 ${run.stage}（${srEntry.label}）快照产物未通过有效性校验，改为真实执行`);
      }
    }

    // 第十二轮接线 replicate.sourceReadonly（默认 true）：复刻类目标向每个角色的任务上下文注入
    // 「源目录只读」约束。软强制（提示注入 + 产物写入意图检测）；编排器无法系统级拦截子 Agent 的
    // 文件操作，这一点在 README/报告里如实标注，不假装是硬隔离。
    const roNotice = this._sourceReadonlyNotice(run);
    if (roNotice && run.replicaPaths && run.replicaPaths.noticeRecorded !== true) {
      run.replicaPaths.noticeRecorded = true;
      this.observability.record("info", "source_readonly_notice", `已注入源目录只读约束（源目录 ${run.replicaPaths.sourcePath}${run.replicaPaths.targetPath ? `，目标目录 ${run.replicaPaths.targetPath}` : ""}）`);
    }
    const effectiveContext = roNotice ? `${context}\n\n${roNotice}` : context;

    const taskId = `${roleKey}:${run.id}`;
    console.log(`[dsh-leng-team] role ${roleKey} 开始 @${run.id} ctx=${String(context ?? "").slice(0, 40)}`);
    this._setTask(taskId, roleKey, null, "running", []);

    let output = "";
    const maxAttempts = 5;
    // 第十一轮 K-15 接线：roleBoundary.* 此前是「设置页能改、代码零消费者」的空开关。
    // 默认 true，故默认行为与接线前逐字一致。
    const rbCfg = this.config.roleBoundary ?? {};
    let attemptContext = effectiveContext;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      output = await this._dispatchAgent(taskId, roleKey, buildRolePrompt(this._personaFor(roleKey)), attemptContext, {
        onOutput: (text) => this.watchdog.recordOutput(taskId, text),
      });
      console.log(`[dsh-leng-team] role ${roleKey} 尝试${attempt} 输出长度=${String(output ?? "").length} 开头=${JSON.stringify(String(output ?? "").trim().slice(0, 120))}`);
      if (this._isValidRoleOutput(output, roleKey)) {
        this._detectSourceWrite(run, roleKey, output); // 第十二轮：复刻类源目录写入意图检测（软强制）
        const okB = rbCfg.forceNonResponsibilities === false ? true : this._checkBoundaryDeclaration(roleKey, output);
        if (!okB) {
          const bIss = this.issues.open({ severity: 2, title: `角色 ${roleKey} 输出缺少边界声明（已履行职责/已遵守边界）`, evidence: "boundary_missing" });
          if (bIss && rbCfg.crossRoleReport !== false) this.issues.escalate(bIss.id, `边界声明缺失 P2：角色 ${roleKey} 未声明已履行职责/已遵守边界`);
        }
        break;
      }
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
    // 修复第十一轮 K-12（方案 C）：断点恢复（run.restored）且非返工重跑时，
    // 跳过「产物有效且此前已交付」的模块，避免把已交付模块整批重跑（第十轮实测恢复后仍全量重跑，
    // 「续跑」省不下任何 token）。
    if (run.restored && !reviewFeedback) {
      // dag 状态仅在快照 stage==="dev" 时由 _restore 重建队列条目；delivered 产物回填已改为无条件，
      // 因此这里同时接受「dag finished」与「队列中已标记 finished」两种来源，避免续跑时复用条件永不成立。
      const finishedInQueue = new Set((this.queue ?? []).filter((q) => q?.status === "finished").map((q) => q.taskId ?? q.id));
      // 修复第十二轮 K-17：领域流水线的模块产物落在 run.domainOutputs（software 落在 run.devOutputs），
      // 按是否传入 execRoleKey 选择产物仓；否则领域（非 software）续跑的复用条件恒不成立。
      const priorStore = execRoleKey ? (run.domainOutputs ?? {}) : (run.devOutputs ?? {});
      const cand = runModules.filter((m) => this._isValidModuleOutput(priorStore[m.id])
        && (this.dag.get(m.id)?.status === "finished" || finishedInQueue.has(m.id)));
      // 安全性前提：续跑会重跑前序设计环节。只有基线与恢复时刻逐字一致时才复用旧模块产物，
      // 否则（规格可能已变）不复用并说明原因——宁可不省 token，也不能交付与设计不符的模块。
      const baselineNow = [run.product, run.analyst, run.architecture, run.security, run.ux, run.ui].map((x) => String(x ?? "")).join("\u0001");
      const baselineSame = typeof run.restoredBaseline === "string" && run.restoredBaseline === baselineNow;
      const reusable = baselineSame ? cand : [];
      if (!baselineSame && cand.length > 0) {
        this.observability.record("warning", "dev_module_reuse_skipped", `前序设计基线在续跑中已变化，未复用已交付模块（${cand.length} 个：${cand.map((m) => m.id).join(",")}）`);
      }
      if (reusable.length > 0) {
        const reuseIds = new Set(reusable.map((m) => m.id));
        runModules = runModules.filter((m) => !reuseIds.has(m.id));
        // 关键：必须把复用模块的产物写回 dag（stage 非 dev 时 _restore 不会重建 dag），
        // 否则下方交付收集循环读到 this.dag.get(m.id) 为 undefined → devOutputs[m.id]=null →
        // 被计入 invalidCount 与 K-9 的 failedMods，把「复用成功」误报成「模块交付失败」。
        for (const m of reusable) {
          const t = this.dag.get(m.id) ?? { id: m.id, role: m.role, module: m.module, status: "finished", deps: [], output: null, rework: 0 };
          t.status = "finished";
          t.output = priorStore[m.id];
          t.restoredReuse = true;
          this.dag.set(m.id, t);
        }
        this.observability.record("info", "dev_module_reuse", `断点续跑复用已完成模块 ${reusable.length}/${modules.length}：${reusable.map((m) => m.id).join(",")}`);
      }
    }
    // Enqueue module tasks (they share the global seat pool)
    const tasks = [];
    // 第十一轮 K-15 接线：cost.reuseModules（默认 true）门住模块级缓存的读与写（此前该键零消费者）。
    const reuseModulesOn = this.config.cost?.reuseModules !== false;
    const execRole = execRoleKey ?? null;
    for (const m of runModules) {
      const taskId = m.id;
      const role = execRole ?? m.role;
      const ck = this.splitter.cacheKey(m, run.versions ?? {}, { taskType: run.taskType, depth: run.investigation?.depth });
      const cacheKey = ck ? ck.key : null;
      // 第十一轮 K-15 接线：cost.reuseModules 此前零消费者，模块级缓存始终生效；默认 true 行为不变。
      if (reuseModulesOn && cacheKey && this.moduleCache.has(cacheKey) && !reworkIds.has(m.id)) {
        // module-level cache reuse（返工模块强制重跑，绕过旧缓存；版本不匹配则键不同，不会复用）
        tasks.push({ id: taskId, module: m, output: this.moduleCache.get(cacheKey), cached: true });
        this.observability.recordCache(role, m.module, true, cacheKey, "版本一致命中");
        continue;
      }
      if (cacheKey && this.config.cacheKey?.recordMiss) {
        this.observability.recordCache(role, m.module, false, cacheKey, "版本不匹配/无缓存，失效重建");
      }
      // 修复 E1（端到端真跑实测发现）：原实现把依赖硬编码为
      //   depends: [`ui:${run.id}`, `architect:${run.id}`]
      // 但领域模板（generic / document / data_analysis / research / content 等）
      // 走 _runDomainPipeline 时由 DOMAIN_EXEC 决定 designKey，**根本没有 ui 角色节点** ——
      // this.dag.get("ui:run-1") 恒为 undefined，而 _drainQueue 的判定是
      // `this.dag.get(d)?.status !== "finished"`，对 undefined 恒真 → 依赖永远无法满足。
      // 实测后果（goal=「做一个待办事项应用：…」判为 generic → 领域主路径）：
      // 0 个模块被调度，queue_timeout ×2 + dev_no_progress ×30，
      // 最终 dev_global_timeout（1800000ms）强制结束，devOutputs={} 仍报 complete。
      // 现只把「DAG 中真实存在」的节点作为依赖（software 主路径下有 ui/architect，语义不变；
      // 领域路径下不再引入幻影依赖）。
      const deps = [`ui:${run.id}`, `architect:${run.id}`].filter((d) => this.dag.has(d));
      this._setTask(taskId, role, m.module, "queued", deps);
      this.queue.push({
        taskId,
        role,
        module: m.module,
        type: m.type,
        priority: 3, // 执行类模块任务 P3（方案 9.4 席位优先级）
        depends: deps,
        status: "queued",
        createdAt: Date.now(),
      });
      tasks.push({ id: taskId, module: m, output: null });
    }
    this._emit();

    // Drain until every module task is finished
    // 修复：增加全局超时（默认 30 分钟可配）+ 单任务超时，防止无限循环
    const startedAt = Date.now();
    const devGlobalTimeout = this.config.flow.devTimeoutMs ?? 1800000; // 默认 30 分钟
    const taskTimeoutMs = this.config.flow.taskTimeoutMs ?? 300000; // 默认 5 分钟
    let lastProgressAt = Date.now();
    while (this.queue.some((q) => q.status === "queued" || q.status === "running")) {
      if (this.paused) {
        // 修复第九轮 R4：看门狗 pause 策略带自动恢复期限，到期即解除暂停继续推进
        // （原实现置上 paused 后除人工 /team resume 与门禁超时外没有任何自动清除路径）。
        if (this.pausedUntil && Date.now() > this.pausedUntil) {
          this.paused = false;
          this.pausedUntil = 0;
          this.observability.record("warning", "pause_auto_resume", "暂停已达自动恢复期限，流水线继续推进");
          this._notifyUser(run, "⏱ 暂停已达自动恢复期限，流水线已自动继续。如需再次暂停请回复 /team pause。");
          continue;
        }
        await this._sleep(500);
        // 修复第九轮 R2：原实现写死 3600000 绕过用户配置的 devTimeoutMs，两个上界语义不一致
        // （用户调小 devTimeoutMs 时暂停分支不生效）。现统一用 devGlobalTimeout。
        if (Date.now() - startedAt > devGlobalTimeout) {
          this.observability.record("warning", "dev_paused_timeout", `开发阶段暂停等待超过 devTimeoutMs（${devGlobalTimeout}ms），强制结束`);
          break;
        }
        continue;
      }
      // 全局超时熔断
      if (Date.now() - startedAt > devGlobalTimeout) {
        this.observability.record("warning", "dev_global_timeout", `开发阶段全局超时（${devGlobalTimeout}ms），强制结束`);
        break;
      }
      // 单任务超时熔断：检查是否有任务长时间处于 running 状态
      for (const q of this.queue) {
        if (q.status === "running") {
          const t = this.dag.get(q.taskId);
          const started = t?.startedAt ?? q.createdAt;
          if (Date.now() - started > taskTimeoutMs) {
            this.observability.record("warning", "task_timeout", `任务 ${q.taskId} 超时（${taskTimeoutMs}ms），标记为错误`);
            q.status = "error";
            if (t) { t.status = "error"; t.output = null; }
          }
        }
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
      // 无进展检测：连续 5 轮无进展则告警
      if (!advanced) {
        if (now - lastProgressAt > 60000) {
          this.observability.record("warning", "dev_no_progress", "开发阶段连续 1 分钟无进展，可能卡死");
          lastProgressAt = now;
        }
      } else {
        lastProgressAt = now;
      }
    }

    // Collect outputs（校验全部有效后才允许进入评审/测试）
    const outputs = {};
    let invalidCount = 0;
    for (const m of modules) {
      const t = this.dag.get(m.id);
      outputs[m.id] = t?.output ?? null;
      if (!this._isValidModuleOutput(outputs[m.id])) invalidCount += 1;
      const ck2 = this.splitter.cacheKey(m, run.versions ?? {}, { taskType: run.taskType, depth: run.investigation?.depth });
      const cacheKey2 = ck2 ? ck2.key : null;
      if (reuseModulesOn && cacheKey2 && t?.output && this._isValidModuleOutput(t.output)) {
        this.moduleCache.set(cacheKey2, t.output);
        this.observability.recordCache(execRole ?? m.role, m.module, true, cacheKey2, "产物写入缓存");
      }
    }
    console.log(`[dsh-leng-team] dev 全部模块交付完成 total=${modules.length} valid=${modules.length - invalidCount} invalid=${invalidCount}`);
    // 修复 E3（端到端真跑实测发现）：原实现对「开发阶段是否真的交付了模块」**没有任何守卫**。
    // 实测（generic 主路径，goal=「做一个待办事项应用：…」）：唯一模块因幻影依赖从未被调度，
    // devOutputs={}（零交付），docs 角色的上下文里直接是「## 开发产物\n{}」，
    // 流水线照常走 domain_review → docs → final_regression → audit，
    // auditor 判「合格」→ 最终 status:"complete"、stage:"done"、_summarize 显示「完成 (0 个模块)」。
    // 零交付必须显式记账：记异常 + 开 P0（severity 0，与 _needRework/_enforceGate 同一条判定链），
    // 并由 start()/ _summarize 据此把最终结论降级，绝不报「完成」。
    {
      const total = modules.length;
      const valid = total - invalidCount;
      // 修复第十轮 K-9（端到端真跑实测发现）：原判定只看「全量为零」。
      // 用 E2E_THROW_ROLE=frontend 让前端模块子会话**全部启动失败**后实测：4 个前端模块终点 status="error"、
      // output=null、observability 记 module_error 16 条、recordRework 16 条，但后端 3 个模块有效交付 →
      // valid>0 → 走 else 分支 run.delivered=true → 最终 status:"complete"、问题池 total=0（P0/P1 皆 0），
      // 即「整条角色线（前端）零交付」被静默报成成功。_runModuleTask 的 catch（:1926-1939）只记异常与返工，
      // 既不问题入池也不参与门禁/人工升级，故这里必须补「部分模块终态失败」的记账。
      const failedMods = modules.filter((m) => this.dag.get(m.id)?.status === "error");
      const failedNames = failedMods.map((m) => m.module ?? m.id);
      run.devDelivery = { total, valid, invalid: invalidCount, failed: failedNames };
      if (total > 0 && valid === 0) {
        run.delivered = false;
        this.observability.recordAnomaly("dev_no_delivery", `开发阶段零交付：${total} 个模块全部未产出有效实现（invalid=${invalidCount}）`);
        try {
          this.issues.open({
            severity: 0,
            owner: execRole ?? "",
            module: (modules[0]?.module ?? "").slice(0, 60),
            title: "开发阶段零交付：全部模块未产出有效实现",
            evidence: `共 ${total} 个模块，有效产物 0 个。模块清单：${modules.map((m) => m.module ?? m.id).join("、").slice(0, 400)}`,
          });
        } catch (e) { console.log("[dsh-leng-team] dev_no_delivery 记账失败", String(e)); }
      } else if (failedMods.length) {
        // 部分模块终态失败（含「整条角色线全失败」）：不得以「完成」收尾，且必须问题入池供门禁/父会话处置。
        run.delivered = false;
        this.observability.recordAnomaly("dev_module_failed", `模块开发失败未交付：${failedMods.length}/${total}（${failedNames.join("、").slice(0, 300)}）`);
        try {
          this.issues.open({
            severity: 1,
            owner: execRole ?? "",
            module: (failedNames[0] ?? "").slice(0, 60),
            title: `模块开发失败未交付：${failedMods.length}/${total} 个模块（含整条角色线失败的情况）`,
            evidence: `失败模块：${failedNames.join("、").slice(0, 400)}；失败模块均已用尽返工次数（maxRework=${this.config.flow?.maxRework}），终点 status="error"、无有效产物，但流水线仍在推进。`,
          });
        } catch (e) { console.log("[dsh-leng-team] dev_module_failed 记账失败", String(e)); }
      } else {
        run.delivered = true;
      }
    }
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
        // 修复 E2（端到端真跑实测发现）：原实现只调 _setTask 改 DAG，**没有更新队列条目本身**，
        // q.status 仍为 "queued"，而 _runDevelopment 的等待循环条件正是
        // `while (this.queue.some((q) => q.status === "queued" || q.status === "running"))`
        // → 该条目永远满足条件 → 开发阶段空转到 devGlobalTimeout（默认 1800000ms = 30 分钟）
        // 才被强制结束（实测：queue_timeout ×2 + dev_no_progress ×30 + dev_global_timeout），
        // 且条目永久残留队列。依赖已判定不可满足，必须落到非 queued/running 的终态。
        q.status = "blocked";
        this._setTask(q.taskId, q.role, q.module, "blocked", q.depends);
        continue;
      }
      // schedule
      const seat = this._nextFreeSeat();
      this.seats.set(seat, { taskId: q.taskId, role: q.role, module: q.module, startedAt: Date.now(), priority: q.priority ?? 3, status: this.SEAT_STATES.OCCUPIED, rev: Date.now() }); // #23：席位版本号（防覆盖）
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
    // 修复 H3（第八轮全覆盖真跑实测发现）：领域主路径（_runDomainPipeline）从不写
    // run.architecture / run.ui —— 它的方案产物叫 run.domainDesign。原实现把这两个字段
    // 直接拼进执行子任务的上下文，于是域路径的执行角色收到的「架构」「设计」两节**全空**，
    // 而被拆分的那个产物（run.domainDesign）根本没送到执行者手里，
    // 执行角色只拿到「目标 + 模块名」就开工。现按字段可用性回落：
    //   架构：run.architecture（软件路径）→ 无
    //   设计：run.ui（软件路径） → run.domainDesign（领域路径）
    // 两节皆空时整段省略，不留空标题。软件路径两者都在，输出与修复前逐字节一致。
    const cap = this.config.flow.summaryTokenCap;
    const archText = String(run?.architecture ?? "").trim();
    const designText = String(run?.ui ?? "").trim() || String(run?.domainDesign ?? "").trim();
    const designPart =
      (archText ? `## 架构\n${archText.slice(0, cap)}\n\n` : "") +
      (designText ? `## 设计\n${designText.slice(0, cap)}\n\n` : "");
    // 修复复刻交付物不可用：注入输出目录 + 文件清单报告要求 + 源目录只读约束。
    const outDir = run?.outputDir ?? "";
    const roNotice = this._sourceReadonlyNotice(run);
    const isDevRole = (q.role === "frontend" || q.role === "backend" || q.role === "data");
    const deliverablePart = isDevRole && outDir
      ? `\n## 项目输出目录（必须遵守）\n所有项目文件必须写入此目录：${outDir}\n`
        + `- 使用 write/edit 工具在该目录下创建实际代码文件（不是只在回复里贴代码）。\n`
        + `- W4 冲突隔离：你的模块专属代码放在 \`modules/${q.taskId}/\` 子目录下（如 modules/${q.taskId}/index.js、modules/${q.taskId}/style.css），避免与其他并行模块写同名文件冲突。\n`
        + `- 共享入口文件（index.html、package.json 等）可直接放在输出目录根，但文件名必须唯一，不要覆盖其他模块的文件。\n`
        + `- 复刻类任务：对照源项目逐项还原功能，不要遗漏源项目的任何页面/接口/配置。\n`
        + `- 完成后在回复末尾必须用「FILE: <相对路径>」逐行列出你创建或修改的所有文件（每行一条），供总指挥验证磁盘产物。\n`
        + (roNotice ? `\n${roNotice}\n` : "")
      : "";
    const context = q.role === "data"
      ? `## 目标\n${run?.goal ?? ""}\n\n## 数据设计\n${(run?.dataDesign ?? "").slice(0, cap)}\n\n## 当前模块\n${q.module}（${q.type}）\n${q.taskId}${deliverablePart}`
      : `## 目标\n${run?.goal ?? ""}\n\n${designPart}## 当前模块\n${q.module}（${q.type}）\n${q.taskId}${deliverablePart}`;

    try {
      const output = await this._dispatchAgent(taskId, q.role, buildRolePrompt(this._personaFor(q.role)), context, {
        onOutput: (text) => this.watchdog.recordOutput(taskId, text),
        seat,
      });
      if (!this._isValidModuleOutput(output)) {
        throw new Error("模块输出无效或过短（占位/空），需重新开发");
      }
      // 修复复刻交付物不可用：开发角色必须报告文件清单并验证磁盘产物。
      // W2 加强：开发角色无 FILE: 清单或文件全部缺失 → 视为开发失败，触发重跑（不再只记 warning）。
      let fileManifest = [];
      if (isDevRole && outDir) {
        fileManifest = this._parseFileManifest(output);
        if (fileManifest.length === 0) {
          throw new Error(`模块 ${q.module}（${q.role}）未报告 FILE: 文件清单——子会话可能只贴了代码文本而未实际写入磁盘，需重新开发`);
        }
        const { existing, missing } = this._verifyFilesOnDisk(outDir, fileManifest);
        this.observability.record("info", "file_manifest", `模块 ${q.module}：报告 ${fileManifest.length} 个文件，磁盘验证 ${existing.length} 存在 / ${missing.length} 缺失`);
        if (existing.length === 0) {
          throw new Error(`模块 ${q.module}（${q.role}）报告了 ${fileManifest.length} 个文件但磁盘上一个都不存在：${missing.slice(0, 5).join(", ")}——需重新开发`);
        }
        if (missing.length > 0) {
          this.observability.record("warning", "file_manifest_missing", `模块 ${q.module} 报告的 ${missing.length} 个文件在磁盘上不存在：${missing.slice(0, 5).join(", ")}`);
        }
      }
      const t = this.dag.get(taskId);
      if (t) {
        t.status = "finished";
        t.output = output;
        t.fileManifest = fileManifest;
      }
      q.status = "finished";  // 关键：同步更新队列条目状态，否则 _runDevelopment 的 while 死循环
      // 修复 F8（#55）：产物更新上报——此前 watchdog.recordArtifact 全仓库零调用
      try { this.watchdog.recordArtifact(taskId); } catch (e) { /* ignore */ }
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
      // release seat（#16 统一出口）
      this.releaseSeat(seat);
      // #25：子会话完成事件（父会话感知；事件结构含 childId/role/status/artifacts/ts/version）
      this.childEvents.push({ childId: taskId, role: "module:" + q.role, status: "done", artifacts: Object.keys(run.devOutputs ?? {}).length, ts: Date.now(), version: (this.childEvents.length + 1) });
      if (this.childEvents.length > 200) this.childEvents.shift();
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
  /** 修复 R1：门禁级别归一化。GATE_BLOCKING 的键是 "P0".."P3" 字符串，而本函数的 severity
   * 形参在文档/自检语境下被当作数字使用；传数字时 `GATE_BLOCKING[0]` 为 undefined，
   * `?? "warn"` 会把 P0 静默降级为 warn——门禁无声失效且返回值看似合法。
   * 现统一接受 0/1/2/3 与 "P0".."P3"（含大小写与无前缀形式）。 */
  _gateSeverityKey(severity) {
    if (typeof severity === "number" && Number.isFinite(severity)) return "P" + sevNum(severity);
    if (typeof severity === "string") {
      const m = /^P?([0-3])$/i.exec(severity.trim());
      if (m) return "P" + m[1];
    }
    // 修复 R7：null / undefined / "" / false / [] 经 Number() 都会得到 0，从而被误判成 P0 硬阻断
    // （与 F21 的 `Number(s) || 1` 属同一类「空值被强制转换」缺陷）。非空但不可解析的取值
    // （undefined→NaN、对象→NaN）则落到 sevNum 得 P1。现统一为：缺失/空值/不可解析 → P1。
    // 理由：未知级别既不静默放行（不返回 warn），也不误触全流水线暂停（不返回 hard）。
    return "P1";
  }

  /** #26：门禁阻断三级。P0 硬阻断（暂停流水线/冻结新任务/升级人工）；P1 软阻断（拒绝节点产物回退）；P2/P3 警告（记录继续）。 */
  _applyGateBlocking(run, severity, reason, node = null) {
    const strength = GATE_BLOCKING[this._gateSeverityKey(severity)] ?? "warn";
    if (strength === "hard") {
      this.paused = true;
      this.rateLimiter._setState("GLOBAL_PAUSE", "P0 硬阻断：" + reason);
      // 修复 R2/R3：不再为门禁自身新建一条 P0 问题单。
      // 原实现 open({severity:0, title:"P0 硬阻断：…"}) + escalate() 造出的是一条 ESCALATED 单，
      // 而 issues._closed() 不含 ESCALATED → 它永远算「未关闭」，且门禁不保留其 id、无人能关闭它：
      //   1) 恢复条件 blocking().filter(sev===0).length===0 结构性不可达——人工关闭真实缺陷也无效（R3）；
      //   2) 每过一个门禁就多一条自造 P0，默认配置下 5 个门禁必然各打满 gateWaitMs，累计 5×300s=25 分钟（R2）。
      // 改为只对「已有」阻断项升级留痕，不制造新的阻断项。
      for (const i of this.issues.blocking().filter((x) => x.severity === 0).slice(0, 5)) {
        try { this.issues.escalate(i.id, "P0 硬阻断，升级人工裁决：" + String(reason).slice(0, 200)); } catch (e) { /* ignore */ }
      }
      this.observability.recordAnomaly("gate_hard_block", reason + (node ? " @" + node : ""));
      console.log("[dsh-leng-team] P0 硬阻断：" + reason + "（流水线暂停，升级人工）");
      // P0 恢复逻辑：用户确认关闭问题后自动恢复
      // 修复 F20：IssueTracker 并无 list() 方法（原调用在定时器回调内抛 TypeError，
      // 使 P0 自动恢复永远不生效）。改用 blocking() 现网 API，并在仍未恢复时续查。
      // 修复 R6：重入前先清掉上一条恢复轮询链，否则每个门禁各留一条 30s 自我续期定时器。
      if (this._p0RecoveryTimer) { try { clearTimeout(this._p0RecoveryTimer); } catch (e) { /* ignore */ } this._p0RecoveryTimer = null; }
      const checkP0Recovered = () => {
        if (!this.running) { this._p0RecoveryTimer = null; return; }
        const openP0 = this.issues.blocking().filter((i) => i.severity === 0);
        if (openP0.length === 0) {
          this.paused = false;
          this.rateLimiter._setState("NORMAL", "P0 问题已关闭，流水线恢复");
          this.observability.record("info", "gate_hard_block_recovered", "所有 P0 问题已关闭，流水线恢复");
          console.log("[dsh-leng-team] P0 恢复：所有 P0 问题已关闭，流水线继续");
          this._p0RecoveryTimer = null;
          return;
        }
        this._p0RecoveryTimer = setTimeout(checkP0Recovered, 30000);
      };
      this._p0RecoveryTimer = setTimeout(checkP0Recovered, 30000); // 30 秒后自动检查 P0 是否已关闭
      return "hard";
    }
    if (strength === "soft") {
      // 修复第十轮 M4：原实现只记一行「（回退对应节点，其他模块继续）」然后 return ——
      // 既不回退节点，也不通知父会话，文案与真实行为不符（实测 research/generic 各连续 5 个
      // 软阻断，全程 rework=0 / rollback=0，用户以为节点已返工）。现改为：
      //   1) 文案改为真实行为（问题入池 + 本阶段按评审信号返工，其他模块不受影响）；
      //   2) 同一阻断项签名重复出现达 3 次 → 升级为 error 级可观测并通知父会话裁决
      //      （关闭问题单继续 / 回退重做该环节 / 暂停人工修复），避免 P1 被静默带过。
      const sig = String(reason).slice(0, 200);
      this._gateSoftSeen = this._gateSoftSeen instanceof Map ? this._gateSoftSeen : new Map();
      const n = (this._gateSoftSeen.get(sig) ?? 0) + 1;
      this._gateSoftSeen.set(sig, n);
      const SOFT_ESCALATE_AT = 3;
      if (n >= SOFT_ESCALATE_AT) {
        this.observability.record("error", "gate_soft_block_exhausted", `${sig}（同一未关闭阻断项第 ${n} 次软阻断 → 升级父会话裁决：关闭问题单继续 / 回退重做该环节 / 暂停人工修复）`);
        // 修复第十轮 K-15：升级分支原先每次都 _notifyUser，同一个未关闭 P1 在返工循环里会把父会话刷屏
        // （实测连续 3 轮软阻断 → 3 条「⚠️ 门禁 P1 软阻断已重复 N 次」通知）。现只在该签名首次达到
        // 升级阈值时通知一次，后续同签名仍按 error 级留痕（可观测性不降级），不再重复打扰用户。
        if (n === SOFT_ESCALATE_AT) {
          this._notifyUser(this.activeRun, `⚠️ 门禁 P1 软阻断已重复 ${n} 次仍未关闭：\n${sig}\n请裁决：① 关闭该问题单继续；② 回退重做该环节；③ 暂停人工修复（/team pause）。`);
        } else {
          this.observability.record("warning", "gate_soft_block_exhausted_silent", `${sig}（第 ${n} 次软阻断，已升级过父会话，不再重复通知）`);
        }
      } else if (n > 1) {
        this.observability.record("warning", "gate_soft_block_repeat", `${sig}（同一阻断项第 ${n} 次软阻断，达 ${SOFT_ESCALATE_AT} 次将升级父会话）`);
      } else {
        this.observability.record("warning", "gate_soft_block", reason + (node ? " @" + node : "") + "（记录阻断并继续：问题已入池，本阶段按评审信号返工，其他模块不受影响）");
      }
      return "soft";
    }
    this.observability.record("info", "gate_warn", reason + (node ? " @" + node : ""));
    return "warn";
  }

  /** 修复 F13/F14：门禁阻断三级此前**只有定义与自检**（_applyGateBlocking 全仓库仅有定义
   * 与 selftest 的 typeof 自检），流水线无任何调用点，P0 硬阻断从未生效；issues.blocking()
   * 也从未被消费。此处把问题池中未关闭的阻断项（P0/P1）接入门禁并落痕。
   * P0 命中时暂停流水线并**有界等待**人工关闭（默认 5 分钟，可配 flow.gateWaitMs），
   * 超时按「有条件继续」落痕，避免开发排空循环整轮空转。
   * @returns {Promise<"none"|"hard"|"soft"|"warn">} */
  async _enforceGate(run, stage) {
    const blocking = typeof this.issues.blocking === "function" ? this.issues.blocking() : [];
    if (blocking.length === 0) return "none";
    const p0 = blocking.filter((i) => i.severity === 0);
    const severity = p0.length > 0 ? "P0" : "P1";
    const picked = (p0.length > 0 ? p0 : blocking).slice(0, 5)
      .map((i) => `${i.id}[${sevName(i.severity)}]${i.title}`).join("；");
    const reason = `${stage} 门禁：未关闭阻断项 ${blocking.length} 项（${picked}）`;
    const applied = this._applyGateBlocking(run, severity, reason, stage);
    try { this.observability.record(applied === "hard" ? "error" : "warning", "gate_enforced", `${stage} ${severity}→${applied}`); } catch (e) { /* ignore */ }
    if (applied !== "hard") return applied;
    // P0 硬阻断：有界等待人工处置（关闭问题单或 reject 接受风险）
    // 修复 R5：同一批阻断项只给一次人工处置窗口。否则同一条未关闭 P0 会在 5 个门禁各打满
    // gateWaitMs（默认 5×300s=25 分钟），门禁退化为固定延迟而非阻断。
    const sig = blocking.map((i) => i.id).sort().join(",");
    run.gateWaitedSigs = Array.isArray(run.gateWaitedSigs) ? run.gateWaitedSigs : [];
    if (run.gateWaitedSigs.includes(sig)) {
      this.paused = false;
      try { this.rateLimiter._setState("RECOVER", "P0 硬阻断项未变化且已等待过人工处置"); } catch (e) { /* ignore */ }
      this.observability.record("warning", "gate_hard_repeat",
        `${stage} 拦截到同一批未关闭阻断项且已等待过人工处置（${sig}），不再重复等待，按有条件继续`);
      return applied;
    }
    const boundMs = Math.max(60000, Number(this.config.flow.gateWaitMs ?? this.config.flow.confirmTimeoutMs ?? 300000));
    const until = Date.now() + boundMs;
    while (this.paused && Date.now() < until && !run.cancelled) await this._sleep(3000);
    if (this.paused) {
      run.gateWaitedSigs.push(sig);
      this.paused = false;
      this.pausedUntil = 0; // 第九轮 R4：门禁超时放行时同步清掉看门狗暂停期限
      // 已放弃等待：停掉 P0 恢复轮询链，避免流水线结束后仍有 30s 定时器在跑（与 F11 同源）。
      if (this._p0RecoveryTimer) { try { clearTimeout(this._p0RecoveryTimer); } catch (e) { /* ignore */ } this._p0RecoveryTimer = null; }
      try { this.rateLimiter._setState("RECOVER", "P0 硬阻断等待超时，按有条件继续"); } catch (e) { /* ignore */ }
      this.observability.record("warning", "gate_hard_timeout",
        `${stage} P0 硬阻断等待超时（${boundMs}ms），按有条件继续交付，遗留 P0 交最终审核裁决`);
      // 修复第九轮 N8：原调用只传了一个参数，_notifyUser(run, text) 的 text 为 undefined
      // → `if (!msg) return;` 静默丢弃，用户永远收不到「P0 门禁等待超时」这条提示。
      this._notifyUser(run, `⛔ 门禁 P0 硬阻断等待超时（${Math.round(boundMs / 1000)}s）：${reason}
已按「有条件继续」推进，遗留问题交最终审核裁决；可在最终审核前修复后重新确认。
（同一批问题不会在后续门禁重复等待。）`);
    } else {
      // 人工在等待窗口内关闭了阻断项 → 真实恢复
      this.observability.record("info", "gate_hard_recovered_by_human",
        `${stage} 人工已关闭全部阻断项，门禁放行（${sig}）`);
    }
    return applied;
  }

  /** #48：角色输出边界声明检查（已履行职责/已遵守边界）。缺失返回 false 供门禁判定 P2。 */
  _checkBoundaryDeclaration(roleKey, output) {
    if (!roleKey || roleKey === "orchestrator") return true;
    const txt = String(output ?? "");
    if (txt.trim().length === 0) return true; // 无输出不判定（测试模式/空跑）
    const okB = /已履行职责/.test(txt) && /已遵守边界/.test(txt);
    if (!okB) this.observability.record("warning", "boundary_missing", "角色 " + roleKey + " 输出缺少边界声明（已履行职责/已遵守边界），应由门禁判定 P2");
    return okB;
  }

  /**
   * 修复复刻交付物不可用：确定项目输出目录。
   * 复刻类若已解析出 targetPath 则用之（并确保目录存在）；否则自动创建 ./dsh-output/<run-id>。
   */
  _resolveOutputDir(run) {
    // 复刻任务：优先使用用户目标中解析出的 targetPath
    const explicit = run?.replicaPaths?.targetPath;
    if (explicit && typeof explicit === "string" && explicit.trim()) {
      try {
        const abs = path.resolve(explicit);
        fs.mkdirSync(abs, { recursive: true });
        return abs;
      } catch (e) {
        console.log(`[dsh-leng-team] targetPath=${explicit} 不可写（${e.message}），回退自动目录`);
      }
    }
    // 默认输出目录：./dsh-output/<run-id>
    const base = process.env.DSH_OUTPUT_DIR ?? path.join(process.cwd(), "dsh-output");
    const dir = path.join(base, run.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    return dir;
  }

  /**
   * 从开发子会话的最终文本中解析 FILE: 清单行，提取实际创建的文件相对路径。
   * 格式：每行 `FILE: relative/path/to/file`（允许前缀空格/横线）。
   */
  _parseFileManifest(text) {
    const files = [];
    for (const line of String(text ?? "").split("\n")) {
      const m = line.trim().match(/^[-*\s]*FILE:\s*(.+)$/i);
      if (m) {
        const p = m[1].trim();
        if (p && !p.includes("<") && !p.includes("...")) files.push(p);
      }
    }
    return [...new Set(files)];
  }

  /** 验证子会话声称创建的文件在磁盘上确实存在（相对于 outputDir）。 */
  _verifyFilesOnDisk(outputDir, manifest) {
    const existing = [];
    const missing = [];
    for (const rel of manifest) {
      const abs = path.isAbsolute(rel) ? rel : path.join(outputDir, rel);
      try { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) existing.push(rel); else missing.push(rel); }
      catch { missing.push(rel); }
    }
    return { existing, missing };
  }

  /**
   * 第十二轮接线 replicate.sourceReadonly（默认 true）：复刻类目标下给所有角色的「源目录只读」约束。
   * 返回空串表示不注入（非复刻目标 / 未识别到源目录 / 该键被显式关闭）。
   */
  _sourceReadonlyNotice(run) {
    if (this.config.replicate?.sourceReadonly === false) return "";
    const sp = run?.replicaPaths?.sourcePath;
    if (!sp) return "";
    const tp = run.replicaPaths?.targetPath;
    return [
      "## 源目录只读约束（replicate.sourceReadonly=true）",
      `- 源项目目录：${sp} —— 只读参照，禁止写入/修改/删除/移动/重命名其中任何文件，禁止在其中生成任何产物。`,
      `- 产出位置：${tp ? `只能写入目标目录 ${tp}` : "只能写入总指挥指定的目标目录（本目标未识别到显式目标路径）"}。`,
      "- 需要「修改源文件」时，改为在产物中给出补丁/差异说明，由人工在源仓库执行。",
    ].join("\n");
  }

  /**
   * 第十二轮接线 replicate.sourceReadonly：产物中出现「对源目录的写入意图」时记 warning + P2 入池。
   * 软强制：不中断流水线——编排器只能读文本，无法系统级拦截子 Agent 的文件操作（README 已如实标注）。
   */
  _detectSourceWrite(run, roleKey, output) {
    if (this.config.replicate?.sourceReadonly === false) return null;
    const sp = run?.replicaPaths?.sourcePath;
    if (!sp) return null;
    const esc = String(sp).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re = null;
    try {
      re = new RegExp(`(写入|写到|保存到|输出到|修改|删除|覆盖|重命名|移动到|迁移到|rm\\s+-rf|mv\\s+\\S+)\\s*[^\\n。；]{0,24}${esc}`, "i");
    } catch {
      return null; // 源路径含正则元字符等异常情况：宁可漏检，不可误伤流水线
    }
    const txt = String(output ?? "");
    const m = re.exec(txt);
    if (!m) return null;
    // 否定语境豁免：命中片段前 12 字符含禁止/只读等字样 → 是「声明遵守约束」，不是「打算违反」。
    const before = txt.slice(Math.max(0, m.index - 12), m.index);
    if (/(禁止|不得|不可|严禁|请勿|只读|不要)/.test(before)) return null;
    const iss = this.issues.open({
      severity: 2,
      owner: roleKey,
      module: "source_readonly",
      title: `复刻类源目录只读约束疑似被违反（角色 ${roleKey}）`,
      evidence: `命中片段：${m[0].slice(0, 160)}`,
    });
    this.observability.record("warning", "source_write_attempt", `角色 ${roleKey} 产物出现对源目录 ${sp} 的写入意图：${m[0].slice(0, 120)}`);
    return iss;
  }

  /** #54：环境适配器——local_process/container/remote/simulated；不可用时降级模拟并标记 conditional（人工确认+风险接受）。 */
  _resolveDeployEnv() {
    const cfg = this.config.deployEnv ?? {};
    const knownAdapters = ["local_process", "container", "remote", "simulated"];
    const adapters = cfg.adapters ?? knownAdapters;
    const adapter = cfg.adapter ?? "local_process";
    // 修复：区分"adapter 不在列表中"与"adapter 真的不可用"
    if (!adapters.includes(adapter)) {
      // adapter 有效但列表不完整 → 自动补充并继续
      if (knownAdapters.includes(adapter)) {
        this.observability.record("warning", "deploy_env_adapter_missing",
          `环境适配器 ${adapter} 不在 adapters 列表中，已自动补充`);
        adapters.push(adapter);
      } else {
        this.observability.record("warning", "deploy_env_degraded", "环境适配器 " + adapter + " 不可用，降级为模拟环境并标记 conditional");
        this.observability.recordWhy("deploy_env", "适配器不可用降级模拟（需人工确认+风险接受）");
        return { adapter: "simulated", degraded: true, conditional: true };
      }
    }
    return { adapter, degraded: false, conditional: false };
  }

  /**
   * #46：有条件合格检查——真实推送用户确认请求。
   * 独立通道（key="conditional"，不依赖 config.flow.manualConfirm 白名单），
   * 超时默认【不合格并回退】；用户接受风险后方可继续，且 conditional 交付物禁止缓存复用。
   * @returns {Promise<{ok:boolean,note:string}>}
   */
  async _conditionalConfirm(run, reason) {
    if (!run) return { ok: false, note: "无运行实例" };
    if (this.config.verification?.conditionalConfirm === false) {
      this.observability.record("warning", "conditional_skipped", "有条件合格用户确认被配置关闭（verification.conditionalConfirm=false），按不合格处理");
      return { ok: false, note: "已配置跳过用户确认，按不合格处理" };
    }
    const text = String(reason ?? "");
    run.conditionalReason = text;
    const iss = this.issues.open({ severity: 2, title: "有条件合格需用户确认：" + text.slice(0, 120), evidence: "conditional_confirm" });
    if (iss) this.issues.riskAccept(iss.id, "有条件合格风险接受待用户确认（超时默认不合格回退）");
    this.observability.recordWhy("final_audit", "有条件合格：风险接受待用户确认", iss?.id ?? null);
    // 测试模式：直接判定合格（沿用 autoConfirm 语义），避免测试流水线卡死
    if (this.config.flow.autoConfirm === true) {
      run.manualConfirms.conditional = "auto";
      this.observability.record("info", "confirm", "conditional：需用户确认（测试默认接受风险）");
      return { ok: true, note: "测试模式默认接受风险" };
    }
    if (run.cancelled) return { ok: false, note: "流水线已取消" };
    // 正式模式：挂起等待 + 真实推送到父会话聊天
    run.manualConfirms.conditional = "pending";
    run.pendingConfirm = "conditional";
    const timeoutMs = Math.max(60000, this.config.flow.conditionalTimeoutMs ?? this.config.flow.confirmTimeoutMs ?? 300000);
    const timeoutMin = Math.max(1, Math.round(timeoutMs / 60000));
    const notice = `【有条件合格 · 需您确认】${text}\n`
      + `该交付物为「有条件合格」，存在未完全消除的风险。\n`
      + `请回复 /team confirm conditional 接受风险并继续，或 /team reject conditional 要求回退返工（${timeoutMin} 分钟内未回复将默认判定不合格并回退）。`;
    this.observability.record("info", "confirm", "conditional：等待用户确认（/team confirm conditional）");
    this._notifyUser(run, notice);
    this._emit();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && run.manualConfirms.conditional === "pending" && !run.cancelled) {
      await this._sleep(2000);
    }
    if (run.cancelled) return { ok: false, note: "流水线已取消" };
    if (run.manualConfirms.conditional === "pending") {
      run.manualConfirms.conditional = "timeout";
      this.observability.record("warning", "conditional_timeout", `conditional 等待确认超时（${timeoutMin} 分钟未回复），默认判定不合格并回退`);
      this._notifyUser(run, `【有条件合格】等待确认超时（${timeoutMin} 分钟未回复），已默认判定不合格并回退，流水线继续执行回退流程。`);
      this._emit();
      return { ok: false, note: "等待确认超时，默认不合格" };
    }
    const ok = run.manualConfirms.conditional === "confirmed";
    run.pendingConfirm = null;
    this._emit();
    return { ok, note: ok ? "用户已接受风险" : "用户拒绝，判定不合格" };
  }

  _personaFor(roleKey) {
    const r = ROLE_MAP[roleKey];
    if (!r) return "";
    const ov = this.config.roles?.[roleKey]?.personaCore;
    const base = (ov && String(ov).trim().length > 0) ? String(ov) : r.personaCore;
    // T8 闭环：把与当前角色相关的两两边界规则注入提示词，让 BOUNDARY_RULES 真正约束产物
    // （此前仅 selfTest 读取，运行时无消费者，是死代码）。
    const related = (BOUNDARY_RULES ?? []).filter((br) => br.a === roleKey || br.b === roleKey);
    if (related.length > 0) {
      const rules = related.map((br) => `- ${br.rule}`).join("\n");
      return `${base}\n\n## 你与相邻角色的职责边界（必须遵守，不得越权也不得推诿）\n${rules}`;
    }
    return base;
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
    // ---- 模型防护（配置化）：父会话若命中已知挂起上游，回落到已实测快速稳定的备用模型。
    // 配置来源：config.modelGuard（enabled/hangingUpstreams/fallbackProvider/fallbackModel）
    const _guard = this.config.modelGuard ?? {};
    const _hangingRe = _guard.enabled !== false
      ? new RegExp((_guard.hangingUpstreams ?? ["280b", "dots3-note-prev", "note3-prev"]).join("|"), "i")
      : null;
    if (_hangingRe && (!provider || !model || _hangingRe.test(String(model ?? "")))) {
      console.log(`[dsh-leng-team] model guard: 父会话模型为挂起上游(${String(model ?? "")})，回落 ${_guard.fallbackModel ?? "glm-5.2"}`);
      provider = _guard.fallbackProvider ?? "freehub-deepseek-v4-flash-glm5-2-3";
      model = _guard.fallbackModel ?? "glm-5.2";
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
      let waitMs = 500;
      for (let t = 0; t < 30 && !bucketAcquired; t++) {
        if (this.rateLimiter.tryAcquire()) { bucketAcquired = true; break; }
        await this._sleep(waitMs);
        // 修复：指数退避，最大 5s，避免固定 1s 轮询浪费
        waitMs = Math.min(waitMs * 1.5, 5000);
      }
      if (!bucketAcquired) {
        // 修复：不再强制放行，改为记录告警 + 等待后重试一次
        this.observability.record("warning", "token_bucket_exhausted", "令牌桶持续耗尽，暂停新任务调度");
        await this._sleep(this.rateLimiter.backoffMs() ?? 1000);
        if (!this.rateLimiter.tryAcquire()) {
          throw new Error("令牌桶持续耗尽，无法调度新任务");
        }
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
        ? "你必须使用 write/edit 工具在指定输出目录下创建实际的项目代码文件（不是只在回复里贴代码块）。完成后在回复末尾用「FILE: <相对路径>」逐行列出所有创建/修改的文件。如果你没有实际写文件到磁盘，本次开发视为失败。"
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
        for (const [i, s] of this.seats) if (s.taskId === id) { this.releaseSeat(i); }
      },
    });

    const output = await this._waitAndRead(agent, sid, onOutput, taskId, roleKey);
    this.observability.recordToken(roleKey, this._estimateTokens(output));
    this.rateLimiter.recordSuccess();
    return output ?? "(无输出)";
  }

  async _waitAndRead(agent, sid, onOutput, taskId = null, roleKey = "") {
    const queueMs = this.config?.concurrency?.queueTimeoutMs;
    // W1 修复：开发角色（frontend/backend/data）需要写实际代码文件，给更长等待时间（默认 5 分钟）；
    // 文本角色（分析/设计/评审）保持队列超时的 1/3（默认 60s）。
    const isDevRole = (roleKey === "frontend" || roleKey === "backend" || roleKey === "data");
    const devMs = Number(this.config?.flow?.devTaskTimeoutMs ?? 300000);
    const deadline = Date.now() + (isDevRole ? devMs : (queueMs ?? 180000));
    const effectiveDeadline = Math.min(deadline, Date.now() + (isDevRole ? devMs : Math.max(30000, (queueMs ?? 180000) / 3)));
    console.log(`[dsh-leng-team] waitAndRead start sid=${sid} role=${roleKey} deadlineInMs=${effectiveDeadline - Date.now()}`);
    let last = "";
    let stable = 0;
    let diagPrinted = false;
    let iter = 0;
    let prevEvsLen = -1;
    let noProgress = 0;
    let consecutiveNoProgress = 0;
    while (Date.now() < effectiveDeadline) {
      iter += 1;
      // 修复 F8（#55）：长任务心跳上报——此前 watchdog.heartbeat/recordArtifact/
      // recordActivity 全仓库零调用，导致心跳机制为死代码、lastHeartbeat 永不刷新。
      // 约每 10 次迭代上报一次心跳（配合 sleep 间隔≈每 2 分钟），供僵尸会话判定使用。
      if (taskId && iter % 10 === 1) { try { this.watchdog.heartbeat(taskId); } catch (e) { /* ignore */ } }
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
          // 修复第九轮 N7：熔断上限按「是否已取到产物」分档。
          // 原实现一律 3 轮（sleep 1500ms → 约 4.5 秒静默）即熔断，而真实 LLM 首字节延迟
          // 常达数十秒且推理期间会话事件可能长时间不增长 → 会把仍在正常工作的角色误判为卡死，
          // 提前返回空产物并引发幻影返工。已有产物时保留 3 轮快速收敛，尚无产物时放宽到 20 轮（≈30 秒）。
          const fuseLimit = last ? 3 : 20;
          if (noProgress >= fuseLimit) {
            console.log(`[dsh-leng-team] waitAndRead sid=${sid} 连续无进展熔断 evsLen=${__cur} iter=${iter} limit=${fuseLimit}`);
            try {
              this.observability.record("warning", "read_fuse", `等待角色输出连续 ${fuseLimit} 轮无事件增长，提前结束等待（sid=${sid}${last ? "，已取回部分产物" : "，尚无产物"}）`);
            } catch (e) { /* ignore */ }
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


  /** #37：最终回归失败影响范围分型（代码/设计/文档/安全/架构）。 */
  _regressionScope(failText) {
    const t = String(failText ?? "");
    if (/安全|注入|越权|漏洞|权限|XSS|SQL/i.test(t)) return "security";
    if (/设计|视觉|还原|交互|样式|UI|布局/i.test(t)) return "design";
    if (/文档|说明|注释|描述|README/i.test(t)) return "document";
    if (/架构|性能|并发|容量|吞吐/i.test(t)) return "architecture";
    return "code";
  }

  /** #31/#6：目标假设一致性校验（总指挥执行）——提取原始需求关键要素，比对产品经理第一阶段假设的覆盖度。 */
  /**
   * 第九轮 N1（真实数据实测发现）：判定单个目标要素是否被产物覆盖。
   * 原因：`g.match(/[\u4e00-\u9fa5]{2,}/)` 是**贪婪连续串**而非分词，连写中文会被切成
   * 「开发一个待办事项网站」「对销售数据做探索性分析与可视化建模预测」这类 9~27 字超长要素，
   * 再要求整串逐字出现在产物里 → 只要产品经理做了同义改写/语序调整就判「未覆盖」。
   * 实测 7 个真实任务类型里 5 个假失败（software 0.40 / data_analysis 0.00 / content 0.00 /
   * fiction 0.00 / generic 0.25），并各自白耗一次 product 重跑 + 留下假 P2。
   * 现规则：逐字命中即通过；长度 ≥4 的长要素允许「最长公共子串占该要素 ≥50%」近似命中；
   * 2~3 字短要素仍**必须**逐字命中（避免「完成」「可以」这类短词把跑题产物放过去）。
   */
  _goalTokenCovered(token, doc) {
    const t = String(token ?? "");
    const d = String(doc ?? "");
    if (!t || !d) return false;
    if (d.includes(t)) return true;
    if (t.length < 4) return false;
    // 长度 ≥4 的要素：最长公共子串须同时满足「≥3 字」和「≥该要素一半」。
    // 只要求一半会让 4 字要素被 2 字词蒙混（「数据分析」被跑题产物里的「数据」命中，
    // 实测使跑题产物拿到 1/2 = 50% 而假通过），故下限提到 3 字。
    return this._longestCommonSubstringLen(t, d) >= Math.max(3, Math.ceil(t.length * 0.5));
  }

  /** 最长公共子串长度（滚动数组 DP；token 很短，doc 再长也只有 O(token×doc) 次比较）。 */
  _longestCommonSubstringLen(a, b) {
    const s = String(a ?? "");
    const q = String(b ?? "");
    if (!s || !q) return 0;
    let prev = new Array(q.length + 1).fill(0);
    let best = 0;
    for (let i = 1; i <= s.length; i += 1) {
      const cur = new Array(q.length + 1).fill(0);
      const ca = s.charCodeAt(i - 1);
      for (let j = 1; j <= q.length; j += 1) {
        if (ca === q.charCodeAt(j - 1)) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  }

  /**
   * #31/#6：目标假设一致性校验（总指挥执行）。
   * 修复第九轮 N1：原实现把目标的连续汉字段整段当作一个「关键要素」
   * （例如「开发一个待办事项网站」是 1 个要素），再用子串包含判定，等价于要求产物
   * **逐字复述**目标用词。中文目标经此切分后要素极少（1~5 个）且极长，真实产物即使完全
   * 对题也只有 0~2 个能逐字命中 → 5/7 个真实任务类型被误判「偏离原始需求快照」，
   * 每轮多跑一次产品经理并发 1 条幻影 P2。
   * 现改为两层判定：
   *   1) 主判据（决定 ok）：目标与产物的**汉字 2-gram 覆盖率** ≥ 50%
   *      —— 对标点、语序与同义改写不敏感，能识别「为一款新产品撰写公众号推广文章」
   *      覆盖「为新产品写一篇公众号推广文章」；
   *   2) 明细（只进 detail/日志）：要素级覆盖，逐字命中或长要素最长公共子串近似覆盖。
   * 正负对照（D:\test\r9_gc_probe.mjs）：真实跑题产物覆盖率 ≤13%、只复述主干名词 ≤29%，
   * 正常产物 60%~94% —— 50% 阈值两侧都有余量。
   */
  _goalConsistencyCheck(goal, productLight) {
    const g = String(goal ?? "");
    const p = String(productLight ?? "");
    if (!g || !p) return { ok: false, detail: "目标或假设为空", matched: [], total: 0, ratio: 0 };
    const STOP = ["这个", "那个", "我们", "你们", "他们", "需要", "一个", "进行", "可以", "要做一个", "然后", "因为", "所以", "如果", "但是", "以及", "或者", "并且", "请帮我", "帮我"];
    const tokens = (g.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? []).filter((t) => !STOP.includes(t));
    const unique = [...new Set(tokens)];
    if (unique.length === 0) return { ok: true, detail: "目标无可提取关键要素", matched: [], total: 0, ratio: 1 };
    const matched = unique.filter((t) => this._goalTokenCovered(t, p));
    const cov = this._goalBigramCoverage(g, p);
    const pct = (cov.ratio * 100).toFixed(0);
    return {
      ok: cov.ratio >= 0.5,
      ratio: cov.ratio,
      matched,
      total: unique.length,
      bigrams: { hit: cov.hit, total: cov.total, missing: cov.missing.slice(0, 12) },
      detail:
        "目标关键要素覆盖 " + matched.length + "/" + unique.length +
        "，字符 2-gram 覆盖率 " + pct + "%（要求>=50%）" +
        (cov.missing.length ? "，未覆盖：" + cov.missing.slice(0, 12).join("/") : ""),
    };
  }

  /**
   * 修复第九轮 N1：目标与产物的汉字 2-gram 覆盖率（对中文同义改写、语序、标点鲁棒）。
   * 只统计「两字均为汉字」的 2-gram（数字/英文/标点不参与），避免被 P0/表格骨架刷高。
   */
  _goalBigramCoverage(goal, doc) {
    const norm = (s) => String(s ?? "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
    const isCjk = (ch) => /[\u4e00-\u9fa5]/.test(ch);
    const gramsOf = (s) => {
      const t = norm(s);
      const out = new Set();
      for (let i = 0; i + 1 < t.length; i += 1) {
        const g2 = t.slice(i, i + 2);
        if (isCjk(g2[0]) && isCjk(g2[1])) out.add(g2);
      }
      return out;
    };
    const gs = [...gramsOf(goal)];
    if (!gs.length) return { ratio: 1, hit: 0, total: 0, missing: [] };
    const ds = gramsOf(doc);
    const missing = gs.filter((x) => !ds.has(x));
    const hit = gs.length - missing.length;
    return { ratio: hit / gs.length, hit, total: gs.length, missing };
  }

  /** #16：P0/P1 预留席位（5 分钟超时自动释放；仅供关键门禁/调查/最终复核）。 */
  reserveSeat(role = "critical") {
    const cap = this.effectiveCapacity();
    for (let i = 0; i < cap; i++) {
      if (!this.seats.has(i)) {
        const rec = { role, module: "reserved", startedAt: Date.now(), status: this.SEAT_STATES.RESERVED, reservedAt: Date.now(), rev: Date.now() }; // #23
        this.seats.set(i, rec);
        const timer = setTimeout(() => {
          const s = this.seats.get(i);
          if (s && s.status === this.SEAT_STATES.RESERVED) {
            this.seats.delete(i);
            this.observability?.record?.("info", "seat_reserved_timeout", "预留席位 5 分钟超时自动释放 seat=" + i);
          }
        }, 300000);
        if (typeof timer.unref === "function") timer.unref();
        this._seatTimers.set(i, timer);
        return i;
      }
    }
    return -1;
  }

  /** #16：释放席位（统一出口，记录状态；RELEASING → 删除）。 */
  releaseSeat(seat) {
    const s = this.seats.get(seat);
    if (s) {
      s.status = this.SEAT_STATES.RELEASING;
      s.releasedAt = Date.now();
    }
    this.seats.delete(seat);
    const t = this._seatTimers.get(seat);
    if (t) { clearTimeout(t); this._seatTimers.delete(seat); }
    this._drainQueue?.();
  }

  /** #16：席位状态统计（可观测性/快照用）。 */
  seatSnapshot() {
    const states = {};
    for (const [, s] of this.seats) states[s.status] = (states[s.status] ?? 0) + 1;
    return { total: this.seats.size, capacity: this.effectiveCapacity(), states, reserved: states[this.SEAT_STATES.RESERVED] ?? 0, occupied: states[this.SEAT_STATES.OCCUPIED] ?? 0 };
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
        // 修复：从配置动态生成检查清单，不再硬编码到 prompt 文本
        const auditCfg = this.config.finalAudit ?? {};
        const checklist = [
          ["baselineCompare", "源基线对比", "复刻类对照源项目基线做行为差异测试"],
          ["artifactReportCheck", "调查报告检查", "调查报告完整性与充分性"],
          ["diffListCheck", "差异清单检查", "复刻类核对差异与未知清单"],
          ["investigationClosureCheck", "调查闭环检查", "调查充分性/假设显式标注/未知项有负责人"],
          ["designClosureCheck", "设计闭环检查", "设计交叉评审/设计评审门禁/设计契约冻结/设计测试"],
          ["finalRegressionCheck", "最终回归检查", "最终全功能回归测试通过才可审核"],
          ["verificationCheck", "独立复验检查", "独立复验三态结论写入快照"],
        ];
        const checklistText = checklist
          .filter(([k]) => auditCfg[k] !== false)
          .map(([k, label, desc]) => `- ${label}：${desc}`)
          .join("\n");
        return `## 未关闭问题池（最终审核必须逐条处理：P2 未关闭/未风险接受则不得通过；P3 可风险接受但必须记录）\n${issuePool}\n\n## 你的任务：项目最终审核判定\n你是项目最终审核总工程师。请对照用户原始目标逐项核验下方全部交付产物，判定项目是否完整达标、无遗漏、无偏差。\n你的最终交付必须包含以下三部分（作为交付父会话/总指挥的最终项目总结）：\n1. **审核结论**：明确输出「审核结论：通过」或「审核结论：不通过」。若通过，附各项核验结果与依据；若不通过，逐条列出问题所属环节（产品需求/需求分析/架构/安全/UX/UI/前端开发/后端开发/代码评审/测试/运维/文档）+ 整改要求。\n2. **项目功能总结**（仅通过时）：本项目具备哪些功能、实现了用户原始目标的哪些要求。\n3. **交付与运行信息**（仅通过时）：项目文件所在位置（各开发模块代码文件路径、汇总后的完整工程路径）与如何运行（启动方式、依赖、访问方式）。\n禁止复述或重写任何产物文档，只做审核判定与总结。\n\n## 最终审核检查清单（从配置 finalAudit 动态生成，逐项核验并在结论中注明通过/不通过）\n${checklistText}\n\n## 用户原始目标\n${run.goal}\n\n## 产品需求全文\n${String(run.product ?? "").slice(0, cap)}\n\n## 需求分析全文\n${String(run.analyst ?? "").slice(0, cap)}\n\n## 架构全文\n${String(run.architecture ?? "").slice(0, cap)}\n\n## 安全审计全文\n${String(run.security ?? "").slice(0, cap)}\n\n## UX 交互全文\n${String(run.ux ?? "").slice(0, cap)}\n\n## UI 视觉全文\n${String(run.ui ?? "").slice(0, cap)}\n\n## 开发模块输出摘要\n${devLines.slice(0, c2)}\n\n## 代码评审结论\n${String(run.review ?? "").slice(0, cap)}\n\n## 测试结论\n${String(run.test ?? "").slice(0, cap)}\n\n## 运维说明\n${String(run.ops ?? "").slice(0, 1500)}\n\n## 交付文档（仅作审核对象，勿重写）\n${String(run.docs ?? "").slice(0, 2500)}`;
      }
      default: return `## 目标\n${run.goal}`;
    }
  }

  async _maybePlanSelect(run) {
    if (run.cancelled) return;
    const src = String(run.analyst ?? run.domainDesign ?? run.product ?? "");
    const snippet = src.slice(0, 1500);
    // 修复第九轮 N6：原实现不判断上游是否真的输出了「多套方案」，软件路径每次都会向用户发
    // 「需要您选择方案」并空等 confirmTimeoutMs（默认 5 分钟）—— T3 实测 plan_timeout 恒定出现。
    // 现要求正文出现 ≥2 处「方案」标记才认为存在可选方案，否则记 plan_skipped 直接返回。
    const planMarks = (src.match(/方案/g) ?? []).length;
    if (planMarks < 2) {
      this.observability.record("info", "plan_skipped", `未检测到多套方案标记（正文「方案」出现 ${planMarks} 次 < 2），跳过方案选择等待`);
      return;
    }
    const auto = this.config.flow.autoConfirm === true;
    if (auto) {
      run.planChoice = run.planChoice || 1;
      this.observability.record("info", "plan", `需求分析师已输出多套方案（需用户选择 · 测试默认方案${run.planChoice}）：\n${snippet}`);
      return;
    }
    run.manualConfirms.plan = "pending";
    run.pendingConfirm = "plan";
    const planMin = Math.max(1, Math.round((this.config.flow.confirmTimeoutMs ?? 300000) / 60000));
    this.observability.record("info", "plan", `请选择实现方案（/team plan <编号>，默认方案一）。方案摘要：\n${snippet}`);
    this._notifyUser(run, `【需要您选择方案】需求分析师已输出多套实现方案：\n${snippet}\n请回复 /team plan <编号> 选择（例如 /team plan 2；${planMin} 分钟未选择将默认采用方案一）。`);
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
    // 修复第九轮 N5：域路径无 analyst，疑问正文需回落到 product 定稿（否则域路径即使被调用也读不到内容）。
    const doc = String(run.analyst ?? run.product ?? "");
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
    const qMin = Math.max(1, Math.round((this.config.flow.confirmTimeoutMs ?? 300000) / 60000));
    this.observability.record("info", "questions", "需求分析师提出以下需求疑问，请逐条回答（/team answer <编号> <答复>，例如 /team answer 1 支持游客模式）：\n" + listing);
    this._notifyUser(run, `【需要您回答】需求分析师提出以下需求疑问：\n${listing}\n请逐条回复 /team answer <编号> <答复>（例如 /team answer 1 支持游客模式；${qMin} 分钟未回答将默认按分析师假设继续）。`);
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
    // 统一默认值：manualConfirmDefaults 控制各环节默认行为（requirement=true, architecture/ui/final=false）
    const defaults = this.config.flow.manualConfirmDefaults ?? { requirement: true, architecture: false, ui: false, final: false };
    // 修复第十轮 K-13：原实现用两个重叠开关串联决定「是否真正等待用户」：
    //   enabled   = config.flow.manualConfirm[key]        （设置面板暴露的 4 个开关，lib/config.js:467-470）
    //   defaultOk = config.flow.manualConfirmDefaults[key]（**设置面板未暴露**，默认 architecture/ui/final=false）
    // 只有两者同时为 true 才进入等待，于是把设置面板里的「架构/UI/最终交付人工确认」打开也**不会**等待，
    // 而是静默走「默认不强制确认，自动通过」（实测 out10_k_b6_subset.txt：manualConfirm.final=true 且
    // defaults.final=false → 无 confirm_timeout；把两者都置 true 后才出现 confirm_timeout:1）。
    // 现改为单一判据：manualConfirmDefaults 只作为 manualConfirm 未显式声明时的默认值。
    // 两者默认值在 DEFAULTS 中完全一致（requirement:true / architecture:false / ui:false / final:false），
    // 故默认配置下的行为逐键不变；仅当用户显式打开某键时才真正等待（与开关文案一致）。
    const enabled = this.config.flow.manualConfirm?.[key] ?? defaults[key];
    if (!enabled) return;
    // 测试模式（autoConfirm=true）：默认选择通过，并标注「需确认 · 测试默认通过」
    const auto = this.config.flow.autoConfirm === true;
    const label = { requirement: "需求定稿", architecture: "架构定稿", ui: "UI 定稿", final: "最终交付" }[key] ?? key;
    if (auto) {
      run.manualConfirms[key] = "auto";
      this.observability.record("info", "confirm", `${label}：需用户确认（测试默认通过）`);
      return;
    }
    // 正式模式：把确认请求挂到 run.pendingConfirm，并【真实推送到父会话聊天】
    // （含待确认内容摘要 + 操作指引），用户可见后可 /team confirm <key> 或 /team reject <key> 回写。
    run.manualConfirms[key] = "pending";
    run.pendingConfirm = key;
    const timeoutMin = Math.max(1, Math.round((this.config.flow.confirmTimeoutMs ?? 300000) / 60000));
    const summary = this._confirmSummary(run, key);
    const notice = `【需要您确认】${label}已产出。\n`
      + (summary ? `待确认内容摘要：\n${summary}\n` : "")
      + `请回复 /team confirm ${key} 确认通过，或 /team reject ${key} 拒绝并要求修改（${timeoutMin} 分钟内未回复将默认通过）。`;
    this.observability.record("info", "confirm", `${label}：等待用户确认（/team confirm ${key}）`);
    this._notifyUser(run, notice);
    this._emit();
    // 等待用户确认（有界等待，超时默认通过，防止流水线永久卡死）
    const deadline = Date.now() + (this.config.flow.confirmTimeoutMs ?? 300000);
    while (Date.now() < deadline && run.manualConfirms[key] === "pending" && !run.cancelled) {
      await this._sleep(2000);
    }
    if (run.cancelled) return;
    if (run.manualConfirms[key] === "pending") {
      run.manualConfirms[key] = "confirmed"; // 方向A：超时默认通过并明确提示
      this.observability.record("warning", "confirm_timeout", `${label} 等待确认超时，已默认通过`);
      this._notifyUser(run, `【${label}】等待确认超时（${timeoutMin} 分钟未回复），已默认通过，流水线继续。如对产物不满意，可 /team reset 后重跑。`);
    }
    this._emit();
  }

  /** 供 /team confirm | /team reject 命令调用，回写人工确认结果。 */
  confirm(key, ok) {
    const run = this.activeRun;
    if (!run) return { ok: false, message: "当前没有运行中的流水线。" };
    // conditional 为独立确认通道（有条件合格风险接受），不受 manualConfirm 白名单限制
    const enabled = this.config.flow.manualConfirm?.[key] || key === "conditional";
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
    // V9.3：429/限流驱动令牌桶状态机。
    // 修复 R18：原实现是 `if (429) record429(); else recordSuccess();` —— 把「一切非 429 告警」
    // 都当作请求成功喂给状态机，于是 zombie / dead_loop 这类 error 级告警反而推动限流状态机
    // 进入恢复甚至 NORMAL（故障在告警链路上被误读成健康）。真正的成功请求由 _dispatchAgent
    // 在拿到输出后调用 recordSuccess()（lib/orchestrator.js:2009），此处只处理限流类告警。
    if (/429|rate.?limit|限流/i.test(String(alert?.message ?? "") + " " + String(alert?.type ?? ""))) this.rateLimiter.record429();
    // 修复 F10：看门狗策略（watchdog.action = pause|rebuild|terminate）此前完全未被消费，
    // 而 lib/watchdog.js 的告警文案已声称「按策略「X」处置」。此处按策略真实落地。
    if (alert?.type === "dead_loop" && alert?.action) {
      const act = String(alert.action);
      const note = { pause: "暂停流水线并升级人工裁决", rebuild: "回收席位后重建该任务", terminate: "回收席位并终止该任务" }[act] ?? `未知策略 ${act}`;
      // 修复第十轮 M5：同一任务的重复告警此前会**反复续期暂停**并**每次通知父会话**——
      // 实测快阈值下 task=discovery:run-1 在 6 秒内被连告 2 次，日志出现「暂停将于
      // 11:57:30 / 12:09:23 / 12:15:13 自动恢复」的不断后推，整体比默认配置多约 10 分钟
      // 纯等待，父会话收到 12 条重复提示。现在：同一任务在同一暂停窗口内的后续告警不再
      // 续期、不再重复通知（只记可观测性）；累计超过 3 次仍复现则回收席位并升级人工裁决。
      if (!(this._wdHandled instanceof Map)) this._wdHandled = new Map();
      const wdKey = "pause:" + String(taskId ?? "-");
      const nowTs = Date.now();
      const alreadyPaused = this._wdPauseTask === String(taskId ?? "-") && Number(this.pausedUntil) > nowTs;
      let deduped = false;
      try {
        if (act === "pause") {
          const n = (this._wdHandled.get(wdKey) ?? 0) + 1;
          this._wdHandled.set(wdKey, n);
          if (alreadyPaused) {
            deduped = true;
            this.observability.record("warning", "watchdog_action_dedup", `看门狗 pause 重复告警（task=${taskId}，第 ${n} 次）：已在暂停期（至 ${new Date(this.pausedUntil).toLocaleTimeString()}），本次不续期、不重复通知。`);
            if (n > 3) {
              for (const [i, s] of this.seats) if (s?.taskId === taskId) this.releaseSeat(i);
              this.observability.record("error", "watchdog_action_exhausted", `看门狗 pause 对 task=${taskId} 已告警 ${n} 次仍复现 → 回收席位，等待人工裁决`);
            }
          } else {
            this.paused = true;
            // 修复第九轮 R4：`pause` 此前是**无恢复期限**的暂停——置上 this.paused 后只有
            // `_enforceGate` 超时路径或人工 `/team resume` 能清除；若发生在开发阶段，
            // `_runDevelopment` 的暂停分支会一直空转到写死的 1 小时兜底。
            // 现显式记录自动恢复期限（默认 flow.confirmTimeoutMs，可用 watchdog.pauseMs 覆盖）。
            const pauseMs = Number(this.config?.watchdog?.pauseMs) > 0
              ? Number(this.config.watchdog.pauseMs)
              : Number(this.config?.flow?.confirmTimeoutMs) > 0 ? Number(this.config.flow.confirmTimeoutMs) : 300000;
            this.pausedUntil = nowTs + pauseMs;
            this._wdPauseTask = String(taskId ?? "-");
            this.rateLimiter._setState("BACKOFF", "语义死循环：暂停流水线待人工处置");
          }
        } else if (act === "rebuild" || act === "terminate") {
          for (const [i, s] of this.seats) if (s?.taskId === taskId) this.releaseSeat(i);
        }
        if (!deduped) {
          this.observability.record("warning", "watchdog_action", `看门狗策略「${act}」已执行：${note}（task=${taskId}）${act === "pause" ? `，暂停将于 ${new Date(this.pausedUntil).toLocaleTimeString()} 自动恢复` : ""}`);
          // 修复第九轮 N8：原调用只传了一个参数，_notifyUser(run, text) 的 text 为 undefined
          // → `if (!msg) return;` 静默丢弃，这条「看门狗策略已执行」用户永远看不到。
          this._notifyUser(this.activeRun, `🐶 看门狗策略「${act}」已执行：${note}${act === "pause" ? "\n暂停已设置自动恢复期限，超时自动继续；也可立即回复 /team resume 手动恢复。" : ""}`);
        }
      } catch (e) { /* ignore */ }
    }
    // V9.3：销毁/终止/致命类告警前先落盘事务快照（看门狗销毁前快照，方案 1.5/十八）
    // 修复 G6（第八轮）：原判定只用文案正则 /销毁|dispose|kill|终止|fatal|致命|崩溃|crash/i，
    // 而 watchdog 真实发出的三类告警（429 / zombie / dead_loop）文案是固定模板，全部不含这些词
    // （dead_loop 的策略名是拉丁文 "terminate"，不匹配中文「终止」），于是这条安全网在**唯一真正
    // 销毁子会话的僵尸回收路径**上从未触发 —— 实测：僵尸击杀后 log 中无 watchdog_snapshot。
    // 现改为「按告警类型判定销毁事件 + 保留文案正则兜底」。
    const destructiveAlert = ["zombie", "destroy", "dispose", "fatal", "crash"].includes(String(alert?.type ?? ""))
      || String(alert?.action ?? "") === "terminate"
      || /销毁|dispose|kill|终止|fatal|致命|崩溃|crash/i.test(String(alert?.message ?? "") + " " + String(alert?.type ?? ""));
    if (destructiveAlert) {
      try {
        const p = this._snapshot();
        // _snapshot() 经 _withLock 返回 Promise，而本方法是同步告警回调（不能 await）：
        // 显式挂 catch，避免落盘失败变成未处理的 Promise 拒绝。
        if (p && typeof p.catch === "function") p.catch((e) => console.log("[dsh-leng-team] watchdog snapshot fail", String(e)));
        this.observability.record("warning", "watchdog_snapshot", `销毁前事务快照已落盘（告警类型=${alert?.type ?? "unknown"}）`);
      } catch (e) { console.log("[dsh-leng-team] watchdog snapshot fail", String(e)); }
    }
    this._emit();
  }

  _estimateTokens(text) {
    const s = String(text ?? "");
    if (s.length === 0) return 0;
    // 修复：使用更准确的 token 估算（中文约 1.5 字/字符，英文约 4 字符/token）
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(s);
    if (hasCJK) {
      // 中文为主：约 1.5 字符/token
      return Math.ceil(s.length / 1.5);
    }
    // 英文为主：约 4 字符/token
    return Math.ceil(s.length / 4);
  }

  _snapshot() {
    return this._withLock(() => {
      const run = this.activeRun;
      this.snapshotStore.save({
      active: this.running,
      paused: this.paused, // 修复 E7b：断点恢复必须保留暂停态（原先不落盘，_restore 后恒为 false）
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
        // 修复第十二轮 K-17：白名单缺字段会让断点恢复后产物凭空消失——techLead/dataDesign/domainDesign
        // 此前从未落盘；domainOutputs 缺失使领域流水线恢复时丢掉整批模块交付物，且让模块级复用永不成立。
        techLead: run.techLead ?? null, dataDesign: run.dataDesign ?? null, domainDesign: run.domainDesign ?? null,
        domainOutputs: run.domainOutputs ?? null, domainReview: run.domainReview ?? null, domainRegression: run.domainRegression ?? null,
        designReview: run.designReview ?? null, designSecurity: run.designSecurity ?? null,
        deploySecurity: run.deploySecurity ?? null, prelaunchSecurity: run.prelaunchSecurity ?? null,
        goalCheck: run.goalCheck ?? null, devDelivery: run.devDelivery ?? null, delivered: run.delivered ?? null,
        replicaPaths: run.replicaPaths ?? null, // 第十二轮：复刻类源/目标路径（续跑时源目录只读约束仍需生效）
        outputDir: run.outputDir ?? null, deliveredFiles: run.deliveredFiles ?? null, // 修复：项目输出目录与文件清单
      } : null,
        rollback: this.rollback.snapshot(),
        rate: this.rateLimiter.snapshot(),
        issues: this.issues.serialize(),
      });
    });
  }

  _restore(snap) {
    this.issues.restore(snap.issues);
    // 修复 E7b：与 _snapshot 的 paused 字段配对。原实现不还原暂停态，断点恢复后
    // 会「静默解冻」——虽然 snap.rate 会把 GLOBAL_PAUSE 写回来兜住调度，但
    // this.paused 的观测面与 _drainQueue 的守卫语义必须与快照时刻一致。
    this.paused = snap.paused === true;
    // 第九轮 R4：快照不落盘 pausedUntil，恢复时补一个**有限**的自动恢复期限，
    // 避免断点恢复后停在永久暂停态（原来只有人工 /team resume 能解除）。
    this.pausedUntil = this.paused
      ? Date.now() + (Number(this.config?.flow?.confirmTimeoutMs) > 0 ? Number(this.config.flow.confirmTimeoutMs) : 300000)
      : 0;
    if (snap.rollback) { try { this.rollback = new RollbackBudget(this.config.rollback); this.rollback.restore(snap.rollback); } catch (e) { /* keep */ } }
    if (snap.rate) { try { this.rateLimiter.concurrency = snap.rate.concurrency ?? this.rateLimiter.concurrency; this.rateLimiter.state = snap.rate.state ?? this.rateLimiter.state; } catch (e) { /* keep */ } }
    this.queue = (snap.queue ?? []).map((q) => ({ ...q, createdAt: Date.now() }));
    for (const s of snap.seats ?? []) {
      this.seats.set(s.seat, { taskId: s.taskId, role: s.role, module: s.module, startedAt: Date.now() });
    }
    const run = this.activeRun;
    if (snap.runState) Object.assign(run, snap.runState);
    // 修复第十一轮 K-12（方案 C）：标记本次运行来自快照恢复，供开发阶段做模块级复用。
    if (run) run.restored = true;
    // 第十二轮 K-12B：记录崩溃时正在执行的那个阶段。该阶段产物不完整，续跑必须真实重跑；
    // 其余「快照里已有合法产物」的阶段则允许复用（声明面见 lib/stage-reuse.js）。
    if (run) { run.restoredInflight = snap.stage ?? null; run.stageReuseUsed = {}; }
    // 修复第十一轮 K-12（安全性前提）：记录恢复时刻的「前序设计基线」。续跑会重跑
    // product/analyst/架构/安全/UX/UI，若这些产物在续跑中被重新生成并发生变化，则已交付模块
    // 所依据的规格可能已变（模块列表甚至可能不同），此时复用旧模块产物就是错误的。
    // 因此只有在基线逐字一致时才允许复用；否则记录 dev_module_reuse_skipped 说明为何不复用。
    if (run) run.restoredBaseline = [run.product, run.analyst, run.architecture, run.security, run.ux, run.ui].map((x) => String(x ?? "")).join("\u0001");
    if (run?.taskType) { this.taskType = run.taskType; this.taskTemplate = templateFor(run.taskType); }
    run.stage = snap.stage ?? run.stage;
    if (run.stage === "dev") {
      // re-enqueue module tasks whose status isn't finished
      for (const q of this.queue) this.dag.set(q.taskId, { id: q.taskId, role: q.role, module: q.module, status: q.status, deps: [], output: null, rework: 0 });
    }
    // 修复第十一轮 K-12：交付产物一律回填 dag（不再受 stage==="dev" 限制）。
    // 模块完成后即出队，因此崩溃快照里 queue 往往已空；若只在 stage==="dev" 且存在队列条目时
    // 回填 dag，续跑时「已交付模块」在 dag 里查不到，复用条件永远不成立（方案 C 变死代码）。
    // 修复第十二轮 K-17：原实现只回填 devOutputs，领域流水线的模块产物存在 run.domainOutputs
    // （data_analysis/research/content/document/generic 五个领域都不写 devOutputs），于是：
    //   ① 崩溃恢复后领域模块产物在 dag 里查不到 → 第十一轮的模块级复用对「非 software」永不成立；
    //   ② 极端情况下恢复的 run 丢掉整批领域交付物。现两个产物仓都回填。
    for (const store of [run.devOutputs, run.domainOutputs]) {
      for (const m of Object.keys(store ?? {})) {
        const t = this.dag.get(m) ?? { id: m, role: "", module: m, status: "finished", deps: [], output: null, rework: 0 };
        if (store[m]) { t.status = "finished"; t.output = store[m]; this.dag.set(m, t); }
      }
    }
  }

  /**
   * 修复复刻交付物不可用：流水线完成后扫描输出目录，汇总实际文件清单并通知用户。
   * 这是交付的"最后一公里"——之前编排器只收集文本，不验证磁盘产物，用户拿到的是无法运行的项目。
   */
  _notifyProjectDelivery(run, domain) {
    const outDir = run?.outputDir;
    if (!outDir) return;
    // 递归扫描输出目录，收集文件清单（排除 node_modules/.git 等大目录）
    const files = [];
    const skipDirs = new Set(["node_modules", ".git", "__pycache__", ".next", "dist", "build"]);
    const walk = (dir, rel) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) { if (!skipDirs.has(ent.name)) walk(full, r); }
        else files.push(r);
      }
    };
    walk(outDir, "");
    run.deliveredFiles = files;
    run.outputDir = outDir;
    console.log(`[dsh-leng-team] 项目交付目录=${outDir} 文件数=${files.length}`);
    if (files.length > 0) {
      console.log(`[dsh-leng-team] 文件清单（前30）:\n  ${files.slice(0, 30).join("\n  ")}`);
    }
    // W3：自动检测项目类型并生成具体启动指南
    const startGuide = this._detectProjectType(outDir, files);
    // 通知父会话最终交付位置
    const msg = files.length > 0
      ? `\n\n## 项目交付目录\n所有项目文件已生成到：${outDir}\n共 ${files.length} 个文件。\n主要文件：\n- ${files.slice(0, 20).join("\n- ")}${files.length > 20 ? `\n- ... 等 ${files.length - 20} 个文件` : ""}\n\n${startGuide}`
      : `\n\n## 注意：项目交付目录为空\n输出目录 ${outDir} 中未扫描到任何文件。开发子会话可能只输出了代码文本而未实际写入文件。请检查 devOutputs 中的代码片段，或手动将代码保存到该目录。`;
    this._notifyUser(run, msg);
  }

  /** W3：根据输出目录中的标志性文件检测项目类型，生成启动命令。 */
  _detectProjectType(outDir, files) {
    const has = (name) => files.some((f) => f === name || f.endsWith("/" + name));
    const guide = [];
    try {
      if (has("package.json")) {
        const pkgPath = path.join(outDir, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const scripts = pkg.scripts ?? {};
        const hasNodeModules = fs.existsSync(path.join(outDir, "node_modules"));
        guide.push(`**项目类型：Node.js 项目**`);
        if (!hasNodeModules) guide.push(`1. 安装依赖：\`cd "${outDir}" && npm install\``);
        if (scripts.dev) guide.push(`${hasNodeModules ? "1" : "2"}. 启动开发服务器：\`npm run dev\``);
        else if (scripts.start) guide.push(`${hasNodeModules ? "1" : "2"}. 启动：\`npm start\``);
        else guide.push(`${hasNodeModules ? "1" : "2"}. 项目无 start/dev 脚本，请查看 package.json scripts 字段`);
        if (scripts.build) guide.push(`3. 构建生产版本：\`npm run build\``);
      } else if (has("index.html")) {
        guide.push(`**项目类型：静态网页**`);
        guide.push(`直接用浏览器打开：\`${path.join(outDir, "index.html")}\``);
        guide.push(`或启动本地服务器：\`cd "${outDir}" && npx serve\``);
      } else if (has("requirements.txt")) {
        guide.push(`**项目类型：Python 项目**`);
        guide.push(`1. 创建虚拟环境：\`cd "${outDir}" && python -m venv venv\``);
        guide.push(`2. 安装依赖：\`pip install -r requirements.txt\``);
        guide.push(`3. 运行入口文件（查看 main.py / app.py）`);
      } else if (has("go.mod")) {
        guide.push(`**项目类型：Go 项目**`);
        guide.push(`\`cd "${outDir}" && go run .\``);
      } else if (has("pom.xml")) {
        guide.push(`**项目类型：Java/Maven 项目**`);
        guide.push(`\`cd "${outDir}" && mvn spring-boot:run\``);
      } else if (has("Cargo.toml")) {
        guide.push(`**项目类型：Rust 项目**`);
        guide.push(`\`cd "${outDir}" && cargo run\``);
      } else {
        guide.push(`**项目类型：未识别**（无 package.json/index.html/requirements.txt 等标志性文件）`);
        guide.push(`请查看输出目录中的文件结构确定运行方式。`);
      }
    } catch (e) {
      guide.push(`启动方式：进入输出目录后根据文件结构确定（检测失败：${e.message}）`);
    }
    return "## 启动指南\n" + guide.join("\n");
  }

  _summarize(run) {
    // 修复 E3：status 原为硬编码 "完成"，且 dev 用 `run.devOutputs ?` 判真值 ——
    // 而 devOutputs={} 是 truthy，于是「零交付」被显示成「完成 (0 个模块)」。
    // 现按 run.delivered 与 run.devDelivery 如实汇报。
    // 修复第十轮 K-9：dev 阶段还需区分「零交付」与「部分模块失败」，否则整条角色线失败仍显示「完成 (3/7)」。
    const d = run.devDelivery;
    const failedN = Array.isArray(d?.failed) ? d.failed.length : 0;
    const devStage = d
      ? (d.valid > 0
        ? `完成 (${d.valid}/${d.total} 个模块${failedN ? `，失败 ${failedN} 个：${d.failed.join("、")}` : ""})`
        : `零交付 (0/${d.total} 个模块)`)
      : (run.devOutputs ? `完成 (${Object.keys(run.devOutputs).length} 个模块)` : "未执行");
    return {
      // 修复第十一轮 K-8：取消态优先标注（run.cancelled 由 cancelActive 置位）。
      status: run.cancelled
        ? `已取消（${run.cancelReason ?? "用户取消"}）`
        : (run.delivered === false
          ? (d && d.valid > 0 ? `未完成（模块开发失败未交付：${failedN}/${d.total}）` : "未完成（开发阶段零交付）")
          : "完成"),
      goal: run.goal,
      stages: {
        product: run.product ? "完成" : "未执行",
        analyst: run.analyst ? "完成" : "未执行",
        architecture: run.architecture ? "完成" : "未执行",
        security: run.security ? "完成" : "未执行",
        ux: run.ux ? "完成" : "未执行",
        ui: run.ui ? "完成" : "未执行",
        dev: devStage,
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
