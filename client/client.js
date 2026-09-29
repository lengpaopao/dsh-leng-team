/**
 * dsh-leng-team — client bundle.
 *
 * Injects:
 *  1) "专家设置" settings side-nav section (grouped field form) — `settings.section`
 *  （V9.3：无微型办公室、无动画、无 /team world；仅业务真相 + 专家流程图）
 *
 * Loader contract (mirrors dshmarket): wrapped in `window.__ModuleLoader__.load(
 * { id, factory })`; browser deps (react) resolve through the host module table.
 */
window.__ModuleLoader__.load({ id: "dsh-leng-team", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  var react = require("react");

  const NS = "dsh-leng-team";
  const SECTION_ID = NS;
  const SECTION_ORDER = 55;

  // debug logging — quiet by default; enable via localStorage["dsh-leng-team-debug"]="1"
  const dbg = (msg) => { try { if (window.localStorage.getItem("dsh-leng-team-debug") === "1") console.log(msg); } catch (e) {} };

  // =====================================================================
  //  1. EXPERT SETTINGS — grouped field form
  // =====================================================================
  const ROLE_KEYS = [
    ["product", "产品经理"], ["analyst", "需求分析师"], ["architect", "架构师"],
    ["security", "安全工程师"], ["ux", "UX交互设计师"], ["ui", "UI设计师"], ["design_review", "设计评审工程师"],
    ["frontend", "前端开发工程师"], ["backend", "后端开发工程师"], ["reviewer", "代码评审工程师"],
    ["tester", "专职测试工程师"], ["ops", "运维工程师"], ["docs", "文档工程师"],
    ["auditor", "审核工程师"]
  ];

  // 21 个条件角色（镜像 lib/roles.js CONDITIONAL_ROLES，供角色模型覆盖与条件角色启用组使用）
  const CONDITIONAL_KEYS = [
    ["discovery", "调查员"], ["tech_lead", "技术负责人/详细设计"], ["data", "数据/数据库工程师"],
    ["performance", "性能/可靠性工程师"], ["security_test", "安全测试工程师"], ["devops", "DevOps/CI-CD工程师"],
    ["release", "发布经理"], ["sre", "监控/SRE工程师"], ["accessibility", "无障碍专家"], ["i18n", "本地化专家"],
    ["statistics", "统计学家/方法论专家"], ["data_ethics", "数据伦理专家"], ["domain_expert", "领域专家"],
    ["seo", "SEO/渠道优化专家"], ["visual", "视觉设计师（content）"],
    ["data_design", "数据分析方案设计师"], ["research_design", "研究方案设计师"], ["content_design", "内容策划与评审"],
    ["data_execution", "数据分析执行工程师"], ["research_execution", "研究执行工程师"], ["content_execution", "内容执行工程师"]
  ];
  const ALL_ROLES_KEYS = ROLE_KEYS.concat(CONDITIONAL_KEYS);

  const GROUPS = [
    { title: "总开关", fields: [
      { key: "enabled", type: "toggle", label: "启用 dsh-leng-team", hint: "关闭后流水线与看门狗不启动。" },
    ]},
    { title: "触发与命令", fields: [
      { key: "trigger.primary", type: "text", label: "主命令", hint: "会话栏输入触发，如 /team。" },
      { key: "trigger.aliases", type: "text", label: "等价命令（逗号分隔）", hint: "与主命令完全等价，默认 /dsh-leng-team。" },
      { key: "trigger.customAliases", type: "text", label: "自定义别名（逗号分隔）", hint: "注册前做唯一性校验。" },
      { key: "trigger.conflictPolicy", type: "select", label: "命令冲突策略", options: ["useAlias", "block", "force"], hint: "useAlias=改用别名；block=禁用；force=强制覆盖。" },
    ]},
    { title: "席位池与并发（默认 5）", fields: [
      { key: "concurrency.maxConcurrent", type: "number", label: "最大子会话并发", min: 1, max: 5, hint: "全局硬上限 1–5（默认 5），输入大于 5 自动强制修正为 5。" },
      { key: "concurrency.queueStrategy", type: "select", label: "队列策略", options: ["fifo", "priority"], hint: "fifo=先进先出；priority=按优先级调度（P0<P1<P2<P3，P0/P1 预留席位）。" },
      { key: "concurrency.priorityEnabled", type: "toggle", label: "P0-P3 优先级", hint: "P0 可抢占排队位置，不强行终止运行中任务。" },
      { key: "concurrency.keyPathReserve", type: "toggle", label: "关键路径预留席位", hint: "关键门禁/审核不因 P3 占满席位而饿死。" },
      { key: "concurrency.reservedSeats", type: "number", label: "预留席位数（默认 1）", min: 0, max: 4, hint: "为 P0/P1 至少预留 1 席。" },
      { key: "concurrency.queueTimeoutMs", type: "number", label: "排队超时告警（毫秒）", min: 60000, max: 3600000 },
      { key: "concurrency.rps", type: "number", label: "令牌桶 RPS（全局每秒请求）", min: 1, max: 100, hint: "内置默认 8；限制全局 RPS 防 429。" },
      { key: "concurrency.burst", type: "number", label: "令牌桶突发容量（默认 100）", min: 10, max: 500, hint: "#58：突发上限，429 时补充速率降半。" },
      { key: "concurrency.platformCap", type: "number", label: "DSH 平台并发上限探测（1-5，默认 5）", min: 1, max: 5, hint: "#53：平台上限低于配置时自动降级并发。" },
      { key: "concurrency.rpm", type: "number", label: "令牌桶 RPM（全局每分钟请求）", min: 60, max: 6000, hint: "内置默认 240；限制全局 RPM 防 429。" },
      { key: "concurrency.backoffMs", type: "number", label: "429 退避时长（毫秒）", min: 100, max: 60000, hint: "默认 3000；瞬时抖动指数退避。" },
      { key: "concurrency.degradeThreshold", type: "number", label: "429 降级阈值（次数/窗口）", min: 1, max: 50, hint: "默认 3；超过阈值并发 5→3→2/1 自动降级。" },
      { key: "concurrency.degradeStrategy", type: "select", label: "429 恢复策略", options: ["progressive", "instant"], hint: "progressive=渐进恢复，不瞬时跳回 5。" },
      { key: "concurrency.globalPauseOn429", type: "toggle", label: "429 全局暂停", hint: "严重限流时全局暂停模型请求，并发自动降到 2 或 1，暂停期间快照落盘。" },
    ]},
    { title: "看门狗（默认 4 分钟）", fields: [
      { key: "watchdog.enabled", type: "toggle", label: "启用看门狗" },
      { key: "watchdog.intervalMs", type: "number", label: "轮询周期（毫秒）", min: 60000, max: 3600000, hint: "默认 240000 = 4 分钟。" },
      { key: "watchdog.similarityThreshold", type: "number", label: "语义相似度阈值", min: 0.5, max: 1, step: 0.05, hint: "多轮比对判定死循环，不误杀深度思考。" },
      { key: "watchdog.repeatRounds", type: "number", label: "连续重复轮次", min: 3, max: 20 },
      { key: "watchdog.maxRetries429", type: "number", label: "429 最大重试", min: 0, max: 10 },
      { key: "watchdog.backoffMs", type: "number", label: "退避时长（毫秒）", min: 100, max: 60000 },
      { key: "watchdog.freezeQueueOn429", type: "toggle", label: "持续限流冻结队列", hint: "防 429 雪崩。" },
      { key: "watchdog.zombieIdleMs", type: "number", label: "僵尸会话判定（毫秒）", min: 60000, max: 3600000 },
      { key: "watchdog.action", type: "select", label: "死循环处置", options: ["pause", "rebuild", "terminate"], hint: "pause=暂停会话；rebuild=重建会话；terminate=终止会话。" },
    ]},
    { title: "开发模块拆分", fields: [
      { key: "moduleSplit.enabled", type: "toggle", label: "按页面/接口自动拆分子任务", hint: "一页面一子会话、一接口一子会话。" },
      { key: "moduleSplit.aggregateThreshold", type: "number", label: "动态子工位聚合阈值", min: 3, max: 100 },
      { key: "moduleSplit.cacheEnabled", type: "toggle", label: "模块级缓存" },
      { key: "moduleSplit.reuseTemplates", type: "toggle", label: "重复模块复用模板" },
      { key: "moduleSplit.parsePrompt", type: "textarea", label: "文档解析规则", hint: "从设计文档提取页面/接口清单。" },
      { key: "moduleSplit.mergePrompt", type: "textarea", label: "模块产物合并规则" },
    ]},
    { title: "流程控制", fields: [
      { key: "flow.manualConfirm.requirement", type: "toggle", label: "需求定稿人工确认" },
      { key: "flow.manualConfirm.architecture", type: "toggle", label: "架构定稿人工确认" },
      { key: "flow.manualConfirm.ui", type: "toggle", label: "UI 定稿人工确认" },
      { key: "flow.manualConfirm.final", type: "toggle", label: "最终交付人工确认" },
      { key: "flow.autoConfirm", type: "toggle", label: "测试模式（需确认环节默认通过并标注）", hint: "默认关闭=正式模式（等待 /team confirm <key> 人工拍板，交付不混入测试模式）；开启=测试时默认通过并标注「需确认」。" },
      { key: "flow.confirmTimeoutMs", type: "number", label: "确认等待超时（毫秒）", min: 10000, max: 3600000, hint: "默认 300000 = 5 分钟。" },
      { key: "flow.maxRework", type: "number", label: "最大返工次数", min: 1, max: 10 },
      { key: "flow.requirementChangePolicy", type: "select", label: "需求变更策略", options: ["block", "routeBack"], hint: "block=阻止开发阶段改需求；routeBack=回退需求分析节点。" },
      { key: "flow.summaryTokenCap", type: "number", label: "摘要压缩 Token 上限", min: 500, max: 20000 },
    ]},
    { title: "角色模型覆盖（14 核心 + 21 条件角色，独立指定）", fields: ALL_ROLES_KEYS.flatMap(([key, label]) => [
      { key: "models." + key + ".provider", type: "text", label: label + " · 提供方", hint: "留空=继承父会话" },
      { key: "models." + key + ".model", type: "text", label: label + " · 模型", hint: "留空=继承父会话" },
    ])},
    { title: "角色定义与规则（14 核心角色系统提示词，可编辑）", fields: ROLE_KEYS.map(([key, label]) => ({ key: "roles." + key + ".personaCore", type: "textarea", label: label + " · 系统提示词", hint: "留空 = 使用内置默认提示词" })) },
    { title: "条件启用三方会签", fields: [
      { key: "conditional.enabled", type: "toggle", label: "启用条件角色机制", hint: "discovery/tech_lead/data/performance/security_test/devops/release/sre/accessibility/i18n 按条件启用。" },
      { key: "conditional.threeWaySignoff", type: "toggle", label: "三方会签", hint: "总指挥 + 调查员 + 产品经理，缺一不可。" },
      { key: "conditional.divergencePolicy", type: "select", label: "分歧处理", options: ["recordDissent", "escalate", "timeoutDisable"], hint: "recordDissent=两方一致记录异议；escalate=升级人工确认；timeoutDisable=超时默认禁用并记风险。" },
      { key: "conditional.timeoutPolicy", type: "select", label: "会签超时策略", options: ["defaultDisable", "defer", "enable"], hint: "defaultDisable=默认禁用条件角色并记录风险接受。" },
      { key: "conditional.trail", type: "toggle", label: "全程留痕" },
      { key: "conditional.finalAuditCheck", type: "toggle", label: "最终审核检查会签单", hint: "检查签名完整性、理由、分歧与超时记录。" },
    ]},
    { title: "全局回退预算", fields: [
      { key: "rollback.totalBudget", type: "number", label: "全局回退总预算", min: 1, max: 100, hint: "默认 10；达到总预算强制人工裁决，不再自动回退。" },
      { key: "rollback.perNodeBudget", type: "number", label: "单节点预算", min: 1, max: 20, hint: "默认 5。" },
      { key: "rollback.perEdgeBudget", type: "number", label: "单边预算", min: 1, max: 10, hint: "默认 3。" },
      { key: "rollback.windowSizeMs", type: "number", label: "滑动窗口（毫秒）", min: 300000, max: 3600000, hint: "默认 1800000 = 30 分钟。" },
      { key: "rollback.escalationThreshold", type: "number", label: "升级阈值", min: 1, max: 50, hint: "默认 8；窗口内回退超过阈值强制升级人工裁决。" },
    ]},
    { title: "独立复验（最终审核）", fields: [
      { key: "verification.enabled", type: "toggle", label: "启用独立复验" },
      { key: "verification.rounds", type: "number", label: "复验轮次", min: 1, max: 10, hint: "默认 3 轮抽样。" },
      { key: "verification.samples", type: "number", label: "抽样数", min: 1, max: 10, hint: "默认 3，覆盖不同模块/阶段/风险等级。" },
      { key: "verification.mirror", type: "toggle", label: "镜像复验", hint: "对关键产物重新生成对照产物并比对。" },
      { key: "verification.mirrorBudgetRatio", type: "number", label: "镜像复验 Token 预算比例（0-1，默认 0.1）", min: 0.01, max: 1, step: 0.05, hint: "#45：超预算降级语义比对。" },
      { key: "verification.conditionalConfirm", type: "toggle", label: "有条件合格用户确认（超时默认不合格）", hint: "#46：用户确认不可超时跳过。" },
      { key: "verification.blind", type: "toggle", label: "盲审", hint: "不读取执行角色「完成声明」，只读产物与证据。" },
      { key: "verification.counter", type: "toggle", label: "反方质询", hint: "显式列出「为什么可能不合格」并逐条验证。" },
      { key: "verification.evidenceIndependent", type: "toggle", label: "证据链独立", hint: "只读原始产物、证据索引、问题池、快照。" },
      { key: "verification.externalBaseline", type: "toggle", label: "外部对照", hint: "复刻类对照源项目基线；非复刻类对照原始需求快照与验收标准。" },
    ]},
    { title: "角色边界", fields: [
      { key: "roleBoundary.forceNonResponsibilities", type: "toggle", label: "强制声明「不负责什么」", hint: "每个角色 systemPrompt 必须包含负责/不负责边界。" },
      { key: "roleBoundary.crossRoleReport", type: "toggle", label: "越权处理", hint: "发现越权请求拒绝执行并写入问题池 P2。" },
      { key: "roleBoundary.conflictEscalation", type: "toggle", label: "职责冲突上报", hint: "相邻角色职责冲突上报总指挥，进入问题池 P2。" },
    ]},
    { title: "缓存键完整化", fields: [
      { key: "cacheKey.includeConditionalVersions", type: "toggle", label: "条件角色产物版本单列", hint: "每个条件角色产物版本独立进缓存键。" },
      { key: "cacheKey.strictVersionCheck", type: "toggle", label: "版本完整校验", hint: "版本不匹配不得复用缓存。" },
      { key: "cacheKey.recordHit", type: "toggle", label: "缓存命中记录" },
      { key: "cacheKey.recordMiss", type: "toggle", label: "缓存失效记录" },
    ]},
    { title: "可观测性", fields: [
      { key: "observability.enabled", type: "toggle", label: "启用可观测性" },
      { key: "observability.panelEnabled", type: "toggle", label: "启用面板" },
      { key: "observability.refreshMs", type: "number", label: "面板刷新（毫秒）", min: 1000, max: 60000 },
      { key: "observability.exportJson", type: "toggle", label: "支持导出 JSON" },
    ]},
    { title: "成本控制", fields: [
      { key: "cost.summaryIndex", type: "toggle", label: "摘要 + 产物索引" },
      { key: "cost.moduleCache", type: "toggle", label: "模块级缓存" },
      { key: "cost.reuseModules", type: "toggle", label: "重复模块复用" },
      { key: "cost.tieredModels", type: "toggle", label: "按角色分级模型" },
    ]},
    { title: "提示词注入防护", fields: [
      { key: "security.inputIsolation", type: "toggle", label: "父会话输入隔离" },
      { key: "security.blockPrivilege", type: "toggle", label: "越权指令拦截" },
      { key: "security.blockSensitive", type: "toggle", label: "敏感指令过滤" },
      { key: "security.appendGuard", type: "toggle", label: "角色提示词追加约束" },
    ]},
    { title: "版本管理", fields: [
      { key: "version.personaVersion", type: "text", label: "提示词模板版本" },
      { key: "version.rollbackEnabled", type: "toggle", label: "支持回滚" },
      { key: "version.abTestEnabled", type: "toggle", label: "A/B 测试" },
    ]},
    { title: "任务类型识别", fields: [
      { key: "taskType.enabled", type: "toggle", label: "启用任务类型识别" },
      { key: "taskType.replicateKeywords", type: "text", label: "复刻类关键词（逗号分隔）", hint: "默认：复刻,克隆,仿照,参照,重写,二开,还原,重建,照搬。" },
      { key: "taskType.pathPattern", type: "text", label: "路径信号模式（source→target）" },
      { key: "taskType.intentDetection", type: "toggle", label: "意图识别（现有项目/桌面文件夹）" },
    ]},
    { title: "复刻模式", fields: [
      { key: "replicate.forceInvestigation", type: "toggle", label: "复刻/迁移/重构/二开强制调查" },
      { key: "replicate.depth", type: "select", label: "调查深度", options: ["light", "standard", "deep"], hint: "复刻类默认 deep。" },
      { key: "replicate.sourceReadonly", type: "toggle", label: "源目录只读", hint: "调查员只读盘点源项目，不修改源项目。" },
      { key: "replicate.skipAllowed", type: "toggle", label: "允许跳过调查（复刻类默认禁止）" },
    ]},
    { title: "调查自动触发", fields: [
      { key: "discoveryTrigger.enabled", type: "toggle", label: "启用自动触发评估" },
      { key: "discoveryTrigger.mode", type: "select", label: "触发模式", options: ["force", "auto", "skip"] },
      { key: "discoveryTrigger.threshold", type: "number", label: "自动触发阈值（≥10 强制 deep）", min: 1, max: 20, hint: "默认 6：≥10 强制 deep；6–9 standard；3–5 light；<3 跳过。" },
      { key: "discoveryTrigger.depthMapping", type: "text", label: "深度映射（light/standard/deep）" },
      { key: "discoveryTrigger.domainDefault", type: "text", label: "领域默认策略" },
      { key: "discoveryTrigger.userOverride", type: "toggle", label: "允许用户显式覆盖" },
      { key: "discoveryTrigger.recordSkip", type: "toggle", label: "跳过记录" },
      { key: "discoveryTrigger.maxLoops", type: "number", label: "最大回环", min: 1, max: 5 },
      { key: "discoveryTrigger.escalation", type: "text", label: "超限升级策略" },
    ]},
    { title: "调查评分权重", fields: [
      { key: "discoveryWeights.goal", type: "number", label: "目标模糊度（0-3）", min: 0, max: 5 },
      { key: "discoveryWeights.requirement", type: "number", label: "需求不确定性", min: 0, max: 5 },
      { key: "discoveryWeights.tech", type: "number", label: "技术不确定性", min: 0, max: 5 },
      { key: "discoveryWeights.data", type: "number", label: "数据不确定性", min: 0, max: 5 },
      { key: "discoveryWeights.risk", type: "number", label: "风险等级", min: 0, max: 5 },
      { key: "discoveryWeights.compliance", type: "number", label: "合规要求", min: 0, max: 5 },
      { key: "discoveryWeights.scale", type: "number", label: "任务规模", min: 0, max: 5 },
      { key: "discoveryWeights.existing", type: "number", label: "已有资料（-2）", min: -5, max: 0 },
      { key: "discoveryWeights.time", type: "number", label: "时间约束（-1）", min: -5, max: 0 },
    ]},
    { title: "调查员", fields: [
      { key: "discovery.enabled", type: "toggle", label: "启用调查员" },
      { key: "discovery.depth", type: "select", label: "调查深度", options: ["light", "standard", "deep"] },
      { key: "discovery.evidenceSources", type: "text", label: "证据源" },
      { key: "discovery.skipWhenClear", type: "toggle", label: "目标明确可跳过" },
      { key: "discovery.sufficiencyGate", type: "toggle", label: "调查充分性门禁" },
      { key: "discovery.maxRounds", type: "number", label: "最大回环（3-8 次）", min: 3, max: 8 },
    ]},
    { title: "调查产物", fields: [
      { key: "discoveryArtifacts.schema", type: "text", label: "产物 Schema" },
      { key: "discoveryArtifacts.index", type: "toggle", label: "产物索引" },
      { key: "discoveryArtifacts.summary", type: "toggle", label: "摘要" },
      { key: "discoveryArtifacts.evidenceChain", type: "toggle", label: "证据链" },
      { key: "discoveryArtifacts.version", type: "text", label: "产物版本" },
    ]},
    { title: "设计闭环", fields: [
      { key: "designClosure.crossReview", type: "toggle", label: "设计交叉评审" },
      { key: "designClosure.gate", type: "toggle", label: "设计评审门禁" },
      { key: "designClosure.contractFreeze", type: "toggle", label: "设计契约冻结" },
      { key: "designClosure.designTest", type: "toggle", label: "设计测试（纳入专职测试与回归）" },
      { key: "designClosure.maxRounds", type: "number", label: "设计回退最大次数", min: 1, max: 5 },
    ]},
    { title: "角色启用（条件角色按领域与条件启用）", fields: CONDITIONAL_KEYS.map(([key, label]) => ({ key: "roleEnable." + key, type: "toggle", label: label + "（false=强制禁用）" })) },
    { title: "质量门禁回环", fields: [
      { key: "qualityGate.problemLevels", type: "text", label: "问题分级" },
      { key: "qualityGate.maxLoops", type: "number", label: "最大回环", min: 1, max: 10 },
      { key: "qualityGate.forceReviewExecution", type: "toggle", label: "执行类强制复核" },
      { key: "qualityGate.riskAcceptance", type: "text", label: "风险接受权限" },
      { key: "qualityGate.blockOnOpenPool", type: "toggle", label: "未关闭问题池阻断最终审核" },
      { key: "qualityGate.p3AutoAccept", type: "toggle", label: "P3 自动接受（限制范围并公示）" },
    ]},
    { title: "角色包", fields: [
      { key: "rolePack.enabled", type: "toggle", label: "领域角色包启用" },
      { key: "rolePack.domain", type: "text", label: "默认领域角色包" },
      { key: "rolePack.persona", type: "text", label: "角色 System Prompt 来源" },
      { key: "rolePack.modelTier", type: "text", label: "模型分级" },
    ]},
    { title: "最终全功能回归", fields: [
      { key: "finalRegression.enabled", type: "toggle", label: "启用最终全功能回归" },
      { key: "finalRegression.environment", type: "text", label: "回归环境" },
      { key: "finalRegression.coverage", type: "text", label: "覆盖范围" },
      { key: "finalRegression.replicaCompare", type: "toggle", label: "复刻类源目标对比" },
      { key: "finalRegression.blockIfFail", type: "toggle", label: "未通过阻断最终审核" },
      { key: "finalRegression.tiers", type: "text", label: "分层执行（core,conditional,optional）", hint: "#57：核心必跑/条件执行/可选抽样。" },
      { key: "finalRegression.timeBudgetMs", type: "number", label: "回归时间预算（毫秒，默认 1800000=30 分钟）", min: 60000, max: 7200000, hint: "#57：超时第三层降级抽样。" },
    ]},
    { title: "部署环境适配器（#54）", fields: [
      { key: "deployEnv.adapter", type: "select", label: "环境适配器", options: ["local_process", "container", "remote", "simulated"] },
      { key: "deployEnv.adapters", type: "text", label: "可用适配器列表（逗号分隔）" },
    ]},
    { title: "最终审核三态", fields: [
      { key: "finalReview.threeState", type: "toggle", label: "三态结论（合格/有条件合格/不合格）" },
      { key: "finalReview.p2UserConfirm", type: "toggle", label: "P2 风险接受需用户确认" },
      { key: "finalReview.p3LimitedScope", type: "toggle", label: "P3 限制范围并公示" },
      { key: "finalReview.dualPersonClassification", type: "toggle", label: "问题分级双人复核" },
      { key: "finalReview.independentVerification", type: "toggle", label: "独立复验写入快照" },
    ]},
    { title: "最终审核（源基线对比/调查报告/差异清单/调查闭环/设计闭环/回归/复验 7 项检查）", fields: [
      { key: "finalAudit.baselineCompare", type: "toggle", label: "源基线对比（复刻类对照源项目基线）" },
      { key: "finalAudit.artifactReportCheck", type: "toggle", label: "调查报告检查" },
      { key: "finalAudit.diffListCheck", type: "toggle", label: "差异清单检查" },
      { key: "finalAudit.investigationClosureCheck", type: "toggle", label: "调查闭环检查" },
      { key: "finalAudit.designClosureCheck", type: "toggle", label: "设计闭环检查" },
      { key: "finalAudit.finalRegressionCheck", type: "toggle", label: "最终回归检查" },
      { key: "finalAudit.verificationCheck", type: "toggle", label: "独立复验检查" },
    ]},
    { title: "领域模板", fields: [
      { key: "domainTemplate.default", type: "text", label: "默认模板" },
      { key: "domainTemplate.selectable", type: "text", label: "可选模板" },
      { key: "domainTemplate.autoDetect", type: "toggle", label: "auto 识别" },
      { key: "domainTemplate.version", type: "text", label: "模板版本" },
      { key: "domainTemplate.autoConfirmTimeout", type: "text", label: "auto 确认超时" },
    ]},
    { title: "可量化验收（方案 17 硬指标，运行时核算）", fields: [
      { key: "acceptance.p0p1BlockRate", type: "number", label: "P0/P1 阻断率（%）", min: 0, max: 100 },
      { key: "acceptance.p2RecordRate", type: "number", label: "P2 问题池记录率（%）", min: 0, max: 100 },
      { key: "acceptance.p2CloseConfirmRate", type: "number", label: "P2 合法关闭或用户确认率（%）", min: 0, max: 100 },
      { key: "acceptance.p3TraceRate", type: "number", label: "P3 留痕率（%）", min: 0, max: 100 },
      { key: "acceptance.rollbackVersionRate", type: "number", label: "回退版本递增率（%）", min: 0, max: 100 },
      { key: "acceptance.staleRate", type: "number", label: "下游 stale 标记率（%）", min: 0, max: 100 },
      { key: "acceptance.riskAcceptRate", type: "number", label: "风险接受记录率（%）", min: 0, max: 100 },
      { key: "acceptance.signoffRate", type: "number", label: "会签留痕率（%）", min: 0, max: 100 },
      { key: "acceptance.finalAuditRate", type: "number", label: "最终审核检查率（%）", min: 0, max: 100 },
      { key: "acceptance.independentVerificationRate", type: "number", label: "独立复验执行率（%）", min: 0, max: 100 },
      { key: "acceptance.rollbackBudgetRate", type: "number", label: "回退预算执行率（%）", min: 0, max: 100 },
      { key: "acceptance.cacheKeyRate", type: "number", label: "缓存键版本完整率（%）", min: 0, max: 100 },
      { key: "acceptance.roleBoundaryRate", type: "number", label: "角色边界声明完整率（%）", min: 0, max: 100 },
    ]},
  ];

  function getPath(obj, path) { const p = path.split("."); let v = obj; for (const k of p) { if (v == null) return undefined; v = v[k]; } return v; }
  function setPath(obj, path, value) { const p = path.split("."); const out = Object.assign({}, obj); let cur = out; for (let i = 0; i < p.length - 1; i++) { const nv = (cur[p[i]] && typeof cur[p[i]] === "object") ? Object.assign({}, cur[p[i]]) : {}; cur[p[i]] = nv; cur = nv; } cur[p[p.length - 1]] = value; return out; }
  function clampNum(n, min, max) { n = Number(n); if (!isFinite(n)) return min; if (min !== undefined && n < min) n = min; if (max !== undefined && n > max) n = max; return n; }

  // =====================================================================
  //  Client-side default parameter mirror.
  //  Source of truth: lib/config.js `DEFAULTS` + lib/roles.js `personaCore`.
  //  When the settings namespace has no saved value (empty/partial scope
  //  snapshot or a partial remote payload), the panel merges the loaded
  //  config over these defaults so every parameter shows its CURRENT
  //  DEFAULT value and is never left blank. Keep in sync when defaults change.
  // =====================================================================
  const DEFAULT_ROLE_MODEL = { provider: "freehub-deepseek-v4-flash-glm5-2-3", model: "glm-5.2" };
  const DEFAULTS = {
    enabled: true,
    trigger: { primary: "/team", aliases: ["/dsh-leng-team"], conflictPolicy: "useAlias", customAliases: [] },
    concurrency: { maxConcurrent: 5, queueStrategy: "fifo", queueTimeoutMs: 600000, priorityEnabled: true, keyPathReserve: true, reservedSeats: 1, rps: 8, burst: 100, platformCap: 5, rpm: 240, backoffMs: 3000, degradeThreshold: 3, degradeStrategy: "progressive", globalPauseOn429: true },
    watchdog: { enabled: true, intervalMs: 240000, similarityThreshold: 0.85, repeatRounds: 6, maxRetries429: 3, backoffMs: 3000, freezeQueueOn429: true, zombieIdleMs: 300000, action: "pause" },
    moduleSplit: { enabled: true, parsePrompt: "", mergePrompt: "", aggregateThreshold: 8, cacheEnabled: true, reuseTemplates: true },
    flow: { manualConfirm: { requirement: true, architecture: true, ui: true, final: true }, autoConfirm: false, confirmTimeoutMs: 300000, maxRework: 3, requirementChangePolicy: "routeBack", summaryTokenCap: 4000 },
    models: Object.fromEntries(ALL_ROLES_KEYS.map(([key]) => [key, { provider: DEFAULT_ROLE_MODEL.provider, model: DEFAULT_ROLE_MODEL.model }])),
    roles: {
      product:   { personaCore: "你是专业资深产品经理，隶属于 dsh-leng-team 研发团队。你严格遵守团队角色边界，只负责产品需求梳理、产品规则定义、需求优先级管理、验收标准制定。禁止参与架构、开发、测试、设计、文档工作。你的工作输入为用户原始诉求，你的工作目标是把模糊需求转化为结构化、可落地、可验收的产品需求规范。你需要梳理业务场景、用户角色、操作路径、核心功能、非功能诉求、需求禁忌。你需要区分刚需与优化项，排出功能优先级，输出清晰的产品需求文档与验收标准。所有输出必须结构化、条理清晰、无歧义。你不擅自扩展功能，不擅自删减用户诉求，遇到模糊点整理疑问等待用户确认。工作完成后规范交付产物，等待下一环节流转。" },
      analyst:   { personaCore: "你是专业需求分析师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责需求深度拆解、需求边界定义、风险分析、约束分析、场景补全、多方案设计。不做产品定义、不做架构、不做开发、不做设计。基于产品经理输出的需求规范，你需要挖掘隐性需求、排除无效需求、定义需求边界、识别业务风险、技术约束、场景漏洞。你必须输出至少两套可落地的实现方案，对比优缺点、适用场景、成本、稳定性、扩展性。支持多轮对话调整方案，直至用户确认最终方案。输出内容必须完整、严谨、可直接交付架构师使用。" },
      architect: { personaCore: "你是资深软件架构师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责系统整体架构设计、模块拆分、技术选型、接口定义、数据结构设计、依赖管理、部署架构规划。不做具体页面开发、不写业务代码、不做测试。基于已定需求方案，你输出完整架构文档，包含整体架构图文字描述、模块职责、模块依赖、接口清单、数据流转、技术栈选型、性能方案、扩展性方案、兼容方案。架构必须规范、可落地、可开发、可维护、可扩展，规避常见架构缺陷，为前后端开发、安全审计提供完整依据。重要约束：架构必须严格匹配项目实际类型与规模——纯前端/单页/轻量工具类项目只输出相应规模的前端或轻量架构（如单文件 HTML+CSS+JS、SPA 结构、纯静态部署），明确禁止套用企业级微服务/分布式/容器编排/Spring Cloud/K8s 等与项目无关的架构模板；技术选型必须服务于项目需求本身，不得引入项目不需要的组件与服务。" },
      security:  { personaCore: "你是专业安全工程师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责架构安全审计、业务安全风险排查、数据安全、权限安全、接口安全、漏洞风险检测。基于架构师输出的架构方案，你逐项审计安全隐患，包含越权访问、SQL 注入、XSS、权限缺失、数据泄露、接口暴露风险、参数校验缺失、登录安全、密钥安全、日志安全。输出安全审计报告与具体整改建议，明确必须修复项与优化项，反馈架构师迭代修正，确保整体架构符合安全规范。输出格式要求：报告末尾必须有 `## 安全审计结论` 小节——重大问题逐条以 `必须修复：<问题>（对应环节）` 列出；一般问题逐条以 `建议优化：<问题>（对应环节）` 列出；无重大问题则只列建议优化项。" },
      ux:        { personaCore: "你是专业 UX 交互设计师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责产品交互逻辑、用户操作流程、页面跳转规则、状态逻辑、交互反馈、异常场景交互设计。不负责视觉配色、不写代码、不做测试。基于需求与架构规范，你输出完整交互设计文档，包含全部页面跳转逻辑、按钮交互、弹窗交互、加载状态、空状态、报错状态、权限状态、用户操作路径、场景闭环。保证交互流畅、逻辑闭环、无操作漏洞、符合用户使用习惯，为 UI 视觉设计提供完整交互依据。" },
      ui:        { personaCore: "你是专业 UI 视觉设计师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责页面视觉设计、布局规范、配色体系、组件样式、字体规范、图标规范、页面整体视觉风格。基于 UX 交互文档，你输出全套页面视觉规范、页面布局方案、统一设计风格、全局组件样式定义。保证界面统一、美观、规整、适配友好，为前端开发提供完整可落地的视觉标准。不干预交互逻辑、不参与后端开发、不参与测试。" },
      frontend:  { personaCore: "你是专业前端开发工程师，隶属于 dsh-leng-team 研发团队。你当前仅负责【当前指定单一页面/单一功能模块】的前端开发工作。严格遵守角色边界，只完成当前模块页面结构、样式还原、交互实现、接口联调、页面适配、状态管理、页面闭环开发。不开发其他页面、不开发后端接口、不做测试、不修改架构。严格按照 UI 规范、UX 交互逻辑、架构接口文档开发，代码规范、结构清晰、可维护、无冗余、无报错。完成当前模块完整可运行代码与开发说明，规范提交产物，等待汇总与评审。" },
      backend:   { personaCore: "你是专业后端开发工程师，隶属于 dsh-leng-team 研发团队。你当前仅负责【当前指定单一接口/单一功能模块】的后端开发工作。严格遵守角色边界，只完成当前模块接口开发、数据处理、参数校验、业务逻辑、数据库处理、异常捕获、返回规范。严格按照架构设计、接口规范、安全要求开发，代码规范、逻辑严谨、无漏洞、可复用、可扩展。不开发前端页面、不参与设计、不自行修改架构。完成当前模块完整接口代码与接口说明，规范提交产物。" },
      reviewer:  { personaCore: "你是专业代码评审工程师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责全量代码静态审查、代码规范检查、逻辑漏洞检查、安全隐患检查、冗余代码检查、性能问题检查。不新增开发功能、不修改需求、不做功能测试。针对前后端全部代码逐模块评审，输出详细评审报告，标记规范问题、逻辑 BUG、安全风险、不合理设计、可优化点。精准定位问题模块、给出明确修改方案，退回对应开发模块整改，全部问题修复后方可进入测试阶段。输出格式要求：报告末尾必须有 `## 评审结论` 小节——先写 `评审结论：通过/不通过`；不通过时逐条列出 `问题模块：<模块ID/页面名/接口名>`（每条占一行，必须与开发模块清单中的编号或页面/接口名称一致），随后给出该模块的具体问题与修复要求。" },
      tester:    { personaCore: "你是专业软件测试工程师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责功能测试、场景测试、边界测试、异常测试、回归测试、缺陷记录。基于需求文档、产品规范、设计产物，你编写完整测试用例，全覆盖业务场景、边界场景、异常场景、权限场景。逐项测试功能可用性、流程闭环性、数据准确性、交互正确性。输出详细测试报告与缺陷清单，精准对应页面与接口模块，退回开发整改，整改完成后执行回归测试，确保所有缺陷闭环。输出格式要求：报告末尾必须有 `## 测试结论` 小节——先写 `测试结论：通过/不通过`；不通过时逐条列出 `问题模块：<模块ID/页面名/接口名>`（每条占一行，必须与开发模块清单中的编号或页面/接口名称一致），并注明具体缺陷与复现路径。" },
      ops:       { personaCore: "你是专业运维工程师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责项目环境搭建、部署流程、配置文件、服务启动、端口配置、依赖安装、上线规范、运维说明文档。不参与开发、不参与测试。基于最终可运行工程，你输出完整部署文档、环境要求、安装步骤、启动命令、配置说明、常见部署问题解决方案，保证项目可顺利部署、稳定运行。" },
      docs:      { personaCore: "你是专业文档工程师，隶属于 dsh-leng-team 研发团队。你严格遵守角色边界，只负责全流程产物汇总、标准化文档编写、交付资料整理。汇总需求文档、方案文档、架构文档、安全文档、设计文档、代码说明、测试报告、运维部署文档。整理成结构统一、内容完整、条理清晰的全套交付文档，包含项目介绍、功能说明、使用手册、开发说明、部署说明、注意事项、版本说明，形成完整可交付项目资料包。" },
      auditor:   { personaCore: "你是项目最终审核总工程师，隶属于 dsh-leng-team 研发团队。你负责项目全产物最终验收、需求匹配校验、质量兜底把关。你对照用户原始需求、产品规范、设计标准、架构标准、测试结果、交付文档，整体复核项目是否完整达标、无遗漏、无偏差、无缺失、无重大风险。全面校验功能完整性、逻辑正确性、交付完整性、文档规范性。发现偏差与缺失精准定位对应环节，要求整改；全部达标后确认项目最终交付完成。最终审核必须检查「未关闭问题池」：存在未关闭的一般问题（P2）且未被风险接受时，审核结论必须为「不通过」并逐条指明问题 ID 与整改要求；P3 建议项可风险接受，但必须在审核结论中明确记录。审核结论中必须包含问题池处理结果（全部关闭/风险接受/退回整改）。" },
    },
    conditional: { enabled: true, threeWaySignoff: true, divergencePolicy: "recordDissent", timeoutPolicy: "defaultDisable", trail: true, finalAuditCheck: true },
    rollback: { totalBudget: 10, perNodeBudget: 5, perEdgeBudget: 3, windowSizeMs: 1800000, escalationThreshold: 8 },
    verification: { enabled: true, rounds: 3, samples: 3, mirror: true, mirrorBudgetRatio: 0.1, conditionalConfirm: true, blind: true, counter: true, evidenceIndependent: true, externalBaseline: true },
    roleBoundary: { forceNonResponsibilities: true, crossRoleReport: true, conflictEscalation: true },
    cacheKey: { includeConditionalVersions: true, strictVersionCheck: true, recordHit: true, recordMiss: true },
    taskType: { enabled: true, replicateKeywords: "复刻,克隆,仿照,参照,重写,二开,还原,重建,照搬", pathPattern: "source→target", intentDetection: true },
    replicate: { forceInvestigation: true, depth: "deep", sourceReadonly: true, skipAllowed: false },
    discovery: { enabled: true, depth: "standard", evidenceSources: "内置", skipWhenClear: true, sufficiencyGate: true, maxRounds: 5 },
    discoveryTrigger: { enabled: true, mode: "auto", threshold: 6, depthMapping: "light/standard/deep", domainDefault: "领域默认", userOverride: true, recordSkip: true, maxLoops: 2, escalation: "人工裁决" },
    discoveryWeights: { goal: 3, requirement: 3, tech: 3, data: 3, risk: 3, compliance: 3, scale: 2, existing: -2, time: -1 },
    discoveryArtifacts: { schema: "内置", index: true, summary: true, evidenceChain: true, version: "1.0.0" },
    designClosure: { crossReview: true, gate: true, contractFreeze: true, designTest: true, maxRounds: 3 },
    roleEnable: Object.fromEntries(CONDITIONAL_KEYS.map(([key]) => [key, true])),
    qualityGate: { problemLevels: "P0-P3", maxLoops: 3, forceReviewExecution: true, riskAcceptance: "P0/P1禁止", blockOnOpenPool: true, p3AutoAccept: true },
    rolePack: { enabled: true, domain: "software", persona: "内置", modelTier: "high/mid/low" },
    finalRegression: { enabled: true, environment: "准生产", coverage: "全部功能+设计+性能+安全+无障碍+i18n", replicaCompare: true, blockIfFail: true, tiers: "core,conditional,optional", timeBudgetMs: 1800000 },
    deployEnv: { adapter: "local_process", adapters: ["local_process", "container", "remote", "simulated"] },
    finalReview: { threeState: true, p2UserConfirm: true, p3LimitedScope: true, dualPersonClassification: true, independentVerification: true },
    finalAudit: { baselineCompare: true, artifactReportCheck: true, diffListCheck: true, investigationClosureCheck: true, designClosureCheck: true, finalRegressionCheck: true, verificationCheck: true },
    domainTemplate: { default: "software", selectable: "全部", autoDetect: true, version: "1.0.0", autoConfirmTimeout: "超时不启动" },
    acceptance: { p0p1BlockRate: 100, p2RecordRate: 100, p2CloseConfirmRate: 100, p3TraceRate: 100, rollbackVersionRate: 100, staleRate: 100, riskAcceptRate: 100, signoffRate: 100, finalAuditRate: 100, independentVerificationRate: 100, rollbackBudgetRate: 100, cacheKeyRate: 100, roleBoundaryRate: 100 },
    observability: { enabled: true, panelEnabled: true, refreshMs: 5000, show: ["dag", "queue", "seats", "token", "watchdog", "anomaly", "rework", "handover", "rollback", "signoff", "verification", "rate", "discovery", "gate", "design", "performance", "security_test", "release", "sre", "ci_cd", "accessibility", "i18n", "cache_miss"], exportJson: true },
    cost: { summaryIndex: true, moduleCache: true, reuseModules: true, tieredModels: true },
    security: { inputIsolation: true, blockPrivilege: true, blockSensitive: true, appendGuard: true },
    version: { personaVersion: "1.0.0", rollbackEnabled: true, abTestEnabled: false },
  };

  // Deep-merge a loaded/partial config over DEFAULTS so every parameter keeps a
  // value (missing keys fall back to the current default; arrays are copied).
  function mergeWithDefaults(raw) {
    const src = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
    const merge = (def, s) => {
      if (Array.isArray(def)) {
        if (Array.isArray(s)) return s.slice();
        return def.slice();
      }
      if (def && typeof def === "object") {
        const out = {};
        for (const k of Object.keys(def)) {
          const sv = (s && typeof s === "object" && !Array.isArray(s) && k in s) ? s[k] : undefined;
          out[k] = merge(def[k], sv);
        }
        if (s && typeof s === "object" && !Array.isArray(s)) {
          for (const k of Object.keys(s)) if (!(k in out)) out[k] = s[k];
        }
        return out;
      }
      return (s === undefined || s === null) ? def : s;
    };
    return merge(DEFAULTS, src);
  }

  function ExpertPanel(props) {
    const React = react;
    const [scope, setScope] = React.useState(props.scope || null);
    const [config, setConfig] = React.useState(null);
    const [open, setOpen] = React.useState({});
    const [msg, setMsg] = React.useState("");
    const [mode, setMode] = React.useState("scope"); // "scope" | "remote" | "failed"
    React.useEffect(() => {
      if (props.scope) { setScope(props.scope); return; }
      if (props.onScopeReady) { const off = props.onScopeReady((sc) => setScope(sc)); return typeof off === "function" ? off : undefined; }
      return undefined;
    }, [props.scope]);
    // Decide which channel to use once we have scope (or know it is unavailable).
    React.useEffect(() => {
      // No scope at all on this deployment -> remote command channel directly.
      if (!scope && config === null) {
        setMode("remote");
        if (props.remoteRun) {
          props.remoteRun("/team config get").then((res) => {
            const data = res && res.data !== undefined ? res.data : res;
            if (data && typeof data === "object" && !Array.isArray(data)) { setConfig(mergeWithDefaults(data)); return; }
            setConfig(mergeWithDefaults({}));
          }).catch((e) => { console.error("[dsh-leng-team] remote cfg load", e); setConfig(mergeWithDefaults({})); });
        } else { setConfig(mergeWithDefaults({})); }
        return undefined;
      }
      if (!scope) return undefined;
      let snap = null;
      try { snap = scope.getSnapshot(); } catch (e) { snap = null; }
      const usable = snap && (snap.status === "ready" || (snap.value !== undefined && snap.value !== null));
      if (usable && config === null) {
        setMode("scope");
        try { setConfig(mergeWithDefaults(snap.value ? JSON.parse(JSON.stringify(snap.value)) : {})); } catch (e) { console.error("[dsh-leng-team] load cfg", e); setConfig(mergeWithDefaults({})); }
        return undefined;
      }
      // Scope bound but namespace missing on this deployment -> use remote command channel.
      if (!usable && config === null) {
        setMode("remote");
        if (props.remoteRun) {
          props.remoteRun("/team config get").then((res) => {
            const data = res && res.data !== undefined ? res.data : res;
            if (data && typeof data === "object" && !Array.isArray(data)) { setConfig(mergeWithDefaults(data)); return; }
            setConfig(mergeWithDefaults({}));
          }).catch((e) => { console.error("[dsh-leng-team] remote cfg load", e); setConfig(mergeWithDefaults({})); });
        } else { setConfig(mergeWithDefaults({})); }
        return undefined;
      }
      return undefined;
    }, [scope, config]);
    if (config === null) return React.createElement("div", { style: { padding: "16px", opacity: 0.8 } }, "专家设置正在加载…");
    if (mode === "failed") return React.createElement("div", { style: { padding: "16px", opacity: 0.8 } }, "专家设置暂不可用：" + msg);
    function fieldValue(f) { const v = getPath(config, f.key); if (v === undefined || v === null) return ""; if (Array.isArray(v)) return v.join(", "); return String(v); }
    function updateField(f, raw) {
      let val;
      if (f.type === "toggle") val = raw;
      else if (f.type === "number") val = clampNum(raw, f.min, f.max);
      else val = raw;
      const cur = getPath(config, f.key);
      if (Array.isArray(cur)) val = String(raw).split(",").map((sp) => sp.trim()).filter(Boolean);
      setConfig(setPath(config, f.key, val));
    }
    function renderControl(f) {
      const style = { padding: "5px 9px", borderRadius: 6, border: "1px solid rgba(127,127,127,.45)", background: "transparent", color: "inherit", fontSize: 13, width: 320, boxSizing: "border-box" };
      if (f.type === "toggle") return React.createElement("label", { style: { display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 } },
        React.createElement("input", { type: "checkbox", checked: !!getPath(config, f.key), onChange: (e) => updateField(f, e.target.checked) }),
        React.createElement("span", null, getPath(config, f.key) ? "开" : "关"));
      if (f.type === "select") return React.createElement("select", { value: fieldValue(f), onChange: (e) => updateField(f, e.target.value), style }, (f.options || []).map((o) => React.createElement("option", { key: o, value: o }, o)));
      if (f.type === "textarea") return React.createElement("textarea", { value: fieldValue(f), onChange: (e) => updateField(f, e.target.value), spellCheck: false, placeholder: fieldValue(f) === "" ? "默认：空（可选填写）" : undefined, style: Object.assign({}, style, { width: 420, minHeight: 64 }) });
      if (f.type === "number") return React.createElement("input", { type: "number", value: fieldValue(f), step: f.step || 1, min: f.min, max: f.max, onChange: (e) => updateField(f, e.target.value), style });
      return React.createElement("input", { type: "text", value: fieldValue(f), onChange: (e) => updateField(f, e.target.value), spellCheck: false, placeholder: fieldValue(f) === "" ? "默认：空（可选填写）" : undefined, style });
    }
    function save() {
      try {
        setMsg("保存中…");
        if (mode === "scope" && scope && typeof scope.mutate === "function") {
          scope.mutate([{ op: "set", path: [], value: config }]).then(() => setMsg("已保存")).catch((e) => setMsg("保存失败: " + String(e && e.message ? e.message : e)));
          return;
        }
        if (props.remoteRun) {
          props.remoteRun("/team config set " + JSON.stringify(config)).then((res) => {
            const ok = res && (res.ok === true || res.ok === undefined);
            setMsg(ok ? "已保存（remote）" : "保存失败: " + String(res && res.message ? res.message : JSON.stringify(res)));
          }).catch((e) => setMsg("保存失败: " + String(e && e.message ? e.message : e)));
          return;
        }
        setMsg("保存失败: 无可用保存通道");
      } catch (e) { setMsg("保存异常: " + String(e && e.message ? e.message : e)); }
    }
    return React.createElement("div", { style: { padding: "14px 20px 24px" } },
      React.createElement("h3", { style: { margin: "0 0 6px", fontSize: 16 } }, "dsh-leng-team 专家设置"),
      React.createElement("p", { style: { margin: "0 0 14px", opacity: 0.72, fontSize: 12 } }, "看门狗周期、并发上限等定时器参数建议重启插件后完全生效；并发上限固定 1–5（默认 5），输入大于 5 自动强制修正为 5。当前通道：" + (mode === "scope" ? "平台设置服务" : "远程命令（/team config）")),
      React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", marginBottom: 12 } },
        React.createElement("button", { onClick: () => { const all = {}; GROUPS.forEach((g) => { all[g.title] = true; }); setOpen(all); }, style: { padding: "5px 12px", cursor: "pointer", borderRadius: 6, border: "1px solid rgba(127,127,127,.5)", background: "transparent", color: "inherit", fontSize: 12 } }, "全部展开"),
        React.createElement("button", { onClick: () => setOpen({}), style: { padding: "5px 12px", cursor: "pointer", borderRadius: 6, border: "1px solid rgba(127,127,127,.5)", background: "transparent", color: "inherit", fontSize: 12 } }, "全部折叠")),
      GROUPS.map((g) => {
        const isOpen = !!open[g.title];
        return React.createElement("div", { key: g.title, style: { marginBottom: 10, border: "1px solid rgba(127,127,127,.22)", borderRadius: 8, overflow: "hidden" } },
          React.createElement("div", { onClick: () => setOpen((o) => Object.assign({}, o, { [g.title]: !o[g.title] })), style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", cursor: "pointer", background: "rgba(127,127,127,.08)", fontWeight: 600, fontSize: 13 } },
            React.createElement("span", null, g.title),
            React.createElement("span", { style: { fontSize: 12, opacity: 0.7 } }, isOpen ? "▾ 收起" : "▸ 展开")),
          isOpen ? React.createElement("div", { style: { padding: "12px 12px 6px" } }, g.fields.map((f) => React.createElement("div", { key: f.key, style: { marginBottom: 9 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
              React.createElement("span", { style: { fontSize: 13, width: 230, flex: "0 0 230px" } }, f.label),
              renderControl(f)),
            f.hint ? React.createElement("div", { style: { marginTop: 2, fontSize: 11, opacity: 0.6 } }, f.hint) : null))) : null);
      }),
      React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "center", marginTop: 6 } },
        React.createElement("button", { onClick: save, style: { padding: "7px 20px", cursor: "pointer", borderRadius: 6, border: "1px solid rgba(127,127,127,.5)", background: "transparent", color: "inherit" } }, "保存配置"),
        msg ? React.createElement("span", { style: { opacity: 0.8, fontSize: 12 } }, msg) : null));
  }

  // =====================================================================
  //  2. EXPERT FLOW CHART — pipeline progress (N0~N41 + watchdog W，方案 5.4)
  // =====================================================================
  // Node state vocabulary: done / current / waiting / pending / error / blocked.
  const STATE_COLOR = {
    done:     { bg: "#1a7f37", fg: "#ffffff" },
    current:  { bg: "#1f6feb", fg: "#ffffff" },
    waiting:  { bg: "#6e7681", fg: "#ffffff" },
    pending:  { bg: "#3a3f47", fg: "#9aa0a8" },
    error:    { bg: "#d1242f", fg: "#ffffff" },
    blocked:  { bg: "#8957e5", fg: "#ffffff" },
    idle:     { bg: "#444b54", fg: "#b8bec6" },
    running:  { bg: "#1f6feb", fg: "#ffffff" },
  };
  const STATE_LABEL = { done: "已完成", current: "进行中", waiting: "等待中", pending: "待处理", error: "异常", blocked: "阻塞", idle: "待机", running: "监控中" };
  const STATE_ICON = { done: "✓", current: "▶", waiting: "⏳", pending: "○", error: "⚠", blocked: "⛔", idle: "○", running: "▶" };

  // Static pipeline topology (N0~N41 + W 看门狗旁路)，与服务端 flowScene 同步（V9.3）。
  const FLOW_TOPOLOGY = [
    { id: "N0",  name: "用户触发",        desc: "/team 或 /dsh-leng-team，可附项目目标" },
    { id: "N1",  name: "总指挥初始化",    desc: "原始需求快照、项目会话、源/目标路径解析、任务类型识别" },
    { id: "N2",  name: "产品经理：轻量目标理解", desc: "初步目标假设、待调查清单、初步风险、条件启用意见（两阶段第一阶段）" },
    { id: "N3",  name: "任务类型识别",    desc: "greenfield/replicate/migrate/refactor/enhancement/research/generic" },
    { id: "N4",  name: "调查触发评估",    desc: "force/auto/skip 评分卡（目标/需求/技术/数据/风险/合规/规模/资料/时间）" },
    { id: "N5",  name: "调查员（触发/跳过）", desc: "事实收集/现状盘点/复刻强制盘点；跳过需记录原因", back: [{ to: "N5", label: "不充分 → 重调查（≤2 轮）" }] },
    { id: "N6",  name: "调查充分性门禁",  desc: "目标可验证/证据可追溯/假设显式标注/复刻源覆盖完整（P1/P2/P3 分级）", back: [{ to: "N5", label: "不充分 → 重调查" }] },
    { id: "N7",  name: "条件启用三方会签", desc: "总指挥+调查员+产品经理会签，条件角色启用判定（缺一不可）" },
    { id: "N8",  name: "产品经理：调查后正式定义", desc: "目标/范围/优先级/验收标准/风险接受/任务候选池（两阶段第二阶段）", back: [{ to: "N8", label: "范围冲突 → 回退产品定义" }] },
    { id: "N9",  name: "需求分析师",      desc: "需求规格/用例/验收标准细化、多方案对比" },
    { id: "N10", name: "架构师",          desc: "系统架构/技术选型/分层/拓扑" },
    { id: "N11", name: "技术负责人/详细设计（条件 designDetail）", desc: "模块划分、接口细化、编码规范、契约落地" },
    { id: "N12", name: "数据/数据库工程师（条件 hasData）", desc: "数据模型、表结构、迁移、数据字典、脱敏" },
    { id: "N13", name: "安全工程师（架构门禁）", desc: "安全审计、门禁、不通过回退架构整改", back: [{ to: "N10", label: "安全不通过 → 架构整改" }] },
    { id: "N14", name: "UX 交互设计",     desc: "交互流程、用户路径、状态机" },
    { id: "N15", name: "UI 视觉设计",     desc: "视觉规范、布局、组件、设计 token" },
    { id: "N16", name: "设计交叉评审",    desc: "UX/UI 一致性、架构支持、契约/状态机完整、可实现可测", back: [{ to: "N15", label: "不通过 → 设计整改" }] },
    { id: "N17", name: "设计安全复审",    desc: "安全设计被 UX/UI 遵守、无必须修复项", back: [{ to: "N15", label: "不通过 → UI 整改" }] },
    { id: "N18", name: "设计评审门禁",    desc: "设计完整性/一致性/可实现/可测试/可访问/安全/版本", back: [{ to: "N16", label: "不通过 → 重评审整改" }] },
    { id: "N19", name: "契约冻结 + Mock", desc: "交互契约/组件契约/设计 token/状态机冻结，Mock 就绪" },
    { id: "N20", name: "总指挥拆分",      desc: "按页面/接口/功能拆分模块任务（总指挥唯一派发）" },
    { id: "N21", name: "全局任务队列",    desc: "fifo/priority 排队，排队超时告警" },
    { id: "N22", name: "5 并发席位池",    desc: "全局并发上限（1-5），P0/P1 预留席位，429 自动降级" },
    { id: "N23", name: "前端模块子会话",  desc: "一页面/一功能一子会话，独立开发" },
    { id: "N24", name: "后端模块子会话",  desc: "一接口一子会话，独立开发" },
    { id: "N25", name: "数据模块子会话（条件 hasData）", desc: "数据模型/迁移子会话" },
    { id: "N26", name: "父会话汇总整合",  desc: "合并代码、修复冲突、统一目录（只机械合并不改业务逻辑）" },
    { id: "N27", name: "代码评审（含代码安全审查）", desc: "静态审查/规范/逻辑/安全/性能；缺陷退回对应模块", back: [{ to: "N23", label: "缺陷 → 对应模块返工" }] },
    { id: "N28", name: "专职测试（含设计还原度/交互/可访问性/i18n）", desc: "功能/场景/边界/回归；缺陷退回对应模块", back: [{ to: "N23", label: "缺陷 → 对应模块返工" }] },
    { id: "N29", name: "性能/可靠性测试（条件 prodScale）", desc: "性能/负载/压力/长稳/容量/故障注入", back: [{ to: "N23", label: "不通过 → 对应模块整改" }] },
    { id: "N30", name: "安全测试（条件 authOrPrivacy）", desc: "渗透/漏洞扫描/依赖扫描/越权/注入", back: [{ to: "N23", label: "不通过 → 对应模块整改" }] },
    { id: "N31", name: "运维",            desc: "环境搭建、部署流程、配置、上线规范" },
    { id: "N32", name: "DevOps / CI-CD（条件 teamOrCICD）", desc: "构建、制品、CI/CD、自动化" },
    { id: "N33", name: "发布经理（条件 prodRelease）", desc: "发布计划、灰度、回滚、发布说明、checklist" },
    { id: "N34", name: "部署安全审查",    desc: "审查部署/上线方案安全，不通过回退运维", back: [{ to: "N31", label: "不通过 → 运维整改" }] },
    { id: "N35", name: "部署验证/冒烟测试", desc: "部署后冒烟验证，失败回退运维整改", back: [{ to: "N31", label: "失败 → 运维整改" }] },
    { id: "N36", name: "监控/SRE 配置（条件 prodSystem）", desc: "监控/告警/日志/链路/SLO/故障响应" },
    { id: "N37", name: "文档工程师",      desc: "全流程产物汇总、标准化交付文档" },
    { id: "N38", name: "上线前安全复查",  desc: "最终交付物上线前安全复查" },
    { id: "N39", name: "最终全功能回归测试", desc: "全部功能+设计+性能+安全+无障碍+i18n；未通过不得最终审核", back: [{ to: "N23", label: "未通过 → 回退开发后重新回归" }] },
    { id: "N40", name: "最终审核（含独立复验）", desc: "三态结论/盲审/反方质询/问题池检查/独立复验", back: [{ to: "对应问题节点", label: "不通过 → 精准回退整改" }] },
    { id: "N41", name: "流水线完成",      desc: "回退预算/会签/复验/可量化验收指标留痕" },
  ];

  function FlowChartView(props) {
    const React = react;
    const [flow, setFlow] = React.useState(null);
    const [err, setErr] = React.useState("");
    const [tick, setTick] = React.useState(0);

    React.useEffect(() => {
      let alive = true;
      let timer = null;
      const fetchFlow = async () => {
        try {
          const fn = props.fetchFlow || props.remoteFlow;
          if (typeof fn !== "function") { setErr("流程图数据通道不可用（会话刷新后重试）"); return; }
          const data = await fn();
          if (alive) { setFlow(data); setErr(""); }
        } catch (e) { if (alive) setErr(String(e && e.message ? e.message : e)); }
      };
      fetchFlow();
      timer = setInterval(fetchFlow, 30000);
      return () => { alive = false; if (timer) clearInterval(timer); };
    }, [tick]);

    const nodes = flow && Array.isArray(flow.nodes) ? flow.nodes : null;
    const watchdog = flow && flow.watchdog ? flow.watchdog : null;
    const goal = flow ? (flow.goal || "") : "";
    const stage = flow ? (flow.stage || "") : "";

    return React.createElement("div", { style: { padding: "12px 16px 20px", fontFamily: "system-ui, sans-serif", fontSize: 13 } },
      React.createElement("h3", { style: { margin: "0 0 8px", fontSize: 15 } }, "专家流程图 · dsh-leng-team"),
      goal ? React.createElement("div", { style: { marginBottom: 8, padding: "8px 12px", borderRadius: 8, background: "rgba(127,127,127,.12)", fontSize: 13 } },
        React.createElement("span", { style: { opacity: 0.7 } }, "当前项目："), React.createElement("b", null, goal),
        React.createElement("span", { style: { marginLeft: 10, opacity: 0.7 } }, "· 阶段："), React.createElement("b", null, stage)) : null,
      err ? React.createElement("div", { style: { marginBottom: 8, padding: "6px 10px", borderRadius: 6, background: "rgba(209,36,47,.15)", color: "#d1242f", fontSize: 12 } }, "状态同步：" + err) : null,
      !nodes || nodes.length === 0 ? React.createElement("div", { style: { opacity: 0.7, padding: "20px 0", textAlign: "center" } }, "等待流水线状态…（5 秒自动刷新）") :
        React.createElement("div", null,
          // Legend
          React.createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, fontSize: 11, opacity: 0.85 } },
            Object.keys(STATE_LABEL).filter((k) => ["done", "current", "waiting", "pending", "error"].includes(k)).map((k) =>
              React.createElement("span", { key: k, style: { display: "inline-flex", alignItems: "center", gap: 5 } },
                React.createElement("span", { style: { width: 12, height: 12, borderRadius: 3, display: "inline-block", background: STATE_COLOR[k].bg } }),
                STATE_LABEL[k]))),
          // Chain
          nodes.map((n, idx) => {
            const c = STATE_COLOR[n.state] || STATE_COLOR.pending;
            const isDone = n.state === "done";
            const isCurrent = n.state === "current";
            const isErr = n.state === "error" || n.state === "blocked";
            const topo = FLOW_TOPOLOGY.find((t) => t.id === n.id) || { name: n.id, desc: "" };
            const back = topo.back;
            return React.createElement("div", { key: n.id, style: { marginBottom: 6 } },
              React.createElement("div", { style: { display: "flex", alignItems: "stretch", gap: 8 } },
                React.createElement("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", width: 40, flex: "0 0 40px" } },
                  React.createElement("div", { style: { width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: c.bg, color: c.fg, fontWeight: 700, fontSize: 10, boxShadow: isCurrent ? "0 0 0 3px rgba(31,111,235,.35)" : "none" } }, n.id),
                  idx < nodes.length - 1 ? React.createElement("div", { style: { width: 2, flex: 1, background: "rgba(127,127,127,.4)" } }) : null),
                React.createElement("div", { style: { flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid " + (isErr ? "rgba(209,36,47,.6)" : "rgba(127,127,127,.28)"), background: isCurrent ? "rgba(31,111,235,.08)" : "rgba(127,127,127,.05)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
                  React.createElement("div", null,
                    React.createElement("div", { style: { fontWeight: 600, fontSize: 13 } },
                      n.name || topo.name,
                      n.note ? React.createElement("span", { style: { marginLeft: 8, fontSize: 11, fontWeight: 400, opacity: 0.8 } }, "（" + n.note + "）") : null),
                    React.createElement("div", { style: { opacity: 0.72, fontSize: 11, marginTop: 2 } }, n.desc || topo.desc)),
                  React.createElement("span", { style: { flex: "0 0 auto", padding: "2px 10px", borderRadius: 10, background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" } }, STATE_ICON[n.state] + " " + (STATE_LABEL[n.state] || n.state))),
              back && back.length ? React.createElement("div", { style: { display: "flex", gap: 8, marginLeft: 40, marginTop: 4, flexWrap: "wrap" } },
                back.map((b, bi) => React.createElement("span", { key: bi, style: { fontSize: 11, color: "#d1242f", padding: "2px 8px", borderRadius: 6, background: "rgba(209,36,47,.1)" } }, "↺ " + b.label))) : null));
          }),
          // Watchdog (parallel lane)
          watchdog ? React.createElement("div", { style: { marginTop: 14, padding: "8px 12px", borderRadius: 8, border: "1px dashed rgba(31,111,235,.5)", background: "rgba(31,111,235,.06)", display: "flex", alignItems: "center", gap: 10 } },
            React.createElement("span", { style: { width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: STATE_COLOR[watchdog.state] ? STATE_COLOR[watchdog.state].bg : "#1f6feb", color: "#fff", fontWeight: 700, fontSize: 10 } }, watchdog.id || "W"),
            React.createElement("div", null,
              React.createElement("div", { style: { fontWeight: 600, fontSize: 13 } }, watchdog.name || "看门狗旁路", watchdog.note ? React.createElement("span", { style: { marginLeft: 8, fontSize: 11, fontWeight: 400, opacity: 0.8 } }, "（" + watchdog.note + "）") : null),
              React.createElement("div", { style: { opacity: 0.72, fontSize: 11, marginTop: 2 } }, watchdog.desc || "每 4 分钟全局轮询：死循环 / 429 / 僵尸会话 / 席位回收 / 异常告警"))) : null,
          React.createElement("div", { style: { marginTop: 10, fontSize: 11, opacity: 0.55 } }, "状态每 5 秒自动刷新 · 人工确认节点默认测试通过（可在专家页面关闭测试模式改为人工确认）"))); 
  }

  // Minimal schemastery-ish schema: a callable that returns the raw value, plus
  // ~standard validation. Good enough for SettingsForms to render the form.
  function buildSchemasterySchema() {
    const fn = (v) => v ?? {};
    fn["~standard"] = {
      validate: (v) => ({ issues: [] }),
      toJSON: () => ({}),
    };
    fn.toJSON = () => ({});
    return fn;
  }
  function validateSection(section) {
    const s = section ?? {};
    if (s.concurrency && Number(s.concurrency.maxConcurrent) > 5) s.concurrency.maxConcurrent = 5;
    if (s.watchdog && Number(s.watchdog.intervalMs) < 60000) s.watchdog.intervalMs = 60000;
    return undefined;
  }

  // =====================================================================
  //  apply
  // =====================================================================
  function apply(ctx) {
    try {
      dbg("[dsh-leng-team] apply called");

      let currentScope = null;
      let scopeWaiters = [];
      const onScopeReady = (cb) => {
        if (currentScope) { queueMicrotask(() => { try { cb(currentScope); } catch (e) { console.error("[dsh-leng-team] scope cb", e); } }); return () => {}; }
        scopeWaiters.push(cb); return () => { scopeWaiters = scopeWaiters.filter((f) => f !== cb); };
      };
      const gotScope = (s) => { currentScope = s; const ws = scopeWaiters; scopeWaiters = []; ws.forEach((cb) => { try { cb(s); } catch (e) { console.error("[dsh-leng-team] scope waiter", e); } }); };

      let svc = null;
      try { if (typeof ctx.get === "function") { svc = ctx.get("settingsScope"); } } catch (e) { dbg("[dsh-leng-team] ctx.get err", e); }
      if (!svc) { try { if (ctx.settingsScope !== void 0) { svc = ctx.settingsScope; } } catch (e) { /* property access throws without inject on 0.1.7 */ } }
      if (svc) { try { gotScope(svc.bind({ namespace: NS })); dbg("[dsh-leng-team] scope bound (sync)"); } catch (e) { dbg("[dsh-leng-team] sync bind err", e); } }

      // Build the remote command channel used by both the settings panel (when the
      // platform settings namespace is unavailable) and the flow chart polling.
      // remote.commands.execute requires a real sessionId, so cache the most
      // recent one observed via conversation-view injection or command events.
      let __lastSession = null;
      let remoteChannel = null;
      try {
        const remote = (typeof ctx.get === "function") ? ctx.get("remote") : null;
        if (remote && typeof remote.commands?.execute === "function") {
          const pickSession = () => __lastSession || __ownerSession || null;
          remoteChannel = async (line) => {
            const sid = pickSession();
            if (!sid) { const e = new Error("无可用的会话 ID：请先打开任意会话后再使用专家设置"); e.__noSession = true; throw e; }
            const res = await remote.commands.execute(sid, line, []);
            const r = res && res.value !== undefined ? res.value : res;
            return r && r.result !== undefined ? r.result : r;
          };
          dbg("[dsh-leng-team] remote channel ready");
        }
      } catch (e) { dbg("[dsh-leng-team] remote channel err", e); }
      const remoteRun = remoteChannel || null;
      // Toast polling: command results reach the session event log (command/done)
      // which has no client event on 0.1.7, so poll the host for the latest
      // recorded command result and show a transient toast (3s) when it changes.
      let __pollSeen = 0;
      // Rename the current session to the launched project name through the
      // official client sessions binding. binding.rename calls the host remote
      // (idempotent, same title) AND applies the title projection locally, so
      // the sidebar/workspace list shows the project name immediately.
      const syncSessionTitle = (text) => {
        try {
          const m = /(?:项目会话已建立|项目已启动)[:：]\s*([^（(]+)/.exec(text || "");
          if (!m || !m[1]) return;
          const title = m[1].trim();
          if (!title) return;
          const sessionsSvc = (typeof ctx.get === "function") ? ctx.get("sessions") : null;
          if (!sessionsSvc || typeof sessionsSvc.binding !== "function") return;
          const sid = __lastSession || __ownerSession || null;
          if (!sid) return;
          const b = sessionsSvc.binding(sid);
          const sess = b && b.session;
          if (!sess || typeof sess.rename !== "function") return;
          sess.rename(title).then((r) => {
            dbg("[dsh-leng-team] client rename:", r && r.ok ? "ok -> " + (r.value && r.value.title ? r.value.title : title) : JSON.stringify(r));
            try {
              const mgr = sessionsSvc && sessionsSvc.manager;
              if (mgr && typeof mgr.refreshList === "function") {
                mgr.refreshList();
                dbg("[dsh-leng-team] client list refresh fired");
              }
            } catch (e) { dbg("[dsh-leng-team] list refresh err", String(e && e.message ? e.message : e)); }
          }).catch((e) => dbg("[dsh-leng-team] client rename err", String(e && e.message ? e.message : e)));
        } catch (e) { /* optional */ }
      };
      // NOTE: the previous 1.5s "team poll" loop was removed — every remote.commands.execute
      // call records a "team·已完成" entry in the conversation stream (0.1.7 renders command
      // executions as collapsed items), which spammed the project session. Toast + sidebar
      // activity are now covered by the command/executed listener and the host followup inject.
      // Remember the latest session id seen in command events so the global
      // settings panel can run /team config get|set through it.
      try {
        if (typeof ctx.events?.on === "function") {
          ctx.events.on("command/executed", (sessionId) => { if (sessionId) { __lastSession = sessionId; dbg("[dsh-leng-team] command/executed sid:", sessionId); } });
        }
      } catch (e) { /* optional */ }

      // 1) Expert settings side-nav section (GLOBAL slots = nav projection).
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: SECTION_ID, order: SECTION_ORDER, label: () => "专家设置", locale: NS },
        (ownerProps = {}) => react.createElement(ExpertPanel, Object.assign({}, ownerProps, { scope: currentScope, onScopeReady, remoteRun }))));

      // 2) Expert flow chart conversation-view tab.
      if (typeof __ownerSession === "undefined") var __ownerSession = null;
      const flowFetch = async () => {
        try {
          let remote = null;
          try { if (typeof ctx.get === "function") remote = ctx.get("remote"); } catch (e) { /* optional */ }
          if (!remote || typeof remote.commands?.execute !== "function") throw new Error("remote 服务不可用");
          const res = await remote.commands.execute(__ownerSession, "/team flow", []);
          const r = res && res.value ? res.value : res;
          const result = r && r.result ? r.result : r;
          const text = result && typeof result.text === "string" ? result.text : null;
          if (text) {
            try {
              const parsed = JSON.parse(text);
              if (parsed && parsed.nodes) return parsed;
            } catch (e) { /* text 不是 JSON（如错误信息） */ }
            if (/dsh-leng-team 已就绪/.test(text)) return { nodes: [], goal: "", stage: "idle", running: false };
          }
          throw new Error("flow 数据为空");
        } catch (e) {
          dbg("[dsh-leng-team] flow fetch err", String(e && e.message ? e.message : e));
          // degrade: return the full pipeline topology with pending states so the
          // user always sees the whole N0-N41 flow (and watchdog lane).
          return {
            goal: "", stage: "idle", running: false, at: Date.now(),
            nodes: FLOW_TOPOLOGY.map((t) => ({ id: t.id, name: t.name, desc: t.desc, state: "pending", note: "" })),
            watchdog: { id: "W", name: "看门狗旁路", desc: "每 4 分钟全局轮询：死循环 / 429 / 僵尸会话 / 席位回收 / 异常告警", state: "idle", note: "" },
          };
        }
      };
      ctx.slots.inject("conversation.view", () => ctx.slots.register(
        { name: "conversation.view", id: "leng-flow", order: 60, label: () => "专家流程图", locale: NS, inject: (sessionId) => { __ownerSession = sessionId; dbg("[dsh-leng-team] owner session set:", sessionId); return { fetchFlow: flowFetch }; } },
        (ownerProps = {}) => {
          const sid = ownerProps.sessionId || null;
          if (sid && sid !== __ownerSession) { __ownerSession = sid; dbg("[dsh-leng-team] owner session via props:", sid); }
          return react.createElement(FlowChartView, Object.assign({}, ownerProps, { fetchFlow: flowFetch, remoteFlow: flowFetch }));
        }));

      // 3) Ensure the settings namespace is registered so the expert page can render.
      // On web the plugin half may be a client bundle where ctx.settings is the client
      // SettingsForms service (register renders the section itself). If the host mirror
      // lacks the namespace, bind() above stays "unavailable" — try registering here.
      try {
        if (typeof ctx.settings?.register === "function") {
          const schemaFn = buildSchemasterySchema();
          ctx.settings.register(NS, schemaFn, {
            base: undefined,
            validate: (section) => {
              try { return validateSection(section); } catch (e) { return String(e && e.message ? e.message : e); }
            },
          });
          dbg("[dsh-leng-team] settings namespace registered via client SettingsForms");
        } else {
          dbg("[dsh-leng-team] ctx.settings.register unavailable:", typeof ctx.settings?.register);
        }
      } catch (e) { dbg("[dsh-leng-team] 专家设置页降级：平台未提供 settings 服务（0.1.7 限制），参数使用默认值，主功能不受影响。"); }

      // 4) Async fallback for scope — removed: sync ctx.get("settingsScope") already bound it above.
      // (ctx.inject(["settingsScope"]) throws on some clients: Cannot read properties of undefined (reading 'name'))

      // 4) Surface team command results that the host does not render into the chat flow.
      try {
        if (typeof ctx.events?.on === "function") {
          ctx.events.on("command/executed", (sessionId, name, result) => {
            if ((name === "team" || name === "dsh-leng-team") && result) {
              const txt = (result.text !== undefined && result.text !== null && String(result.text) !== "null")
                ? String(result.text)
                : (result.message || result.output || result.body || "");
              const trimmed = String(txt || "").trim();
              // 只 toast 人工可读的通知（项目建立/重置/就绪等）；轮询/流程图返回的 JSON 数据不弹
              const isData = /^[\[\{]/.test(trimmed) && !/项目会话已建立|已全局重置|已就绪|流水线完成|自检结果/.test(trimmed);
              if (trimmed && !isData) { dbg("[dsh-leng-team] cmd-result:", name, trimmed.slice(0, 120)); showResultToast(trimmed); }
            }
          });
        }
      } catch (e) { dbg("[dsh-leng-team] cmd-result listener err", e); }
    } catch (e) { console.error("[dsh-leng-team] apply error", e); }
  }

  function showResultToast(text) {
    try {
      let el = document.getElementById("leng-team-result-toast");
      if (!el || !document.body.contains(el)) {
        el = document.createElement("div");
        el.id = "leng-team-result-toast";
        el.style.cssText = "position:fixed;top:16px;right:16px;z-index:99999;max-width:520px;max-height:72vh;overflow:auto;background:rgba(22,24,28,.95);color:#e8e8e8;padding:12px 16px;border-radius:10px;font:12px/1.7 system-ui,sans-serif;white-space:pre-wrap;box-shadow:0 6px 28px rgba(0,0,0,.45);border:1px solid rgba(127,127,127,.35)";
        const close = document.createElement("button");
        close.textContent = "✕";
        close.style.cssText = "position:absolute;top:8px;right:10px;background:none;border:none;color:#999;font-size:13px;cursor:pointer;z-index:2";
        close.onclick = () => { el.remove(); };
        el.appendChild(close);
        document.body.appendChild(el);
      }
      // 清空旧内容（仅保留关闭按钮），避免累积刷屏
      while (el.childNodes.length > 1) el.removeChild(el.lastChild);
      const b = document.createElement("div");
      b.style.cssText = "margin-top:16px";
      b.textContent = text;
      el.appendChild(b);
      // 3 秒后自动消失（项目建立等通知不常驻）
      if (el._hideTimer) clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => { try { el.remove(); } catch (e) { /* already gone */ } }, 3000);
    } catch (e) { dbg("[dsh-leng-team] toast err", e); }
  }

  exports.name = NS;
  // settingsScope is a host-scope service that is not always present on 0.1.7;
  // require it as optional via ctx.get() in apply, never as a hard inject.
  // remote needed for /team flow polling; keep optional via ctx.get, but inject
  // it so ctx.get("remote") resolves (dsh-client-ui-commands does the same).
  exports.inject = ["slots", "remote", "remote.commands", "sessions"];
  exports.apply = apply;
  return module.exports;
}});
