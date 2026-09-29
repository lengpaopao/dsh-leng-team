/**
 * Domain DAG templates + task-type identification + investigation trigger.
 *
 * V9.3: 主 DAG 无环 + 有界质量回环子图。每个领域提供 DagTemplate：
 *  nodes / edges / parallelGroups / rollbackEdges / entry / exit。
 * 任务类型识别（领域七类）+ 任务性质识别（greenfield/replicate/migrate/refactor/
 * enhancement/research/generic）+ 调查触发评估（force/auto/skip + 9 维评分卡）。
 * 新增领域只需补充一个 DagTemplate + 领域角色包，无需改编排器。
 */

// ---- 领域类型识别（模板选择用） ----
export const TASK_TYPES = [
  { key: "software", label: "软件开发", detect: (goal) => /(开发|软件|前端|后端|网站|web|app|系统|工具|页面|小程序|平台|接口|全栈|spring|vue|react|小程序)/i.test(String(goal ?? "")) },
  { key: "data_analysis", label: "数据分析", detect: (goal) => /(数据分析|数据清洗|指标|报表|dashboard|统计|可视化|探索性|建模|预测|回归分析)/i.test(String(goal ?? "")) },
  { key: "research", label: "研究调研", detect: (goal) => /(研究|调研|综述|报告|文献|论文|资料|梳理|分析报告|调研报告|学术|趋势研究)/i.test(String(goal ?? "")) },
  { key: "content", label: "内容创作（非小说）", detect: (goal) => /(文案|文章|公众号|笔记|内容|推广|营销|脚本|宣传|运营|SEO|seo)/i.test(String(goal ?? "")) },
  { key: "fiction", label: "强叙事创作（小说/剧本）", detect: (goal) => /(小说|剧本|故事|短剧|叙事|动漫|漫画|影视)/i.test(String(goal ?? "")) },
  { key: "document", label: "文档撰写", detect: (goal) => /(文档|手册|白皮书|方案|规范|章程|制度|指南|说明)/i.test(String(goal ?? "")) },
  { key: "generic", label: "通用", detect: () => true },
];

export function detectTaskType(goal) {
  const hit = TASK_TYPES.find((t) => t.key !== "generic" && t.detect(goal));
  return hit ? hit.key : "generic";
}

// ---- 任务性质识别（七类：greenfield/replicate/migrate/refactor/enhancement/research/generic） ----
export const TASK_MODES = [
  { key: "replicate", label: "复刻/重建", detect: (goal) => /(复刻|克隆|仿照|参照|重写|二开|还原|重建|照搬|复现.*项目|对齐.*项目|做成.*一样)/i.test(String(goal ?? "")) },
  { key: "migrate", label: "迁移", detect: (goal) => /(迁移|搬迁|移植|从.*搬到|换平台|迁到|搬过来)/i.test(String(goal ?? "")) },
  { key: "refactor", label: "重构", detect: (goal) => /(重构|改造现有|优化现有|清理代码|代码重构|整改现有)/i.test(String(goal ?? "")) },
  { key: "enhancement", label: "增强/迭代", detect: (goal) => /(增强|扩展|新增功能|迭代|升级|加个|补个|完善|优化.*功能|添加)/i.test(String(goal ?? "")) },
  { key: "research", label: "研究", detect: (goal) => /(研究|调研|综述|文献|论文|资料梳理|趋势研究|调研报告)/i.test(String(goal ?? "")) },
  { key: "greenfield", label: "全新", detect: () => true },
];
// generic 保留为显式兜底（enhancement 与 research 之外均可归 greenfield；此处仅作类型说明）
export const TASK_MODES_FULL = [...TASK_MODES, { key: "generic", label: "通用", detect: () => true }];

export function detectTaskMode(goal) {
  const hit = TASK_MODES.find((t) => t.key !== "greenfield" && t.detect(goal));
  return hit ? hit.key : "greenfield";
}

// ---- 调查触发评估（force / auto / skip + 评分卡） ----
const REPLICA_RE = /(复刻|克隆|仿照|参照|重写|迁移|二开|还原|重建|照搬|复现.*项目|对齐.*项目|做成.*一样|重构|改造|从零复现)/i;

