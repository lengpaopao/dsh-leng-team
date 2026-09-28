/**
 * Independent verification for final review (V9.3).
 * 单模型多角色架构下"独立"只能相对独立，因此强化：
 *   角色隔离、多轮抽样(≥3)、镜像复验、证据链独立、外部对照(复刻对源基线/非复刻对原始需求)、
 *   盲审(不读执行角色口头结论/完成声明)、反方质询(显式列出"为什么可能不合格"逐条验证)、
 *   风险接受复核 + 问题分级复核、三态结论(pass/conditional/fail)。
 */
import { randomUUID } from "node:crypto";

export class IndependentVerification {
  constructor(cfg = {}) {
    this.enabled = cfg.enabled !== false;
    this.rounds = Math.max(1, Number(cfg.rounds ?? 3));
    this.samples = Math.max(1, Number(cfg.samples ?? 3));
    this.mirror = cfg.mirror !== false;
    this.blind = cfg.blind !== false;
    this.counter = cfg.counter !== false;
    this.records = []; // IndependentVerification[]
  }

  /**
   * 构造最终审核（独立复验）上下文：只喂原始产物/证据索引/问题池/快照，
   * 不喂执行角色的"完成声明"（盲审）。
   * @param {{goal, snapshot, issues, artifacts:{name,content}[], template, replica, baselineInfo}} ctx
   */
  buildContext(ctx) {
    const lines = [];
    lines.push("你是最终审核工程师，执行独立复验。不得读取执行角色的口头结论或完成声明（盲审），只基于以下原始产物、证据与问题池独立判断。");
    lines.push(`## 目标快照\n${String(ctx.goal ?? "")}`);
    if (ctx.replica) lines.push(`## 源项目基线对照\n${String(ctx.baselineInfo ?? "（未提供，须在结论中说明）")}\n必须对照源基线做行为差异测试。`);
    else lines.push("## 对照基准\n对照原始需求快照与验收标准。");
    lines.push(`## 证据/问题池\n${String(ctx.issuesSummary ?? "")}`);
    lines.push(`## 关键产物\n`);
    for (const a of ctx.artifacts ?? []) {
      lines.push(`### ${a.name}\n${String(a.content ?? "").slice(0, Number(ctx.slice ?? 8000))}`);
    }
    lines.push("输出要求：");
    lines.push("1. 先写 `审核结论：合格 / 有条件合格 / 不合格` 三态之一；");
    lines.push("2. 列出抽样复核的多轮记录（覆盖不同模块/阶段/风险等级）；");
    lines.push("3. 反方质询：显式列出『为什么可能不合格』的质疑点并逐条验证；");
    lines.push("4. 独立复核 P0/P1/P2 分级与风险接受记录；");
    lines.push("5. 检查：调查充分性、设计闭环、回归测试、问题池、条件启用会签单、全局回退预算是否闭环；");
    lines.push("6. 末尾输出 `独立复验结论：pass / conditional / fail`。");
    return lines.join("\n\n");
  }

  /** 解析审核文本，提取三态结论与复验要点。 */
  parse(report) {
    const txt = String(report ?? "");
    let conclusion = "conditional";
    if (/审核结论[:：]\s*合格\s*$/m.test(txt) || /审核结论[:：]\s*合格\s*(?![^，。；]*但)/.test(txt)) conclusion = "pass";
    else if (/审核结论[:：]\s*不合格/.test(txt)) conclusion = "fail";
    const iv = txt.match(/独立复验结论[:：]\s*(pass|conditional|fail)/i);
    if (iv) conclusion = iv[1].toLowerCase();
    const counterArgs = [];
    for (const m of txt.matchAll(/质疑[:：]?\s*([^\n]+)/gi)) counterArgs.push(m[1].trim());
    // 镜像复验产物 / 证据引用 / 基线对照 / 风险接受复核 / 问题分级复核 提取
    const mirrorArtifacts = [];
    for (const m of txt.matchAll(/(?:镜像复验|对照产物)[:：]?\s*([^\n]+)/gi)) mirrorArtifacts.push(m[1].trim().slice(0, 200));
    if (mirrorArtifacts.length === 0 && /对照产物|镜像|重新生成|再生成/i.test(txt)) mirrorArtifacts.push("（报告中存在镜像/对照表述，未提取到具体条目）");
    const evidenceRefs = [];
    for (const m of txt.matchAll(/^\s*[-*]?\s*(?:证据|来源|引用|出处)[:：]\s*(.+)$/gim)) evidenceRefs.push(m[1].trim().slice(0, 300));
    let baselineCompare = null;
    const bm = txt.match(/(?:基线对照|源基线|对照基准|行为差异)[:：]?\s*([^\n]+)/i);
    if (bm) baselineCompare = bm[1].trim().slice(0, 300);
    let riskAcceptanceReview = "";
    const rm = txt.match(/(?:风险接受复核|P2[^\n]{0,30}确认|P3[^\n]{0,30}公示)[^\n]*/i);
    if (rm) riskAcceptanceReview = rm[0].trim().slice(0, 300);
    let problemLevelReview = "";
    const pm = txt.match(/(?:问题分级复核|P0\/P1\/P2[^\n]{0,40}|分级复核)[^\n]*/i);
    if (pm) problemLevelReview = pm[0].trim().slice(0, 300);
    return {
      conclusion,
      counterArguments: counterArgs.slice(0, 20),
      mirrorArtifacts,
      evidenceRefs,
      baselineCompare,
      riskAcceptanceReview,
      problemLevelReview,
      length: txt.length,
      hasSamples: (txt.match(/抽样|第\s*[一二三四五六七八九十\d]\s*轮|round/i)?.length ?? 0) >= 1,
      hasMirror: this.mirror ? /对照产物|镜像|重新生成|再生成/i.test(txt) : true,
      hasCounter: this.counter ? counterArgs.length > 0 : true,
    };
  }

  createRecord(goalKey, report) {
    const parsed = this.parse(report);
    const rec = {
      id: randomUUID(),
      goal: goalKey,
      rounds: this.rounds,
      samples: this.samples,
      conclusion: parsed.conclusion,
      counterArguments: parsed.counterArguments,
      mirrorArtifacts: parsed.mirrorArtifacts ?? [],
      evidenceRefs: parsed.evidenceRefs ?? [],
      baselineCompare: parsed.baselineCompare ?? null,
      riskAcceptanceReview: parsed.riskAcceptanceReview ?? "",
      problemLevelReview: parsed.problemLevelReview ?? "",
      version: 1,
      content: String(report ?? ""),
      createdAt: Date.now(),
    };
    this.records.push(rec);
    return rec;
  }

  /** 审核结论三态 → 是否需返工（附定位目标，供精准回退）。 */
  gate(conclusion, reportText = "") {
    const txt = String(reportText ?? "");
    if (conclusion === "pass") return { needRework: false, rework: [] };
    const rework = [];
    if (/设计|UI|界面|视觉|交互|样式|还原/.test(txt)) rework.push("ui");
    if (/需求|产品|目标|验收|范围/.test(txt)) rework.push("product");
    if (/架构|技术选型|模块/.test(txt)) rework.push("architect");
    if (/测试|缺陷|回归/.test(txt)) rework.push("tester");
    if (rework.length === 0) rework.push("ui", "product");
    const reason = conclusion === "conditional"
      ? "有条件合格：存在待关闭问题/待处理分歧，需整改后复核"
      : "不合格：独立复验未通过，需定位问题环节整改";
    return { needRework: true, reason, rework };
  }

  snapshot() {
    return { enabled: this.enabled, rounds: this.rounds, samples: this.samples, count: this.records.length };
  }
}
