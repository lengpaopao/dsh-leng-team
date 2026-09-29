/**
 * Discovery investigator slot (V9.3).
 * 前置到产品经理正式定义之前：目标校验、现状盘点、事实收集、假设与约束识别，
 * 输出调查报告并附带「条件启用建议」，复刻类强制触发、禁止跳过。
 * 调查充分性门禁按 9 项检查（目标可验证/需求有证据/假设显式标注/未知项有负责人/
 * 冲突已上报/区分原始与推断/证据可追溯/合规风险已识别/复刻源项目覆盖完整）。
 */
import { randomUUID } from "node:crypto";
import { evaluateInvestigation } from "./domain-templates.js";

// 充分性检查项（方案 3.5：9 项；P1=目标矛盾/关键事实缺失，P2=假设未标注/证据不足，P3=补充建议）
const SUFFICIENCY_CHECKS = [
  { key: "target_verifiable", label: "目标可验证", p1: /(目标|范围).*(可验证|明确|可交付|清晰)/i, p3: /(目标|范围).*(模糊|不清|待定)/i },
  { key: "requirement_evidence", label: "需求有证据", p1: /(关键事实|核心事实).*(缺失|没有|缺乏)/i, p2: /(证据|依据|事实).*(不足|缺乏|缺失|没有)/i, p3: /(事实|证据)/i },
  { key: "assumption_marked", label: "假设显式标注", p2: /(假设|未知).*(未|没有|缺失|标注)/i, p3: /(假设|未知)/i },
  { key: "unknown_owner", label: "未知项有负责人", p3: /(未知|待确认|待核实)/i },
  { key: "conflict_reported", label: "冲突已上报", p3: /(冲突|矛盾|不一致)/i },
  { key: "origin_split", label: "区分原始与推断需求", p3: /(原始需求|用户原话|推断|推测)/i },
  { key: "evidence_traceable", label: "证据可追溯", p3: /(来源|出处|引用|链接|证据源)/i },
  { key: "compliance_risk", label: "合规风险已识别", p3: /(合规|隐私|法规|许可|安全风险)/i },
  { key: "replica_coverage", label: "复刻源项目覆盖完整", p3: /(源项目|基线|目录|清单|盘点|接口清单|依赖)/i },
];

const REPLICA_DELIVERABLES = [
  "《现有项目资产盘点报告》", "《目录结构与技术栈清单》", "《功能清单与入口清单》",
  "《接口清单与数据流清单》", "《数据库/配置/环境变量清单》", "《依赖清单与安装方式》",
  "《部署方式与运行方式》", "《测试/文档/脚本清单》", "《第三方服务/许可证/安全风险清单》",
  "《可复刻项清单与差异说明》", "《差异与未知清单》", "《证据索引》",
];

export class Discovery {
  constructor(cfg = {}) {
    this.config = cfg;
    this.reports = new Map(); // goalKey -> report
  }

  /**
   * 调查触发评估（force/auto/skip）。
   * @param {{goal:string, taskType:string, replica?:boolean}} ctx
   */
  /** #35：调查跳过时目标校验执行者按任务类型决定（greenfield→goal、research/content→design、generic→goal）。 */
  validatorFor(taskType) {
    if (taskType === "research" || taskType === "content") return "design";
    return "goal";
  }

  evaluate(goal, taskType) {
    const ev = evaluateInvestigation(goal, taskType);
    ev.validator = this.validatorFor(taskType);
    return ev;
  }

  /**
   * 生成调查任务上下文：把「需要核实的点」转成调查员可执行的清单。
   * @param {{goal:string, taskType:string, template:string, replica?:boolean}} ctx
   */
  buildBrief(ctx) {
    const ev = this.evaluate(ctx.goal, ctx.taskType);
    const brief = [];
    brief.push(`## 调查任务（任务类型：${ctx.taskType ?? "?"}，触发决策：${ev.decision}${ev.replica ? "·复刻强制" : ""}${ev.depth ? `·深度:${ev.depth}` : ""}）`);
    brief.push(`## 目标\n${String(ctx.goal ?? "")}`);
    brief.push("请完成以下现状调查与事实收集，不得做产品决策、不写最终需求、不做安全裁决：");
    brief.push("1. 目标校验：该目标是否可交付、范围是否清晰、是否存在歧义或隐含前提；");
    brief.push("2. 现状盘点：相关已有系统/数据/流程/依赖/第三方接口的现状与约束；");
    brief.push("3. 事实收集：关键技术约束、数据源、合规要求、可用资产清单；");
    brief.push("4. 假设与约束识别：列出显式假设、隐式假设、硬约束、软约束；");
    brief.push("5. 证据来源：逐条事实标注来源/出处/链接/路径（供证据索引使用）；");
    brief.push("6. 条件线索（非决策）：列出可能命中条件角色的【事实线索】（如是否存在持久化、认证/支付/隐私、对外接口、团队/多环境、生产规模），并给出理由。禁止给出启用/禁用决策——条件角色最终由「条件启用三方会签」裁决。");
    brief.push("7. 风险线索清单：只列【事实与线索】（如涉及认证/支付/隐私/对外接口/第三方依赖/许可证），禁止做风险定级与结论——风险定级与安全裁决归安全工程师门禁。");
    if (ctx.replica) {
      brief.push("8. 复刻类强制项：必须对照源项目基线完成以下盘点（禁止跳过），并逐项给出结论：");
      brief.push("   范围说明（#9）：本次调查的主范围以【调查触发评估的 scope 决策】为准；产品经理第一阶段产出的待调查清单仅作补充建议；两者冲突时以调查触发评估为准。");
      // BUG 修复（2026-09-29）：把源/目标路径显式注入调查任务。
      // 调查员拥有只读文件能力（glob/read/grep），必须实际探查源项目目录再逐项盘点，
      // 禁止仅凭目标描述臆测源项目功能。
      if (ctx.sourcePath) brief.push(`   - 源项目目录：${ctx.sourcePath}（请用只读工具 glob/read/grep 实际探查该目录：列目录结构、读关键文件、检索接口/功能关键词后再盘点）`);
      if (ctx.targetPath) brief.push(`   - 目标目录：${ctx.targetPath}`);
      REPLICA_DELIVERABLES.forEach((d) => brief.push(`   - ${d}`));
      brief.push("   差异与未知项必须单独列出，不得隐去。");
    }
    brief.push("调查报告末尾必须以 `## 调查结论` 开头：`调查充分：是/否`；随后列出「条件启用建议」。");
    return { decision: ev.decision, reason: ev.reason, replica: !!ev.replica, depth: ev.depth, brief: brief.join("\n\n") };
  }