/** 9 维评分卡：目标模糊度/需求不确定/技术不确定/数据不确定/风险/合规/规模/已有资料/时间。
 *  权重默认 3/3/3/3/3/3/2/-2/-1（可由专家设置 discoveryWeights 覆盖）；
 *  总分 ≥10 deep、6–9 standard、3–5 light、<3 skip。 */
export function scoreInvestigation(goal, weights = {}) {
  const g = String(goal ?? "");
  const w = Object.assign({ goal: 3, requirement: 3, tech: 3, data: 3, risk: 3, compliance: 3, scale: 2, existing: -2, time: -1 }, weights || {});
  const has = (re) => re.test(g);
  let s = 0;
  if (has(/(大概|随便|简单|不清楚|模糊|不确定|想做一个|类似.*那种)/i)) s += Number(w.goal) || 0;
  if (has(/(需求未定|待定|商量|可能.*需求|边界不清)/i)) s += Number(w.requirement) || 0;
  if (has(/(新技术|怎么实现|技术选型|框架选择|性能要求|并发|高可用)/i)) s += Number(w.tech) || 0;
  if (has(/(数据源|数据在哪|数据结构|没有数据|数据库不清楚|样本数据)/i)) s += Number(w.data) || 0;
  if (has(/(生产|线上|支付|交易|金融|医疗|政府|公开服务|对外)/i)) s += Number(w.risk) || 0;
  if (has(/(合规|隐私|法规|许可证|数据安全|GDPR|等保|资质)/i)) s += Number(w.compliance) || 0;
  if (has(/(企业级|多模块|大型|整个系统|多端|多平台|微服务|集群)/i)) s += Number(w.scale) || 0;
  if (has(/(有文档|有需求文档|有设计稿|有原型|有接口文档|资料齐全)/i)) s += Number(w.existing) || 0;
  if (has(/(加急|尽快|今天|马上|快速)/i)) s += Number(w.time) || 0;
  return s;
}

/**
 * 路径信号解析（方案 3.1：soft→softnew、source→target、旧目录→新目录；
 * 及「源目录/目标目录」「从…到…」等自然语言表述）。解析失败返回 null。
 */
function extractPaths(g) {
  let sourcePath = null, targetPath = null;
  const arrow = g.match(/([\w\-./\\~]+)\s*(?:[→>\-])\s*([\w\-./\\~]+)/);
  if (arrow) { sourcePath = arrow[1]; targetPath = arrow[2]; }
  const src = g.match(/(?:源目录|源项目|原项目|旧目录|现有项目|参照项目|源路径)[：:\s]*([\w\-./\\~]+)/i);
  if (src && !sourcePath) sourcePath = src[1];
  const tgt = g.match(/(?:目标目录|新目录|目标路径|放到|复制到|建到|迁移到|搬到)[：:\s]*([\w\-./\\~]+)/i);
  if (tgt && !targetPath) targetPath = tgt[1];
  return { sourcePath, targetPath };
}

/**
 * 返回 DiscoveryTriggerDecision：
 * { decision, reason, confidence, depth, mode, scope, sourcePath, targetPath,
 *   priority, evidenceRequired, skipAllowed, replica, score }
 */
