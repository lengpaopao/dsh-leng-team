/**
 * Observability panel — aggregates DAG state, queue, seats, token, watchdog,
 * anomaly history, rework counts, handover records. Supports JSON export.
 */

export class Observability {
  constructor(config = {}) {
    this.config = config;
    this.log = [];           // general event log
    this.anomalies = [];     // 429 / dead_loop / zombie / crash / rework
    this.reworkByModule = new Map(); // module -> rework count
    this.tokenByRole = new Map();    // role -> tokens
    this.tokenByModule = new Map();  // module -> tokens
    this.handovers = [];     // {from,to,module?,ts}
    this.cacheEvents = [];   // {ts, role, module, hit, key}
    this.snapshotVersion = 0; // #50：快照版本（面板以快照为唯一真相源）
    this.reasons = [];        // #51：状态变更原因（为什么维度：回退/启用/风险接受/缓存失效）
    this.startedAt = Date.now();
  }

  record(level, type, message, meta = {}) {
    this.log.push({ ts: Date.now(), level, type, message, ...meta });
    if (this.log.length > 1000) this.log.shift();
  }

  recordAnomaly(type, detail) {
    this.anomalies.push({ ts: Date.now(), type, detail });
    if (this.anomalies.length > 500) this.anomalies.shift();
    this.record("error", type, detail);
  }

  recordRework(module) {
    const key = module ?? "(unknown)";
    this.reworkByModule.set(key, (this.reworkByModule.get(key) ?? 0) + 1);
  }

  recordToken(role, tokens) {
    this.tokenByRole.set(role, (this.tokenByRole.get(role) ?? 0) + (tokens ?? 0));
  }

  recordTokenModule(module, tokens) {
    this.tokenByModule.set(module, (this.tokenByModule.get(module) ?? 0) + (tokens ?? 0));
  }

  recordHandover(from, to, module = null) {
    this.handovers.push({ ts: Date.now(), from, to, module });
    if (this.handovers.length > 1000) this.handovers.shift();
  }

  /** #51：记录状态变更原因（为什么维度）。 */
  recordWhy(target, reason, refIssue = null) {
    this.reasons.push({ ts: Date.now(), target: String(target ?? "").slice(0, 120), reason: String(reason ?? "").slice(0, 300), refIssue: refIssue ?? null });
    if (this.reasons.length > 500) this.reasons.shift();
  }

  /** #52：预测维度（基于历史与当前状态，标注置信度，不作为决策唯一依据）。 */
  predictions() {
    const secs = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const totalTokens = [...this.tokenByRole.values()].reduce((a, b) => a + (b ?? 0), 0);
    const tokenRate = Math.round(totalTokens / secs);
    const totalRework = this.reworkByModule.size ? [...this.reworkByModule.values()].reduce((a, b) => a + b, 0) : 0;
    const reworkRate = totalRework / secs;
    const anomalyCount = this.anomalies.length;
    const confidence = anomalyCount === 0 && totalTokens > 0 ? "high" : (anomalyCount <= 2 ? "medium" : "low");
    // 基于 token 速率与已用 token 的简单线性外推（不作为决策唯一依据）
    const estimatedRemaining = totalTokens > 0 ? Math.round(tokenRate * 600) : null; // 假设剩余 10 分钟
    return {
      tokenRate,
      reworkRate,
      estimatedRemaining,
      confidence,
      anomalyCount,
      totalTokens,
    };
  }

  /** 缓存命中/失效记录（方案 12.2：命中记录版本组合，失效记录原因）。 */
  recordCache(role, module, hit, key, note = "") {
    this.cacheEvents.push({ ts: Date.now(), role, module, hit: !!hit, key: String(key ?? "").slice(0, 200), note: String(note ?? "").slice(0, 200) });
    if (this.cacheEvents.length > 500) this.cacheEvents.shift();
    this.record(hit ? "info" : "warning", hit ? "cache_hit" : "cache_miss", `${role}/${module} ${hit ? "命中" : "失效"}${note ? "：" + note : ""}`);
  }

  /** Build a full panel payload. */
  snapshot() {
    this.snapshotVersion += 1; // #50：每次读取递增快照版本（面板读取版本号，写入期间读旧版本）
    return {
      enabled: this.config.enabled ?? true,
      panelEnabled: this.config.panelEnabled ?? true,
      version: this.snapshotVersion,
      startedAt: this.startedAt,
      reasons: this.reasons.slice(-100),
      predictions: this.predictions(),
      show: this.config.show ?? [],
      log: this.log.slice(-200),
      anomalies: this.anomalies.slice(-100),
      rework: Object.fromEntries(this.reworkByModule),
      tokenByRole: Object.fromEntries(this.tokenByRole),
      tokenByModule: Object.fromEntries(this.tokenByModule),
      handovers: this.handovers.slice(-200),
      cacheEvents: this.cacheEvents.slice(-100),
    };
  }

  exportJson() {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  exportMarkdown() {
    const s = this.snapshot();
    const lines = [];
    lines.push("# dsh-leng-team 可观测性报告");
    lines.push(`- 启动时间：${new Date(s.startedAt).toISOString()}`);
    lines.push("## 异常历史");
    for (const a of s.anomalies) lines.push(`- ${new Date(a.ts).toISOString()} [${a.type}] ${a.detail}`);
    lines.push("## 模块返工次数");
    for (const [k, v] of Object.entries(s.rework)) lines.push(`- ${k}: ${v}`);
    lines.push("## Token 消耗（按角色）");
    for (const [k, v] of Object.entries(s.tokenByRole)) lines.push(`- ${k}: ${v}`);
    lines.push("## 交接记录");
    for (const h of s.handovers) lines.push(`- ${new Date(h.ts).toISOString()} ${h.from} → ${h.to}${h.module ? ` (${h.module})` : ""}`);
    return lines.join("\n");
  }
}
