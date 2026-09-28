/**
 * Global model-request token bucket + HTTP 429 state machine (V9.3).
 * 429 来自模型 API 侧限流（RPS/RPM/Token 速率/配额/突发），与并发无必然关系，
 * 但并发会提高风险。此处以令牌桶限制全局 RPS/RPM，并用状态机处置 429：
 *   NORMAL → BACKOFF(指数退避) → FROZEN_NEW(冻结新任务) → GLOBAL_PAUSE(并发降到2/1、看门狗不调模型)
 *   → RECOVER(从快照重建队列，渐进恢复)。
 * 并发自动降级：429 频率超阈值时 5→3→2/1；恢复时渐进，不瞬时跳回。
 */
export const RATE_STATES = { NORMAL: "NORMAL", BACKOFF: "BACKOFF", FROZEN_NEW: "FROZEN_NEW", GLOBAL_PAUSE: "GLOBAL_PAUSE", RECOVER: "RECOVER" };

export class TokenBucket {
  constructor(rps = 8, burst = 16) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.rate = Math.max(0.1, rps); // tokens per second
    this.last = Date.now();
  }
  _refill(now) {
    const dt = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.rate);
    this.last = now;
  }
  take(n = 1) {
    const now = Date.now();
    this._refill(now);
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

export class RateLimiter {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.bucket = new TokenBucket(Number(cfg.rps ?? 8), Number(cfg.burst ?? 16));
    this.minute = { window: Date.now(), used: 0, limit: Number(cfg.rpm ?? 240) };
    this.state = RATE_STATES.NORMAL;
    this.concurrency = Number(cfg.maxConcurrent ?? 5);   // 当前并发（含降级）
    this.stateSince = Date.now();
    this.stateLog = [];
    this._429Count = 0;
    this._429WindowStart = Date.now();
  }

  /** 请求前门控：全局暂停/冻结新任务时拒绝调度。 */
  allowNewTask() {
    if (this.state === RATE_STATES.GLOBAL_PAUSE) return false;
    if (this.state === RATE_STATES.FROZEN_NEW) return false;
    return true;
  }

  /** 尝试取令牌（模型请求前调用）。返回是否放行。 */
  tryAcquire() {
    const now = Date.now();
    if (now - this.minute.window > 60000) { this.minute.window = now; this.minute.used = 0; }
    if (this.minute.used >= this.minute.limit) return false;
    if (!this.bucket.take(1)) return false;
    this.minute.used += 1;
    return true;
  }

  _setState(s, reason) {
    if (this.state === s) return;
    this.state = s;
    this.stateSince = Date.now();
    this.stateLog.push({ at: this.stateSince, state: s, reason });
    console.log(`[dsh-leng-team] 429 状态机 → ${s}（${reason}）并发=${this.concurrency}`);
  }

  /** 记录一次 429 响应并驱动状态机 + 并发自动降级。 */
  record429() {
    const now = Date.now();
    if (now - this._429WindowStart > 60000) { this._429WindowStart = now; this._429Count = 0; }
    this._429Count += 1;
    if (this._429Count >= 6) { this._setState(RATE_STATES.GLOBAL_PAUSE, "60s 内 429 高频，全局暂停并快照"); return; }
    if (this._429Count >= 3) { this._setState(RATE_STATES.FROZEN_NEW, "持续限流，冻结新任务"); this._degrade(); return; }
    this._setState(RATE_STATES.BACKOFF, "瞬时抖动，指数退避");
  }

  /** 记录一次成功请求：推动状态恢复。 */
  recordSuccess() {
    if (this.state === RATE_STATES.GLOBAL_PAUSE || this.state === RATE_STATES.FROZEN_NEW) {
      this._setState(RATE_STATES.RECOVER, "限流缓解，进入恢复");
      this._recover();
    } else if (this.state === RATE_STATES.BACKOFF) {
      this._setState(RATE_STATES.NORMAL, "瞬时抖动结束");
    }
  }

  /** 并发自动降级：5→3→2/1。 */
  _degrade() {
    const target = this.concurrency > 3 ? 3 : this.concurrency > 2 ? 2 : 1;
    this.concurrency = target;
  }
  /** 渐进恢复：不瞬时跳回 5。 */
  _recover() {
    if (this.concurrency < this.cfg.maxConcurrent) this.concurrency = Math.min(this.concurrency + 1, Number(this.cfg.maxConcurrent ?? 5));
  }

  backoffMs() {
    const base = Number(this.cfg.backoffMs ?? 3000);
    if (this.state === RATE_STATES.GLOBAL_PAUSE) return base * 8;
    if (this.state === RATE_STATES.FROZEN_NEW) return base * 4;
    if (this.state === RATE_STATES.BACKOFF) return base * 2;
    return base;
  }

  snapshot() {
    return {
      state: this.state, concurrency: this.concurrency,
      tokens: Math.round(this.bucket.tokens),
      minuteUsed: this.minute.used, minuteLimit: this.minute.limit,
      _429Count: this._429Count,
      stateSince: this.stateSince,
    };
  }
}
