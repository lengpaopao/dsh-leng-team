/**
 * LengTeam Watchdog — 4-minute global polling.
 *
 * Detects:
 *  1. Semantic dead-loop: N consecutive rounds of highly-similar output (no real
 *     progress), NOT a pure timeout — deep-reasoning tasks are not mis-killed.
 *  2. HTTP 429: distinguishes transient jitter (exponential backoff retry) from
 *     sustained rate-limiting (freeze new task admission to avoid a stampede).
 *  3. Zombie sessions: agent alive but task terminated / seat never released.
 *     Force-destroy and force-return the seat.
 *
 * Every anomaly → seat recovery + alert log + rate/rollback state.
 */

import { normalizeText, similarity } from "./similarity.js";

export const STATUS = {
  RUNNING: "running",
  QUEUED: "queued",
  BLOCKED: "blocked",
  FINISHED: "finished",
  ERROR: "error",
};

export class LengWatchdog {
  /**
   * @param {object} opts
   * @param {number} [opts.intervalMs] 240000 (4 min)
   * @param {number} [opts.similarityThreshold]
   * @param {number} [opts.repeatRounds]
   * @param {number} [opts.maxRetries429]
   * @param {number} [opts.backoffMs]
   * @param {boolean} [opts.freezeQueueOn429]
   * @param {number} [opts.zombieIdleMs]
   * @param {string} [opts.action] pause | rebuild | terminate
   */
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs ?? 240000;
    this.similarityThreshold = opts.similarityThreshold ?? 0.85;
    this.repeatRounds = opts.repeatRounds ?? 6;
    this.maxRetries429 = opts.maxRetries429 ?? 3;
    this.backoffMs = opts.backoffMs ?? 3000;
    this.freezeQueueOn429 = opts.freezeQueueOn429 ?? true;
    this.zombieIdleMs = opts.zombieIdleMs ?? 300000;
    this.action = opts.action ?? "pause";

    this.timer = null;
    this.running = false;
    this.frozen = false; // 429 冻结标志
    this.frozenUntil = 0;

    /** @type {Map<string, {taskId:string, role:string, agent:any, recentOutputs:string[], retries429:number, lastActivity:number, seatReleased:boolean, onAlert:Function, onRecoverSeat:Function, destroy:Function}>} */
    this.tracked = new Map();

