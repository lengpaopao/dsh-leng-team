// 第十二轮 K-12B：断点续跑的「阶段级复用」声明面。
//
// 背景（第十轮 K-12 / 第十一轮方案 C）：
//   崩溃或中断后 `/team start` 会用快照恢复 activeRun，但 `_runPipeline` 是线性函数，
//   恢复后必然从第一阶段重跑——用户实测「product / analyst 被再次调用，续跑没有省下 token」。
//   第十一轮只做了**模块级**复用（dev 阶段跳过已交付模块），前置阶段仍然全量重跑。
//
// 本文件是「阶段 → 产物字段 → 主责角色」的**唯一声明处**，由 `lib/orchestrator.js` 的
//   `_runRole()` 在恢复态下消费，并由 `scripts/check-declarations.mjs` 做不变式校验：
//     ① stage 必须真实出现在 orchestrator 的 `run.stage = "<stage>"` 赋值里；
//     ② field 必须真实被 orchestrator 赋值（`run.<field> = ...`）；
//     ③ field 必须出现在 `_snapshot()` 的 runState 白名单里（否则恢复后字段为空 → 复用永不成立）；
//     ④ role 必须存在于 ROLE_MAP（`*` 表示「该阶段的首个角色调用」，用于 domain_design 这类设计角色随领域变化）。
//
// 刻意**不纳入**复用的阶段（写在这里是为了让后来者知道这是判断而不是遗漏）：
//   - security / review / test / performance / security_test / prelaunch_security / final_regression / audit：
//     这些阶段在 `_runRole` 之后会调用 `_recordIssuesFrom()` 等把结构化问题写入问题池，
//     而问题池本身已随快照恢复；复用产物会让同一批问题被二次入池（重复条目）。
//     要复用它们，必须先给问题池加「幂等入池」语义，属独立议题。
//   - dev / domain_exec：模块级复用已在 `_runDevelopment` 内实现（第十一轮）。
//   - discovery / signoff / design_contract / done：产物不是单角色文本，或无 Agent 调用。
export const STAGE_REUSE = {
  product_light: { field: "productLight", role: "product", label: "产品经理第一阶段（轻量目标理解）" },
  product: { field: "product", role: "product", label: "产品经理第二阶段（需求定稿）" },
  analyst: { field: "analyst", role: "analyst", label: "需求分析师" },
  architect: { field: "architecture", role: "architect", label: "架构师" },
  tech_lead: { field: "techLead", role: "tech_lead", label: "技术负责人（详细设计）" },
  data: { field: "dataDesign", role: "data", label: "数据设计" },
  ux: { field: "ux", role: "ux", label: "UX 设计师" },
  ui: { field: "ui", role: "ui", label: "UI 设计师" },
  domain_design: { field: "domainDesign", role: "*", label: "领域设计（data_design/research_design/content_design）" },
  docs: { field: "docs", role: "docs", label: "文档工程师" },
};

/** 该阶段是否声明了可复用产物（供自检/报告用）。 */
export function stageReuseEntry(stage) {
  return Object.prototype.hasOwnProperty.call(STAGE_REUSE, String(stage ?? "")) ? STAGE_REUSE[String(stage)] : null;
}
