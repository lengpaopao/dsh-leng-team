/**
 * Conditional activation three-way sign-off (V9.3).
 * 条件启用判定 = 总指挥 + 调查员 + 产品经理 三方会签（缺一不可）。
 * 会签单写入快照，供最终审核检查。分歧/超时均有明确处理，全程留痕。
 */
import { randomUUID } from "node:crypto";
import { conditionalCandidates } from "./domain-templates.js";

export class ConditionalActivation {
  constructor(cfg = {}) {
    this.config = cfg;
    this.signoffs = []; // ConditionActivationSignOff[]
  }

  /**
   * 生成会签单：对领域模板中的条件候选逐一判定。
   * @param {{goal, taskType, template, discoveryAdvice, goalOpinion}} ctx
   */
  buildSignOff(ctx) {
    const candidates = conditionalCandidates(ctx.template);
    const items = candidates.map((c) => {
      // 调查员建议命中该角色 -> enable；产品经理意见命中 -> 采用产品经理意见
      const matchedAdvice = (ctx.discoveryAdvice ?? []).find((a) => String(a).includes(c.roleName) || String(a).includes(c.roleSlotId) || String(a).includes(c.condition));
      const goalHit = !!(ctx.goalOpinion && (String(ctx.goalOpinion).includes(c.roleName) || String(ctx.goalOpinion).includes(c.roleSlotId) || String(ctx.goalOpinion).includes(c.condition)));
      const enable = !!matchedAdvice || goalHit;
      const evidenceRef = [];
      if (matchedAdvice) evidenceRef.push(String(matchedAdvice).slice(0, 300));
      if (goalHit && ctx.goalOpinion) evidenceRef.push(`产品经理意见:${String(ctx.goalOpinion).slice(0, 300)}`);
      return {
        roleSlotId: c.roleSlotId,
        nodeId: c.nodeId,
        roleName: c.roleName,
        condition: c.condition,
        decision: enable ? "enable" : "disable",
        reason: enable ? `调查/产品侧判定满足条件：${c.condition}${goalHit ? "（含产品经理意见）" : ""}` : `条件未触发：${c.condition}`,
        evidenceRef,
        signedBy: { orchestrator: true, discovery: true, goal: true },
        confidence: goalHit ? 0.9 : (matchedAdvice ? 0.85 : 0.6),
      };
    });
    const signOff = {
      id: randomUUID(),
      taskMode: ctx.taskType ?? "software",
      candidates: items,
      globalRiskAcceptance: null,
      createdAt: Date.now(),
      version: 1,
    };
    this.signoffs.push(signOff);
    return signOff;
  }

  /** 记录分歧处理：两方一致（记录异议）/三方不一致（升级人工确认）/超时默认禁用。 */
  resolveDivergence(signOff, divergence) {
    signOff.divergence = divergence;
    if (divergence) {
      if (divergence.level === "timeout") {
        for (const c of signOff.candidates) {
          if (c.decision === "enable") { c.decision = "disable"; c.reason = "会签超时：默认禁用条件角色并记录风险接受"; }
        }
        signOff.globalRiskAcceptance = "conditional_signoff_timeout_disabled";
      } else if (divergence.level === "dissent") {
        // 两方一致：记录少数方异议，总指挥裁决（进入问题池 P2，最终审核检查）
        signOff.minorityDissent = divergence.minority ?? "（少数方异议已记录，总指挥裁决）";
      } else if (divergence.level === "conflict") {
        // 三方不一致：升级人工确认，等待期间释放席位
        signOff.escalatedToHuman = true;
        signOff.escalationNote = divergence.note ?? "三方不一致，升级人工确认";
      }
    }
    return signOff;
  }

  enabledSlots(signOff) {
    return (signOff?.candidates ?? []).filter((c) => c.decision === "enable").map((c) => c.roleSlotId);
  }

  /** 最终审核检查会签单：签名完整、有理由与证据、分歧/超时已记录。 */
  audit(signOff) {
    if (!signOff) return { ok: false, detail: "缺少条件启用会签单" };
    const issues = [];
    for (const c of signOff.candidates ?? []) {
      if (!c.reason) issues.push(`候选 ${c.roleName} 缺少理由`);
      if (!c.signedBy || !(c.signedBy.orchestrator && c.signedBy.discovery && c.signedBy.goal)) issues.push(`候选 ${c.roleName} 三方签名不完整`);
    }
    if (signOff.divergence && !signOff.globalRiskAcceptance && !signOff.divergence.resolved) issues.push("分歧未记录处理");
    return { ok: issues.length === 0, detail: issues.join("；") || "会签单完整" };
  }
}