export function evaluateInvestigation(goal, taskType, weights) {
  const g = String(goal ?? "");
  const isReplica = REPLICA_RE.test(g);
  // 复刻/迁移/重构/二开类强制调查，禁止跳过（方案 3.1：命中后解析源/目标路径）
  if (isReplica) {
    const { sourcePath, targetPath } = extractPaths(g);
    return {
      decision: "force", reason: "复刻/迁移/重构/二开类必须调查：对照源项目基线，禁止跳过",
      confidence: 0.95, depth: "deep", mode: "current_state_asset",
      scope: ["源项目", "技术栈", "接口", "数据", "部署", "测试", "依赖"],
      sourcePath, targetPath, priority: "P1", evidenceRequired: true,
      skipAllowed: false, replica: true, score: 99,
    };
  }
  // 强叙事/纯文档：跳过调查（调查员不适配）
  if (taskType === "fiction") {
    return { decision: "skip", reason: "强叙事创作无现状/基线可调查", confidence: 0.9, depth: "light", mode: "goal", scope: [], sourcePath: null, targetPath: null, priority: "P3", evidenceRequired: false, skipAllowed: true, replica: false, score: 0 };
  }
  if (taskType === "document" && !/(现状|调研|基线|对标)/i.test(g)) {
    return { decision: "skip", reason: "纯文档撰写，无需现状调查", confidence: 0.85, depth: "light", mode: "goal", scope: [], sourcePath: null, targetPath: null, priority: "P3", evidenceRequired: false, skipAllowed: true, replica: false, score: 0 };
  }
  // 领域默认策略：research 默认 force（方案 3.4）
  if (taskType === "research") {
    return { decision: "force", reason: "研究类默认强制调查：先盘点主题现状、证据与资料源", confidence: 0.9, depth: "standard", mode: "feasibility", scope: ["主题现状", "证据", "资料源", "假设"], sourcePath: null, targetPath: null, priority: "P1", evidenceRequired: true, skipAllowed: false, replica: false, score: 12 };
  }
  // 领域默认策略（方案 3.4）：data_analysis 数据源未知时强制调查
  if (
    taskType === "data_analysis" &&
    /(分析|报表|统计|建模|可视化|指标|洞察|清洗|预测)/i.test(g) &&
    !/(数据源|数据集|数据在|csv|excel|xlsx|数据库|导入|上传|提供数据|附件|接口|api|爬取|已有数据|样本|表格|连接)/i.test(g)
  ) {
    return { decision: "force", reason: "数据分析任务但目标中未见数据来源：必须先调查数据现状与可用性", confidence: 0.8, depth: "standard", mode: "data", scope: ["数据源", "数据现状", "数据可用性", "数据口径"], sourcePath: null, targetPath: null, priority: "P1", evidenceRequired: true, skipAllowed: false, replica: false, score: 10 };
  }
  // 其他领域：auto + 评分卡
  const score = scoreInvestigation(g, weights);
  const needsLook = /(现状|基线|已有|迁移|对接|系统|数据|流程|合规|需求|用户|调研|评估|集成|第三方|API|api|数据库|平台|竞品|受众|渠道)/i.test(g);
  const domainAuto = taskType === "software" || taskType === "data_analysis" || taskType === "content" || taskType === "generic";
  if (needsLook || domainAuto) {
    if (score >= 10) return { decision: "auto", reason: `评分 ${score}（≥10）：任务复杂度/风险高，强制深度调查`, confidence: 0.85, depth: "deep", mode: taskType === "data_analysis" ? "data" : taskType === "content" ? "audience" : "goal", scope: ["需求", "现状", "约束"], sourcePath: null, targetPath: null, priority: "P1", evidenceRequired: true, skipAllowed: false, replica: false, score };
    if (score >= 6) return { decision: "auto", reason: `评分 ${score}（6–9）：标准调查`, confidence: 0.75, depth: "standard", mode: "goal", scope: ["需求", "现状"], sourcePath: null, targetPath: null, priority: "P2", evidenceRequired: true, skipAllowed: true, replica: false, score };
    if (score >= 3) return { decision: "auto", reason: `评分 ${score}（3–5）：轻量调查`, confidence: 0.65, depth: "light", mode: "goal", scope: ["需求"], sourcePath: null, targetPath: null, priority: "P2", evidenceRequired: false, skipAllowed: true, replica: false, score };
    return { decision: "skip", reason: `评分 ${score}（<3）：目标明确且低风险，跳过调查`, confidence: 0.6, depth: "light", mode: "goal", scope: [], sourcePath: null, targetPath: null, priority: "P3", evidenceRequired: false, skipAllowed: true, replica: false, score };
  }
  return { decision: "skip", reason: "任务目标明确且无现状依赖，跳过调查", confidence: 0.7, depth: "light", mode: "goal", scope: [], sourcePath: null, targetPath: null, priority: "P3", evidenceRequired: false, skipAllowed: true, replica: false, score: 0 };
}

