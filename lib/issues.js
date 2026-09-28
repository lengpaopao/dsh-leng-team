/**
 * IssueTracker — 统一回环规则问题分级状态机。
 *
 * 每个问题对象字段：
 *  id（唯一 ISS-xxxx）、severity（P0-P3）、status（状态机）、owner（责任人）、
 *  module（对应环节/模块）、title、evidence（证据=检查报告摘录）、
 *  fixLog（修复记录）、reviewLog（复核记录）、reworkCount（回环次数）、
 *  createdAt / updatedAt。
 *
 * 状态机：
 *  OPEN → TRIAGED → FIXING → PENDING_REVIEW → REVIEW_PASSED → CLOSED
 *                                   └── REVIEW_FAILED → FIXING
 *  TRIAGED → RISK_ACCEPTED → CLOSED（非阻断风险接受）
 *  FIXING（回环超限）→ ESCALATED →（父会话/总指挥裁决）
 *
 * 阻断判定：severity ≤ 1（P0/P1）且未关闭（非 CLOSED/RISK_ACCEPTED/REVIEW_PASSED）。
 * 非阻断（P2/P3）进入未关闭问题池，最终审核前必须关闭或风险接受。
 */

export function sevName(s) {
  return "P" + Math.min(3, Math.max(0, Number(s) || 1));
}

export class IssueTracker {
  constructor() {
    this.issues = new Map();
    this.seq = 0;
  }

  /** 新建问题（自动唯一 ID）。同 title 已存在时复用并升级/补充证据。 */
  open({ severity = 1, owner = "", module = "", title = "", evidence = "" }) {
    const key = String(title || "").trim().slice(0, 120);
    if (key) {
      const dup = [...this.issues.values()].find((i) => i.title === key);
      if (dup) {
        if (!dup.evidence && evidence) { dup.evidence = evidence; this._touch(dup); }
        return dup;
      }
    }
    const id = `ISS-${String(++this.seq).padStart(4, "0")}`;
    const issue = {
      id, severity: Math.min(3, Math.max(0, Number(severity) || 1)),
      owner: owner || "", module: module || "", title: key || id,
      evidence: String(evidence || "").slice(0, 500),
      status: "OPEN", reworkCount: 0, fixLog: [], reviewLog: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.issues.set(id, issue);
    return issue;
  }

  _touch(i) { if (i) i.updatedAt = Date.now(); }

  triage(id, severity) {
    const i = this.issues.get(id);
    if (i) { i.severity = Math.min(3, Math.max(0, Number(severity) || 1)); if (i.status === "OPEN") i.status = "TRIAGED"; this._touch(i); }
    return i;
  }

  fixing(id, note) {
    const i = this.issues.get(id);
    if (i) { i.status = "FIXING"; i.reworkCount += 1; if (note) i.fixLog.push({ at: Date.now(), note: String(note).slice(0, 300) }); this._touch(i); }
    return i;
  }

  review(id, note) {
    const i = this.issues.get(id);
    if (i) { i.status = "PENDING_REVIEW"; if (note) i.reviewLog.push({ at: Date.now(), note: String(note).slice(0, 300) }); this._touch(i); }
    return i;
  }

  pass(id, note) {
    const i = this.issues.get(id);
    if (i) { i.status = "REVIEW_PASSED"; i.reviewLog.push({ at: Date.now(), note: String(note || "").slice(0, 300), result: "pass" }); this._touch(i); }
    return i;
  }

  fail(id, note) {
    const i = this.issues.get(id);
    if (i) { i.status = "REVIEW_FAILED"; i.reviewLog.push({ at: Date.now(), note: String(note || "").slice(0, 300), result: "fail" }); this._touch(i); }
    return i;
  }

  close(id) {
    const i = this.issues.get(id);
    if (i) { i.status = "CLOSED"; this._touch(i); }
    return i;
  }

  riskAccept(id, note) {
    const i = this.issues.get(id);
    if (i) { i.status = "RISK_ACCEPTED"; i.reviewLog.push({ at: Date.now(), note: String(note || "风险接受").slice(0, 300), result: "risk_accepted" }); this._touch(i); }
    return i;
  }

  escalate(id, note) {
    const i = this.issues.get(id);
    if (i) { i.status = "ESCALATED"; i.reviewLog.push({ at: Date.now(), note: String(note || "升级父会话/总指挥裁决").slice(0, 300), result: "escalated" }); this._touch(i); }
    return i;
  }

  /** 阻断问题：P0/P1 且未关闭/未复核通过。 */
  blocking() {
    return [...this.issues.values()].filter((i) => i.severity <= 1 && i.status !== "CLOSED" && i.status !== "RISK_ACCEPTED" && i.status !== "REVIEW_PASSED");
  }

  /** 未关闭问题池（最终审核必须处理）。 */
  openPool() {
    return [...this.issues.values()].filter((i) => i.status !== "CLOSED" && i.status !== "RISK_ACCEPTED" && i.status !== "REVIEW_PASSED");
  }

  summary() {
    const all = [...this.issues.values()];
    const bySev = (s) => all.filter((i) => i.severity === s).length;
    return {
      total: all.length,
      closed: all.filter((i) => i.status === "CLOSED" || i.status === "RISK_ACCEPTED" || i.status === "REVIEW_PASSED").length,
      open: this.openPool().length,
      bySeverity: { P0: bySev(0), P1: bySev(1), P2: bySev(2), P3: bySev(3) },
      pool: this.openPool().map((i) => `${i.id}[${sevName(i.severity)}]${i.status} ${i.title}`),
      reworkTotal: all.reduce((a, i) => a + (i.reworkCount || 0), 0),
    };
  }

  serialize() {
    return { seq: this.seq, issues: [...this.issues.values()] };
  }

  restore(data) {
    if (!data) return;
    this.seq = Number(data.seq) || 0;
    this.issues = new Map((data.issues ?? []).map((i) => [i.id, i]));
  }

  clear() { this.issues.clear(); this.seq = 0; }
}

export default IssueTracker;