  /** 解析调查报告：充分性 9 项门禁 + 条件启用建议 + 证据引用。 */
  parse(report) {
    const txt = String(report ?? "");
    const lines = txt.split("\n");
    const joined = txt;
    const sufficient = /调查充分[:：]\s*是/i.test(txt) || /(充分|足够|已覆盖|覆盖完整)/i.test(txt);
    const conditionAdvice = [];
    const evidenceRefs = [];
    let inCond = false;
    for (const ln of lines) {
      const t = ln.trim();
      if (/条件启用建议/i.test(t)) { inCond = true; continue; }
      if (inCond && /^\s*[-*]?\s*\[?(启用|建议启用|开启|不启用|不建议)/i.test(t)) {
        conditionAdvice.push(t.replace(/^\s*[-*]?\s*/, "").trim());
      }
      if (inCond && !t && conditionAdvice.length > 0) inCond = false;
    }
    // 证据引用提取：来源/出处/链接/路径行
    for (const ln of lines) {
      const t = ln.trim();
      if (/^[-*]?\s*(来源|出处|引用|链接|证据源|证据索引|路径|file|url)[:：]/i.test(t)) {
        const v = t.replace(/^[-*]?\s*(来源|出处|引用|链接|证据源|证据索引|路径|file|url)[:：]\s*/i, "").trim();
        if (v && v.length < 500) evidenceRefs.push(v);
      }
    }
    // 充分性门禁 9 项检查（宽松判定的基础上叠加显式缺陷识别；方案 3.5：P1 目标矛盾/关键事实缺失，P2 假设未标注/证据不足，P3 补充建议）
    const problems = [];
    for (const c of SUFFICIENCY_CHECKS) {
      if (c.p1 && c.p1.test(txt)) problems.push({ level: 1, key: c.key, text: `${c.label}存在关键缺失（P1）` });
      else if (c.p2 && c.p2.test(txt)) problems.push({ level: 2, key: c.key, text: `${c.label}不足/未标注（P2）` });
      else if (c.p3 && c.p3.test(txt)) problems.push({ level: 3, key: c.key, text: `${c.label}建议补充（P3）` });
    }
    // 显式缺陷信号：调查员自报不充分 / 目标矛盾 / 关键事实缺失
    if (/不充分|不足|缺失|未覆盖|矛盾|冲突未解决/i.test(txt)) {
      problems.push({ level: 1, key: "explicit", text: "调查报告显式存在不充分/缺失/矛盾信号（P1）" });
    }
    const p1Count = problems.filter((p) => p.level === 1).length;
    const gateResult = {
      sufficient: sufficient && p1Count === 0,
      problems,
      p1Count,
      maxLoops: 5,
      escalated: false,
    };
    return { sufficient: gateResult.sufficient, conditionAdvice, evidenceRefs, problems, gateResult, length: txt.length };
  }

  /** 生成一份完整调查报告记录（含充分性门禁结果、条件启用建议与证据）。 */
  createReport(goalKey, decision, brief, rawOutput) {
    const parsed = this.parse(rawOutput);
    const report = {
      id: randomUUID(),
      goal: goalKey,
      decision,
      conditionAdvice: parsed.conditionAdvice,
      sufficient: parsed.sufficient,
      evidenceRefs: parsed.evidenceRefs,
      problems: parsed.problems,
      gateResult: parsed.gateResult,
      content: String(rawOutput ?? ""),
      createdAt: Date.now(),
    };
    this.reports.set(goalKey, report);
    return report;
  }

  get(goalKey) { return this.reports.get(goalKey); }
}