// ---- DAG 节点 / 边 / 回退边 ----
export function dagNode({ id, nodeType = "role", slotId = null, roleName = null, phase = "design", splittable = false, splitDimension = null, activationCondition = null, signOffRequired = false }) {
  return { id, nodeType, slotId, roleName, phase, splittable, splitDimension, activationCondition, signOffRequired };
}
export function dagEdge(from, to, condition = "always") { return { from, to, condition }; }

/**
 * #20：nodeType 与 phase 合法组合定义（非法组合在模板加载/自检时拒绝）。
 *  role/system 覆盖全阶段；gate 只能配 gate；parallel 只能配 execute；
 *  queue 不能配 final（可配 execute/gate）；join 配 execute/gate。
 */
export const NODE_PHASE_RULES = {
  role: ["design", "execute", "gate", "verify", "deliver", "document", "final"],
  system: ["design", "execute", "gate", "verify", "deliver", "document", "final"],
  gate: ["gate"],
  parallel: ["execute"],
  queue: ["execute", "gate"],
  join: ["execute", "gate"],
};

export function validateNodePhase(node) {
  const allowed = NODE_PHASE_RULES[node?.nodeType];
  if (!allowed) return { ok: false, detail: "未知 nodeType: " + node?.nodeType };
  if (!allowed.includes(node?.phase)) {
    return { ok: false, detail: "node " + node?.id + " nodeType=" + node?.nodeType + " 不允许 phase=" + node?.phase + "（合法: " + allowed.join("/") + "）" };
  }
  return { ok: true };
}

/** 校验整个 DAG 模板的节点组合是否合法。 */
export function validateDagTemplate(template) {
  const bad = [];
  for (const n of template?.nodes ?? []) {
    const r = validateNodePhase(n);
    if (!r.ok) bad.push(r.detail);
  }
  return { ok: bad.length === 0, detail: bad.join("；") || "DAG 节点组合全部合法" };
}
export function rollbackEdge(from, to, trigger, maxLoops = 3) { return { from, to, trigger, maxLoops, budgetRef: "global" }; }

