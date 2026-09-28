/**
 * Global rollback budget (V9.3).
 * 防止跨节点震荡（A→B→A→B）。全局回退总次数、滑动窗口、升级阈值、
 * 回退后版本递增 + 下游 stale 标记。超限/震荡强制升级人工裁决。
 */
export class RollbackBudget {
  constructor(cfg = {}) {
    this.totalBudget = Number(cfg.totalBudget ?? 10);
    this.perNodeBudget = Number(cfg.perNodeBudget ?? 5);
    this.perEdgeBudget = Number(cfg.perEdgeBudget ?? 3);
    this.windowSize = Number(cfg.windowSize ?? cfg.windowSizeMs ?? 30 * 60 * 1000); // 30 min
    this.escalationThreshold = Number(cfg.escalationThreshold ?? 8);
    this.usedBudget = 0;
    this.windowUsed = 0;
    this.windowStart = Date.now();
    this.perEdge = new Map();  // "from>to" -> count
    this.perNode = new Map();  // node -> count
    this.oscillations = new Map(); // pattern key -> count
    this.events = [];          // rollback events (version increment / stale)
    this.escalated = false;
    this.escalationReason = null;
  }

  record(edge, node, reason, trigger) {
    const now = Date.now();
    if (now - this.windowStart > this.windowSize) { this.windowStart = now; this.windowUsed = 0; }
    this.usedBudget += 1;
    this.windowUsed += 1;
    const ek = `${edge.from}>${edge.to}`;
    this.perEdge.set(ek, (this.perEdge.get(ek) ?? 0) + 1);
    this.perNode.set(node, (this.perNode.get(node) ?? 0) + 1);

    // 震荡识别：最近 3 次回退的边形成 A→B→A 模式
    this.events.push({ at: now, edge: ek, node, reason, trigger });
    const recent = this.events.slice(-4).map((e) => e.edge.split(">")[1]);
    if (recent.length >= 3 && recent[0] === recent[2] && recent[1] !== recent[0] && recent[1] === recent[3]) {
      const key = recent.join("→");
      this.oscillations.set(key, (this.oscillations.get(key) ?? 0) + 1);
    }

    // 升级判定（含单边/单节点预算超限，方案 11.2）
    let escalated = false;
    let reasonMsg = null;
    if (this.usedBudget >= this.totalBudget) { escalated = true; reasonMsg = `全局回退预算达上限(${this.usedBudget}/${this.totalBudget})，强制人工裁决`; }
    else if (this.windowUsed >= this.escalationThreshold) { escalated = true; reasonMsg = `滑动窗口回退超阈值(${this.windowUsed}/${this.escalationThreshold})，升级人工裁决`; }
    else if ((this.perEdge.get(ek) ?? 0) >= this.perEdgeBudget) { escalated = true; reasonMsg = `回退边 ${ek} 超单边预算(${this.perEdge.get(ek)}/${this.perEdgeBudget})，升级人工裁决`; }
    else if ((this.perNode.get(node) ?? 0) >= this.perNodeBudget) { escalated = true; reasonMsg = `节点 ${node} 回退超单节点预算(${this.perNode.get(node)}/${this.perNodeBudget})，升级人工裁决`; }
    else if (this.oscillations.size > 0) { escalated = true; reasonMsg = `检测到跨节点震荡：${[...this.oscillations.keys()].join(", ")}，升级人工裁决`; }
    if (escalated && !this.escalated) {
      this.escalated = true;
      this.escalationReason = reasonMsg;
    }
    return { usedBudget: this.usedBudget, windowUsed: this.windowUsed, escalated, reason: reasonMsg };
  }

  /** 回退触发后：版本递增 + 下游 stale 标记（缓存失效依据）。 */
  bumpVersion(versions, nodes) {
    const next = { ...(versions ?? {}) };
    for (const n of nodes ?? []) next[n] = (Number(next[n] ?? 0)) + 1;
    next.global = (Number(next.global ?? 0)) + 1;
    return next;
  }

  /** 标记下游 stale（回退的上游产出已失效）。 */
  markStale(depGraph, reworkNode) {
    const stale = [];
    const stack = [...(depGraph[reworkNode] ?? [])];
    while (stack.length) {
      const n = stack.shift();
      if (!stale.includes(n)) { stale.push(n); stack.push(...(depGraph[n] ?? [])); }
    }
    return stale;
  }

  snapshot() {
    return {
      totalBudget: this.totalBudget, usedBudget: this.usedBudget,
      windowSize: this.windowSize, windowUsed: this.windowUsed,
      escalationThreshold: this.escalationThreshold,
      escalated: this.escalated, escalationReason: this.escalationReason,
      perEdge: Object.fromEntries(this.perEdge), perNode: Object.fromEntries(this.perNode),
      perEdgeBudget: this.perEdgeBudget, perNodeBudget: this.perNodeBudget,
      oscillations: Object.fromEntries(this.oscillations),
      eventCount: this.events.length,
    };
  }
}
