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
    this.tracked.set(id, {
      taskId: id,
      role: entry.role ?? "unknown",
      agent: entry.agent ?? null,
      recentOutputs: [],
      retries429: 0,
      lastActivity: Date.now(),
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
  recordOutput(taskId, output) {
    const e = this.tracked.get(taskId);
    if (!e) return;
    const norm = normalizeText(output);
    e.recentOutputs.push(norm);
    if (e.recentOutputs.length > this.repeatRounds + 2) {
      e.recentOutputs.shift();
    }
    e.lastActivity = Date.now();
    this._checkLoop(e);
  }

  recordActivity(taskId) {
    const e = this.tracked.get(taskId);
    if (!e) return;
    e.lastActivity = Date.now();
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

  _poll() {
    const now = Date.now();
    for (const [taskId, e] of this.tracked) {
      this._checkLoop(e);

      // Zombie: seat not released but agent idle/stopped beyond threshold
      if (!e.seatReleased && now - e.lastActivity > this.zombieIdleMs) {
        this._log("error", "zombie", `[${e.role}] 僵尸会话：超过 ${this.zombieIdleMs}ms 无活动且席位未释放`);
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
    const recent = outs.slice(-this.repeatRounds);
    // Pairwise semantic similarity across consecutive rounds
    let allSimilar = true;
    for (let i = 1; i < recent.length; i++) {
      if (similarity(recent[i - 1], recent[i]) < this.similarityThreshold) {
        allSimilar = false;
        break;
      }
    }
    if (!allSimilar) return;

    this._log("error", "dead_loop", `[${e.role}] 语义死循环：连续 ${this.repeatRounds} 轮输出高度相似且无进展`);
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