/** software 领域 DAG 模板（V9.3 N0–N41 主链 + 有界回退子图）。 */
export const SOFTWARE_DAG = {
  domain: "software",
  entry: "N0",
  exit: "N41",
  // 方案 5.1 DagTemplate.parallelGroups：N23/N24/N25 共享全局 5 并发席位池，各内部按模块维度并行
  parallelGroups: [
    { id: "PG1", nodes: ["N23", "N24", "N25"], seats: "global:5", dimension: "module" },
  ],
  nodes: [
    dagNode({ id: "N0",  nodeType: "system", roleName: "用户触发" }),    dagNode({ id: "N1",  nodeType: "system", roleName: "总指挥初始化 + 原始需求快照 + 源/目标路径解析" }),
    dagNode({ id: "N2",  nodeType: "system",  roleName: "任务类型识别" }),
    dagNode({ id: "N3",  nodeType: "system",  roleName: "调查触发评估（force/auto/skip）" }),
    dagNode({ id: "N4",  slotId: "goal",      roleName: "产品经理（轻量目标理解）", phase: "design" }),
    dagNode({ id: "N5",  slotId: "discovery", roleName: "调查员（触发/跳过，复刻强制）", phase: "design", activationCondition: "investigationTriggered" }),
    dagNode({ id: "N6",  nodeType: "gate",    roleName: "调查充分性门禁", phase: "gate", signOffRequired: true }),
    dagNode({ id: "N7",  nodeType: "gate",    roleName: "条件启用三方会签", phase: "gate", signOffRequired: true }),
    dagNode({ id: "N8",  slotId: "goal",      roleName: "产品经理（调查后正式定义）", phase: "design" }),
    dagNode({ id: "N9",  slotId: "goal",      roleName: "需求分析师（需求规格/用例/验收）", phase: "design" }),
    dagNode({ id: "N10", slotId: "design",    roleName: "架构师（架构/技术选型/分层/拓扑）", phase: "design" }),
    dagNode({ id: "N11", slotId: "tech_lead", roleName: "技术负责人/详细设计（模块划分/接口细化/契约）", phase: "design", activationCondition: "designDetail" }),
    dagNode({ id: "N12", slotId: "data",      roleName: "数据/数据库工程师", phase: "design", activationCondition: "hasData" }),
    dagNode({ id: "N13", slotId: "risk",      roleName: "安全工程师（安全审计/门禁）", phase: "design" }),
    dagNode({ id: "N14", slotId: "experience", roleName: "UX 交互设计师", phase: "design" }),
    dagNode({ id: "N15", slotId: "presentation", roleName: "UI 设计师", phase: "design" }),
    dagNode({ id: "N16", slotId: "review",    roleName: "设计交叉评审", phase: "gate" }),
    dagNode({ id: "N17", slotId: "risk",      roleName: "设计安全复审", phase: "gate" }),
    dagNode({ id: "N18", nodeType: "gate",    roleName: "设计评审门禁（含条件会签）", phase: "gate", signOffRequired: true }),
    dagNode({ id: "N19", nodeType: "system",  roleName: "契约冻结 + Mock", phase: "design" }),
    dagNode({ id: "N20", nodeType: "system",  roleName: "总指挥拆分（页面/接口/功能）", phase: "execute" }),
    dagNode({ id: "N21", nodeType: "queue",   roleName: "全局任务队列", phase: "execute" }),
    dagNode({ id: "N22", nodeType: "parallel", roleName: "5 并发席位池", phase: "execute" }),
    dagNode({ id: "N23", slotId: "execution", roleName: "前端模块子会话", phase: "execute", splittable: true, splitDimension: "page" }),
    dagNode({ id: "N24", slotId: "execution", roleName: "后端模块子会话", phase: "execute", splittable: true, splitDimension: "interface" }),
    dagNode({ id: "N25", slotId: "data",      roleName: "数据模块子会话", phase: "execute", splittable: true, splitDimension: "table", activationCondition: "hasData" }),
    dagNode({ id: "N26", nodeType: "join",    roleName: "父会话汇总整合", phase: "execute" }),
    dagNode({ id: "N27", slotId: "review",    roleName: "代码评审", phase: "gate" }),
    dagNode({ id: "N27b", slotId: "risk", roleName: "代码安全审查（安全工程师签字）", phase: "gate" }),
    dagNode({ id: "N28", slotId: "verify",    roleName: "专职测试（设计还原度/交互/可访问性/i18n）", phase: "verify" }),
    dagNode({ id: "N29", slotId: "performance", roleName: "性能/可靠性测试", phase: "verify", activationCondition: "prodScale" }),
    dagNode({ id: "N30", slotId: "security_test", roleName: "安全测试", phase: "verify", activationCondition: "authOrPrivacy" }),
    dagNode({ id: "N31", slotId: "deliver",   roleName: "运维（环境/部署/上线）", phase: "deliver" }),
    dagNode({ id: "N32", slotId: "devops",    roleName: "DevOps / CI-CD", phase: "deliver", activationCondition: "teamOrCICD" }),
    dagNode({ id: "N33", slotId: "release",   roleName: "发布经理", phase: "deliver", activationCondition: "prodRelease" }),
    dagNode({ id: "N34", slotId: "risk",      roleName: "部署安全审查", phase: "gate" }),
    dagNode({ id: "N35", slotId: "verify",    roleName: "部署验证/冒烟测试", phase: "verify" }),
    dagNode({ id: "N36", slotId: "sre",       roleName: "监控/SRE 配置", phase: "deliver", activationCondition: "prodSystem" }),
    dagNode({ id: "N37", slotId: "document",  roleName: "文档工程师", phase: "document" }),
    dagNode({ id: "N38", slotId: "risk",      roleName: "上线前安全复查", phase: "gate" }),
    dagNode({ id: "N39", slotId: "verify",    roleName: "最终全功能回归测试", phase: "verify" }),
    dagNode({ id: "N40", slotId: "final_review", roleName: "最终审核（含独立复验）", phase: "final", signOffRequired: true }),
    dagNode({ id: "N41", nodeType: "system",  roleName: "流水线完成" }),
  ],
  edges: [
    dagEdge("N0", "N1"), dagEdge("N1", "N2"), dagEdge("N2", "N3"), dagEdge("N3", "N4"),
    dagEdge("N3", "N5", "auto_or_force"), dagEdge("N5", "N6"), dagEdge("N6", "N7"),
    dagEdge("N3", "N7", "skip"), dagEdge("N7", "N8"), dagEdge("N8", "N9"), dagEdge("N9", "N10"),
    dagEdge("N10", "N11", "conditional_designDetail"), dagEdge("N11", "N12", "conditional_hasData"), dagEdge("N11", "N13"),
    dagEdge("N12", "N13"), dagEdge("N13", "N14"), dagEdge("N14", "N15"), dagEdge("N15", "N16"),
    dagEdge("N16", "N17"), dagEdge("N17", "N18"), dagEdge("N18", "N19"), dagEdge("N19", "N20"),
    dagEdge("N20", "N21"), dagEdge("N21", "N22"), dagEdge("N22", "N23"), dagEdge("N22", "N24"),
    dagEdge("N22", "N25", "conditional_hasData"), dagEdge("N23", "N26"), dagEdge("N24", "N26"), dagEdge("N25", "N26"),
    dagEdge("N26", "N27"), dagEdge("N27", "N27b"), dagEdge("N27b", "N28"), dagEdge("N28", "N29", "conditional_prodScale"),
    dagEdge("N28", "N30", "conditional_authOrPrivacy"), dagEdge("N29", "N31"), dagEdge("N30", "N31"),
    dagEdge("N31", "N32", "conditional_teamOrCICD"), dagEdge("N31", "N33", "conditional_prodRelease"),
    dagEdge("N32", "N34"), dagEdge("N33", "N34"), dagEdge("N31", "N34"), dagEdge("N34", "N35"),
    dagEdge("N35", "N36", "conditional_prodSystem"), dagEdge("N35", "N37"), dagEdge("N37", "N38"),
    dagEdge("N38", "N39"), dagEdge("N39", "N40"), dagEdge("N40", "N41"),
  ],
  rollbackEdges: [
    // 方案 5.4 回退边：调查不充分 → 回退调查员（maxLoops=5，用户修订：最大回环 3–8 默认 5）
    rollbackEdge("N6", "N5", "investigation_insufficient", 5),
    // 方案 5.4 回退边：产品经理范围冲突 → 回退轻量目标理解重新对齐（routeBack）
    rollbackEdge("N8", "N4", "product_scope_conflict", 3),
    rollbackEdge("N13", "N10", "security_blocking", 3),
    rollbackEdge("N17", "N15", "design_security_blocking", 3),
    rollbackEdge("N16", "N15", "design_review_blocking", 3),
    rollbackEdge("N18", "N15", "design_gate_blocking", 3),
    rollbackEdge("N27", "N23", "review_module_fail", 3),
    rollbackEdge("N27", "N24", "review_module_fail", 3),
    rollbackEdge("N27b", "N23", "security_review_fail", 3),
    rollbackEdge("N27b", "N24", "security_review_fail", 3),
    rollbackEdge("N28", "N23", "test_module_fail", 3),
    rollbackEdge("N28", "N24", "test_module_fail", 3),
    rollbackEdge("N29", "N23", "performance_fail", 3),
    rollbackEdge("N30", "N23", "security_test_fail", 3),
    rollbackEdge("N34", "N31", "deploy_security_blocking", 3),
    rollbackEdge("N35", "N31", "deploy_verify_fail", 3),
    rollbackEdge("N39", "N28", "final_regression_fail", 3),
    rollbackEdge("N40", "N8", "audit_requirement", 3),
    rollbackEdge("N40", "N10", "audit_architecture", 3),
    rollbackEdge("N40", "N15", "audit_design", 3),
  ],
};