    this.onAlert = null;      // (alert) => void
    this.log = [];            // 分级日志 [{ts, level, type, message}]
  }

  track(entry) {
    const id = entry.taskId ?? entry.agent?.id;
    if (!id) return;
    // 修复第九轮 N4：同一 taskId 重复 track 时保留既有输出窗口。
    // 原实现每次 track 都把 recentOutputs 重置为 []，而 `_runRole` 的每次重试都会
    // 以同一 taskId 重新 track → 窗口长度永远 ≤1，`_checkLoop`（要求窗口 ≥ repeatRounds）
    // 永远提前 return，语义死循环检测（dead_loop）是彻底的死代码。
    const prev = this.tracked.get(id);
    this.tracked.set(id, {
      taskId: id,
      role: entry.role ?? "unknown",
      agent: entry.agent ?? null,
      recentOutputs: Array.isArray(prev?.recentOutputs) ? prev.recentOutputs : [],
      retries429: 0,
      lastActivity: Date.now(),
      lastHeartbeat: Date.now(), // #55：长任务心跳（默认 2 分钟一次）
      lastArtifact: 0,           // #55：最近产物更新时间
      lastOutputAt: Date.now(),  // 修复 F9：最近一次输出的时间（原实现用 recentOutputs 是否为空判定，导致“曾经输出过”即永久不算僵尸）
      probeSentAt: 0,            // #55：存活探测发送时间
      seatReleased: false,
      onAlert: entry.onAlert ?? null,
      onRecoverSeat: entry.onRecoverSeat ?? null,
      destroy: entry.destroy ?? (() => {}),
    });
  }

  untrack(taskId) {
    this.tracked.delete(taskId);
  }

  /**
   * Record a round of output for semantic dead-loop detection.
   * @param {string} taskId
   * @param {string} output
   */
  /**
   * 修复 R9：所有「任务仍有生命迹象」的上报都必须清掉存活探测标记。
   * 原实现只在 `_isZombie` 里置位 `probeSentAt`、永不归零，于是第二次静默期
   * 会在**第一轮**轮询就直接判僵尸（`now - probeSentAt` 早已远超一个周期），
   * 完全跳过「先发探测再等一周期」的等待 —— 实测：心跳恢复后再次静默仅 400s 即被强杀。
   */
  _clearProbe(e) { if (e) e.probeSentAt = 0; }

  recordOutput(taskId, output) {
    const e = this.tracked.get(taskId);
    if (!e) return;
    const norm = normalizeText(output);
    e.recentOutputs.push(norm);
    if (e.recentOutputs.length > this.repeatRounds + 2) {
      e.recentOutputs.shift();
    }
    e.lastActivity = Date.now();
    e.lastOutputAt = Date.now(); // 修复 F9：输出新鲜度以时间戳为准
    this._clearProbe(e);         // 修复 R9：有输出 = 探测已被应答
    this._checkLoop(e);
  }

  /** 任意活动上报（含 record429 这类非心跳活动）：刷新 lastActivity 并应答存活探测。 */
  recordActivity(taskId) {
    const e = this.tracked.get(taskId);
    if (!e) return;
    e.lastActivity = Date.now();
    this._clearProbe(e); // 修复 R9/R10：lastActivity 现已是僵尸判定的有效生命信号
  }

  /** #55：长任务心跳上报（默认每 2 分钟一次，优先于 lastActivity 判定）。 */
  heartbeat(taskId) {
    const e = this.tracked.get(taskId);
    if (!e) return;
    e.lastHeartbeat = Date.now();
    e.lastActivity = Date.now();
    this._clearProbe(e); // 修复 R9
  }

  /** #55：产物更新上报（写入/产出变化时调用）。 */
  recordArtifact(taskId) {
    const e = this.tracked.get(taskId);
    if (!e) return;
    e.lastArtifact = Date.now();
    e.lastActivity = Date.now();
    this._clearProbe(e); // 修复 R9
  }

  /** Record an HTTP 429 / request-error event. */
  record429(taskId, error) {
    const e = this.tracked.get(taskId);
    if (!e) return;
    e.retries429 += 1;
    e.lastActivity = Date.now();
    const msg = `[${e.role}] HTTP 429 (rate limited) — attempt ${e.retries429}/${this.maxRetries429}`;
    this._log("warning", "429", msg);
    if (e.retries429 >= this.maxRetries429 && this.freezeQueueOn429) {
      this._freeze();
    }
    this._alert(taskId, { type: "429", level: "warning", message: msg });
  }

  /**
   * Start the polling loop.
   * @param {(taskId:string)=>void} onZombieRecover called when a zombie seat must be returned
   */
  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this._poll(); } catch (e) { /* keep ticking */ }
      this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  clear() {
    this.stop();
    this.tracked.clear();
    this.log = [];
    this.frozen = false;
  }

  isFrozen() {
    if (this.frozen && Date.now() < this.frozenUntil) return true;
    if (this.frozen && Date.now() >= this.frozenUntil) { this.frozen = false; return false; }
    return false;
  }

  // ---- internals ----

  _freeze() {
    this.frozen = true;
    this.frozenUntil = Date.now() + this.backoffMs * 5;
    this._log("error", "429_frozen", "持续限流：冻结新任务入队，等待退避恢复");
  }

  /** #55：僵尸判定（心跳/产物/输出新鲜度 + 存活探测），判定前先发存活探测等待至少一周期。
   * 修复 F7/F9：
   *  - idle 阈值改为读取 `this.zombieIdleMs`（此前该配置在设置页可调却从未被读取，
   *    实际用的是 `intervalMs * 2`，导致旋钮零效果）；
   *  - 「无输出」改为按**新鲜度**判定（`lastOutputAt`），此前用 `recentOutputs.length === 0`，
   *    而 recentOutputs 仅在死循环告警时清空，故任务一旦产出过任何输出就永远不再被判僵尸；
   *  - 存活性语义明确为 OR：任一活动信号新鲜即视为存活；全部信号超时才是僵尸候选。 */
  _isZombie(e, now) {
    const idleMs = Math.max(60000, Number(this.zombieIdleMs) || 300000);
    const noHeartbeat = now - (e.lastHeartbeat ?? 0) > idleMs;
    const noArtifact = now - (e.lastArtifact ?? 0) > idleMs;
    const noOutput = now - (e.lastOutputAt ?? 0) > idleMs;
    // 修复 R10：把 lastActivity 纳入第 4 个生命信号。`record429()` 只更新 lastActivity
    // （反复重试限流本身就是在活动），而原判定体从不读该字段，导致「仅因 429 重试而
    // 持续活动」的任务被误判僵尸（实测该字段全文件 8 次赋值、判定体内 0 次读取）。
    const noActivity = now - (e.lastActivity ?? 0) > idleMs;
    // 任一活动信号新鲜 → 排除僵尸（OR 逻辑）
    if (!noHeartbeat || !noArtifact || !noOutput || !noActivity) return false;
    if (!e.probeSentAt) { e.probeSentAt = now; this._log("info", "zombie_probe", `[${e.role}] 触发存活探测，等待响应`); return false; }
    return now - e.probeSentAt > Math.max(60000, this.intervalMs / 2);
  }

  _poll() {
    const now = Date.now();
    for (const [taskId, e] of this.tracked) {
      this._checkLoop(e);

      // #55：僵尸判定四条件——超过 2 个看门狗周期无心跳、无产物更新、无日志输出、存活探测无响应；判定前先发存活探测等待一周期
      if (!e.seatReleased && this._isZombie(e, now)) {
        this._log("error", "zombie", `[${e.role}] 僵尸会话：超 2 周期无心跳 + 无产物更新 + 无日志输出 + 存活探测无响应，强制回收席位`);
        this._alert(taskId, { type: "zombie", level: "error", message: `[${e.role}] 僵尸会话，强制回收席位` });
        e.seatReleased = true;
        try { e.destroy(); } catch (err) { /* ignore */ }
        if (e.onRecoverSeat) e.onRecoverSeat(taskId);
      }
    }
  }

  _checkLoop(e) {
    const outs = e.recentOutputs;
    if (outs.length < this.repeatRounds) return;
    // 修复：滑动窗口检测——取最近 repeatRounds 轮输出，检查整体相似度
    // 而非逐对比较（逐对可能漏掉振荡模式：A→B→A→B 逐对都不同但整体在循环）
    const window = outs.slice(-this.repeatRounds);
    // 计算窗口内所有输出的平均相似度（与窗口中心比较）
    const mid = window[Math.floor(window.length / 2)] ?? window[0];
    let similarCount = 0;
    for (const out of window) {
      if (similarity(out, mid) >= this.similarityThreshold) similarCount++;
    }
    // 窗口内 80% 以上输出与中心相似 → 判定死循环
    if (similarCount / window.length < 0.8) return;

    this._log("error", "dead_loop", `[${e.role}] 语义死循环：连续 ${this.repeatRounds} 轮输出高度相似且无进展（滑动窗口检测）`);
    this._alert(e.taskId, {
      type: "dead_loop",
      level: "error",
      message: `[${e.role}] 语义死循环，按策略「${this.action}」处置`,
      action: this.action,
    });
    // reset to avoid repeated alerts
    e.recentOutputs = [];
  }

  _alert(taskId, alert) {
    if (this.onAlert) this.onAlert(taskId, alert);
    const e = this.tracked.get(taskId);
    if (e?.onAlert) e.onAlert(alert);
  }

  _log(level, type, message) {
    this.log.push({ ts: Date.now(), level, type, message });
    if (this.log.length > 500) this.log.shift();
  }

  /** Return a snapshot of watchdog state (for observability). */
  snapshot() {
    return {
      running: this.running,
      frozen: this.isFrozen(),
      intervalMs: this.intervalMs,
      tracked: [...this.tracked.entries()].map(([id, e]) => ({
        taskId: id, role: e.role, retries429: e.retries429, seatReleased: e.seatReleased,
      })),
      log: this.log.slice(-100),
    };
  }
}
