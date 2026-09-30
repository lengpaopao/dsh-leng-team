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
  // 修复第十轮 M1b：原实现的 p1/p3 极性写反了——把「目标明确/范围清晰/目标可验证」这类**好**
  // 描述判成 P1 关键缺失，把「目标模糊/范围不清/待定」这类**坏**描述降为 P3 建议补充。
  { key: "target_verifiable", label: "目标可验证", p1: /(目标|范围).{0,12}(模糊|不清|不明确|待定|矛盾|无法验证|难以验证|未定义)/i, p3: /(目标|范围)/i },
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
  // 修复第十轮 K-5：编排器此前传的是 `this.config.conditional`（布尔），本类却把它当配置对象存，
  // 于是 discovery.* 整族配置（sufficiencyGate/maxRounds/…）永远读不到。现约定只接
  // `config.discovery` 子对象，并用类型守卫兜住历史调用方传入的布尔值。
  constructor(cfg = {}) {
    this.config = cfg && typeof cfg === "object" ? cfg : {};
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

  evaluate(goal, taskType, opts = {}) {
    // 修复第十轮 K-5：把配置派生的调查选项（复刻关键词/强制调查/允许跳过/深度）透传给触发评估，
    // 使「本类内部重算」与「编排器算出的 inv」在配置生效时保持一致；缺省时行为与修复前完全相同。
    const ev = evaluateInvestigation(goal, taskType, opts.weights ?? this.config?.weights, opts);
    ev.validator = this.validatorFor(taskType);
    return ev;
  }

  /**
   * 生成调查任务上下文：把「需要核实的点」转成调查员可执行的清单。
   * @param {{goal:string, taskType:string, template:string, replica?:boolean}} ctx
   */
  buildBrief(ctx) {
    // 修复第十轮 K-5：优先使用编排器已算好的调查评估（含配置派生的复刻关键词/强制调查/深度/
    // 允许跳过），避免此处内部重算导致「任务头触发决策」与「复刻强制块」依据不一致；无 ev 时
    // 回落内部评估（向后兼容旧调用方）。
    const ev = ctx.eval && typeof ctx.eval === "object" ? ctx.eval : this.evaluate(ctx.goal, ctx.taskType);
    const replica = ctx.replica ?? ev.replica;
    const sourcePath = ctx.sourcePath ?? ev.sourcePath ?? null;
    const targetPath = ctx.targetPath ?? ev.targetPath ?? null;
    const brief = [];
    brief.push(`## 调查任务（任务类型：${ctx.taskType ?? "?"}，触发决策：${ev.decision}${ev.replica ? "·复刻强制" : ""}${ev.depth ? `·深度:${ev.depth}` : ""}）`);
    brief.push(`## 目标\n${String(ctx.goal ?? "")}`);
    brief.push("请完成以下现状调查与事实收集，不得做产品决策、不写最终需求、不做安全裁决：");
    brief.push("1. 目标校验：该目标是否可交付、范围是否清晰、是否存在歧义或隐含前提；");
    brief.push("2. 现状盘点：相关已有系统/数据/流程/依赖/第三方接口的现状与约束；");
    brief.push("3. 事实收集：关键技术约束、数据源、合规要求、可用资产清单；");
    brief.push("4. 假设与约束识别：列出显式假设、隐式假设、硬约束、软约束；");
    // 第十二轮接线 `discovery.evidenceSources`（默认「内置」）：该键此前是死配置（设置页可改、
    // 调查任务从未提及）。现作为「可用来源要求」注入调查任务第 5 项；默认值下文案即「内置能力」。
    const eviSrc = String(this.config?.evidenceSources ?? "").trim();
    const eviTail = eviSrc && eviSrc !== "内置"
      ? "（以该来源为准；该来源不可得时必须显式说明并回落内置只读能力）"
      : "（调查员自身只读工具与现有文档）";
    brief.push(`5. 证据来源：逐条事实标注来源/出处/链接/路径（供证据索引使用）；可用来源要求：${eviSrc || "内置"}${eviTail}；`);
    brief.push("6. 条件线索（非决策）：列出可能命中条件角色的【事实线索】（如是否存在持久化、认证/支付/隐私、对外接口、团队/多环境、生产规模），并给出理由。禁止给出启用/禁用决策——条件角色最终由「条件启用三方会签」裁决。");
    brief.push("7. 风险线索清单：只列【事实与线索】（如涉及认证/支付/隐私/对外接口/第三方依赖/许可证），禁止做风险定级与结论——风险定级与安全裁决归安全工程师门禁。");
    if (replica) {
      brief.push("8. 复刻类强制项：必须对照源项目基线完成以下盘点（禁止跳过），并逐项给出结论：");
      brief.push("   范围说明（#9）：本次调查的主范围以【调查触发评估的 scope 决策】为准；产品经理第一阶段产出的待调查清单仅作补充建议；两者冲突时以调查触发评估为准。");
      // 修复第十轮 K-5：原文案只声明「以 scope 决策为准」，却从未把评估给出的 scope 注入任务，
      // 调查员无从知道主范围。现把 scope 清单与优先级直接写进任务。
      brief.push(`   本次评估的 scope 决策：${(ev.scope ?? []).length ? ev.scope.join("、") : "（未指定，按目标覆盖现状）"}；优先级：${ev.priority ?? "P2"}；需证据：${ev.evidenceRequired === false ? "否" : "是"}`);
      // BUG 修复（2026-09-29）：把源/目标路径显式注入调查任务。
      // 调查员拥有只读文件能力（glob/read/grep），必须实际探查源项目目录再逐项盘点，
      // 禁止仅凭目标描述臆测源项目功能。
      if (sourcePath) brief.push(`   - 源项目目录：${sourcePath}（请用只读工具 glob/read/grep 实际探查该目录：列目录结构、读关键文件、检索接口/功能关键词后再盘点）`);
      if (targetPath) brief.push(`   - 目标目录：${targetPath}`);
      REPLICA_DELIVERABLES.forEach((d) => brief.push(`   - ${d}`));
      brief.push("   差异与未知项必须单独列出，不得隐去。");
    }
    brief.push("调查报告末尾必须以 `## 调查结论` 开头：`调查充分：是/否`；随后列出「条件启用建议」。");
    return { decision: ev.decision, reason: ev.reason, replica: !!replica, depth: ev.depth, scope: ev.scope ?? [], brief: brief.join("\n\n") };
  }

  /** 解析调查报告：充分性 9 项门禁 + 条件启用建议 + 证据引用。 */
  parse(report) {
    const txt = String(report ?? "");
    const lines = txt.split("\n");
    const joined = txt;
    // 修复第十轮 M1a：原实现 `/(充分|足够|已覆盖|覆盖完整)/` 会命中结论行「调查充分：否」里的
    // 「充分」二字 → 「否」被读成「是」；且要求报告出现肯定词才判充分，导致「零 P1、仅 P3 提示」
    // 的合格报告被判不充分（实测软件类因此白跑 4 轮回环 + 4 次调查调用后升级总指挥裁决）。
    // 现：优先读显式结论行；无结论行时以「无 P1 问题且无显式缺陷信号」为充分（见下方）。
    const mSufficient = txt.match(/调查充分\s*[:：]\s*(是|否)/i);
    const declaredSufficient = mSufficient ? mSufficient[1] === "是" : null;
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
    // 修复第十轮 M1c：原实现只要正文出现「不充分|不足|缺失|未覆盖|矛盾」任一关键词就记 P1，
    // 调查员按模板写的条件句（「缺失时按保守假设推进」「接口数量不足时…」「存在矛盾风险…」
    // 「本报告不涉及未覆盖范围」）全部命中 → 幻影 P1 → 连带软阻断 5 道门禁。现要求
    // 「缺陷主语 + 判定语」同句出现，且该句不是条件句/否定句/风险提示句。
    const EXPLICIT_DEFECT = /(调查(?:报告|结论|过程)?|报告|结论|现状盘点|事实收集|证据)[^。；\n]{0,24}(不充分|不完整|存在(?:重大)?(?:缺失|矛盾|冲突)|关键(?:事实|信息|数据)(?:缺失|不足)|未能(?:覆盖|核实|获取))/;
    const CONDITIONAL = /(时|若|如果|假设|兜底|保守假设|风险|不涉及|未涉及|除外|待(?:确认|核实)|[:：]\s*(?:无|没有|未发现|不适用))/;
    const explicitBad = /调查充分\s*[:：]\s*否/.test(txt)
      || lines.some((ln) => { const t = ln.trim(); return EXPLICIT_DEFECT.test(t) && !CONDITIONAL.test(t); });
    if (explicitBad) {
      problems.push({ level: 1, key: "explicit", text: "调查报告显式自报不充分/存在关键缺失或矛盾（P1）" });
    }
    const p1Count = problems.filter((p) => p.level === 1).length;
    const sufficient = declaredSufficient !== null ? declaredSufficient : (p1Count === 0 && !explicitBad);
    // 修复第十轮 K-5：discovery.sufficiencyGate（默认 true）此前是死旋钮——关掉照样回环重调查。
    // 现：关闭时门禁不阻断（sufficient 记 true），但问题清单原样返回，由编排器直接入池，
    // 即「不阻断」不等于「不记录」。
    const gateDisabled = this.config?.sufficiencyGate === false;
    const maxLoopsCfg = Number(this.config?.maxRounds);
    const gateResult = {
      sufficient: gateDisabled ? true : (sufficient && p1Count === 0),
      gateDisabled,
      problems,
      p1Count,
      // 修复第十轮 K-5：回环上限原为硬编码 5，现与 discovery.maxRounds 同一数据源（3–8，默认 5）
      maxLoops: Number.isFinite(maxLoopsCfg) && maxLoopsCfg > 0 ? Math.max(1, Math.min(8, maxLoopsCfg)) : 5,
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