/** 领域拆分维度与执行角色（方案 2.3–2.6）。 */
export const DOMAIN_EXEC = {
  data_analysis: { roleKey: "data_execution", splitDimension: "dataset", dimLabel: "数据集/指标/模型/图表", conditionals: [
    { slotId: "statistics", roleKey: "statistics", roleName: "统计学家/方法论专家", activationCondition: "statModel" },
    { slotId: "data_ethics", roleKey: "data_ethics", roleName: "数据伦理专家", activationCondition: "personalData" },
  ]},
  research: { roleKey: "research_execution", splitDimension: "subtopic", dimLabel: "子主题/章节/资料源", conditionals: [
    { slotId: "domain_expert", roleKey: "domain_expert", roleName: "领域专家", activationCondition: "expertDomain" },
  ]},
  content: { roleKey: "content_execution", splitDimension: "module", dimLabel: "模块/渠道/受众", conditionals: [
    { slotId: "seo", roleKey: "seo", roleName: "SEO/渠道优化专家", activationCondition: "operationalContent" },
    { slotId: "visual", roleKey: "visual", roleName: "视觉设计师", activationCondition: "needVisual" },
  ]},
};

/** 其余领域模板：data_analysis / research / content / document / generic（领域化节点）。 */
export function buildConciseTemplate(domain, chain) {
  const exec = DOMAIN_EXEC[domain];
  const execRole = exec?.roleKey ?? "frontend";
  const splitDim = exec?.splitDimension ?? "module";
  const conds = exec?.conditionals ?? [];
  const condNodes = conds.map((c, i) => dagNode({
    id: `C${i}`, slotId: c.slotId, roleName: c.roleName, phase: "design", activationCondition: c.activationCondition,
  }));
  const nodes = [
    dagNode({ id: "S0", nodeType: "system", roleName: "用户触发" }),
    dagNode({ id: "S1", nodeType: "system", roleName: "总指挥初始化 + 原始需求快照 + 源/目标路径解析" }),
    dagNode({ id: "S2", slotId: "goal", roleName: "目标理解（产品经理两阶段）", phase: "design" }),
    dagNode({ id: "S3", nodeType: "system", roleName: "任务类型识别 + 任务性质识别" }),
    dagNode({ id: "S4", nodeType: "system", roleName: "调查触发评估（force/auto/skip + 评分卡）" }),
    dagNode({ id: "S5", slotId: "discovery", roleName: "调查员（触发/跳过，复刻强制）", phase: "design", activationCondition: "investigationTriggered" }),
    dagNode({ id: "S6", nodeType: "gate", roleName: "调查充分性门禁", phase: "gate", signOffRequired: true }),
    dagNode({ id: "S7", nodeType: "gate", roleName: "条件启用三方会签", phase: "gate", signOffRequired: true }),
    dagNode({ id: "S8", slotId: "design", roleName: "方案设计", phase: "design" }),
    ...condNodes,
    dagNode({ id: "S9", nodeType: "queue", roleName: "执行队列", phase: "execute" }),
    dagNode({ id: "S10", slotId: "execution", roleName: `核心产出（拆分：${exec?.dimLabel ?? "模块"}）`, phase: "execute", splittable: true, splitDimension: splitDim }),
    dagNode({ id: "S11", slotId: "review", roleName: "结构/质量评审", phase: "gate" }),
    dagNode({ id: "S12", slotId: "verify", roleName: "事实/一致性验证", phase: "verify" }),
    dagNode({ id: "S13", slotId: "document", roleName: "产物汇总", phase: "document" }),
    dagNode({ id: "S14", slotId: "verify", roleName: "最终全功能回归验证", phase: "verify", signOffRequired: true }),
    dagNode({ id: "S15", slotId: "final_review", roleName: "最终审核（含独立复验）", phase: "final", signOffRequired: true }),
    dagNode({ id: "S16", nodeType: "system", roleName: "完成" }),
  ];
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) edges.push(dagEdge(nodes[i].id, nodes[i + 1].id));
  return {
    domain, entry: "S0", exit: "S16", nodes, edges,
    execRole, splitDimension: splitDim,
    // 方案 5.1 DagTemplate.parallelGroups：领域执行节点共享全局 5 并发席位池
    parallelGroups: [
      { id: "PG1", nodes: ["S10"], seats: "global:5", dimension: splitDim },
    ],
    rollbackEdges: [
      // 方案 5.5：领域模板同 V9.2 结构，回退边含调查不充分与范围冲突（与 software 一致）
      rollbackEdge("S6", "S5", "investigation_insufficient", 5),
      rollbackEdge("S3", "S2", "product_scope_conflict", 3),
      rollbackEdge("S11", "S10", "review_fail", 3),
      rollbackEdge("S12", "S10", "verify_fail", 3),
      rollbackEdge("S14", "S10", "final_regression_fail", 3),
      rollbackEdge("S15", "S10", "audit_fail", 3),
    ],
  };
}

export const DOMAIN_TEMPLATES = {
  software: SOFTWARE_DAG,
  data_analysis: buildConciseTemplate("data_analysis", null),
  research: buildConciseTemplate("research", null),
  content: buildConciseTemplate("content", null),
  document: buildConciseTemplate("document", null),
  generic: buildConciseTemplate("generic", null),
};

export function templateFor(taskType) {
  return DOMAIN_TEMPLATES[taskType] ?? DOMAIN_TEMPLATES.generic;
}

/** 条件启用候选：领域模板中的条件角色（activationCondition 非空）。 */
export function conditionalCandidates(template) {
  return (template?.nodes ?? []).filter((n) => n.activationCondition).map((n) => ({
    roleSlotId: n.slotId,
    nodeId: n.id,
    roleName: n.roleName,
    condition: n.activationCondition,
  }));
}

// ---- 批次D：#26 门禁阻断三级（硬/软/警告）----
export const GATE_BLOCKING = {
  P0: "hard",  // 硬阻断：暂停整个流水线、冻结新任务、升级人工
  P1: "soft",  // 软阻断：拒绝当前节点产物、回退对应节点、其他模块可继续
  P2: "warn",  // 警告：记录问题池，可流转，最终审核前关闭或风险接受
  P3: "warn",  // 建议：记录留痕，总指挥记录后自动接受
};

// ---- 批次D：#27 门禁通过标准量化 ----
export const GATE_PASS_CRITERIA = {
  requiredArtifacts: ["当前节点产物", "评审/测试报告", "问题清单"],
  requiredChecks: ["必需产物齐全", "必需检查项逐项通过", "问题等级阈值（P0/P1 必须为零）", "未关闭问题数 ≤ 3", "必需签字角色已签字"],
  severityThreshold: "P2", // 高于此等级（P0/P1）不得放行
  maxOpenIssues: 3,
  signers: ["门禁角色", "最终审核（交叉确认）"],
};

// ---- 批次D：#28/#29 门禁执行者与职责边界 ----
export const GATE_EXECUTORS = {
  investigation_sufficiency: ["orchestrator", "architect"],   // 总指挥主审 + 架构师交叉确认
  design_review: ["review"],                                  // 设计评审 = 内容审查（设计一致性/可实现性）
  final_audit: ["final_review"],                              // 最终审核 = 流程审查 + 独立复验
  security_audit: ["risk"],                                   // 安全工程师 = 审查型门禁
  security_test: ["security_test"],                           // 安全测试工程师 = 测试型验证
};

// ---- 批次E：#43 版本递增规则（谁递增/何时递增/写入快照）----
export const VERSION_RULES = {
  scheme: "方案版本=产品经理正式定义后；契约版本=契约冻结后；设计版本=设计评审门禁通过后；设计契约版本=契约冻结后；模块产物版本=模块返工后；条件角色版本=该角色产物更新后；回退触发时受影响的所有版本递增；所有递增写入快照。",
  bumpOnRollback: true,
  persist: "snapshot",
};
