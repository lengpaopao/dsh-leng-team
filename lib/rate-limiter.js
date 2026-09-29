/**
 * Global model-request token bucket + HTTP 429 state machine (V9.3).
 * 429 来自模型 API 侧限流（RPS/RPM/Token 速率/配额/突发），与并发无必然关系，
 * 但并发会提高风险。此处以令牌桶限制全局 RPS/RPM，并用状态机处置 429：
 *   NORMAL → BACKOFF(指数退避) → FROZEN_NEW(冻结新任务) → GLOBAL_PAUSE(并发降到2/1、看门狗不调模型)
 *   → RECOVER(从快照重建队列，渐进恢复)。
 * 并发自动降级：429 频率超阈值时 5→3→2/1；恢复时渐进，不瞬时跳回。
 */
export const RATE_STATES = { NORMAL: "NORMAL", BACKOFF: "BACKOFF", FROZEN_NEW: "FROZEN_NEW", GLOBAL_PAUSE: "GLOBAL_PAUSE", RECOVER: "RECOVER" };

/**
 * #17：状态机与并发降级显式映射（修复"状态与并发映射未定义"）：
 *  NORMAL=满额 · BACKOFF=满额但冻结新任务 · FROZEN_NEW=降为 3 · GLOBAL_PAUSE=新任务为零（并发 1）
 *  RECOVER=由 _recover 从 1 渐进回升（不瞬时跳回满额）。
 */
export function concurrencyForState(state, max) {
  const cap = Math.max(1, Number(max) || 5);
  switch (state) {
    case RATE_STATES.NORMAL:
    case RATE_STATES.BACKOFF: return cap;
    case RATE_STATES.FROZEN_NEW: return Math.min(3, cap);
    case RATE_STATES.GLOBAL_PAUSE: return 1;
    case RATE_STATES.RECOVER: return null; // 渐进，由 _recover 决定
    default: return cap;
  }
}

export class TokenBucket {
  constructor(rps = 8, burst = 100) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.rate = Math.max(0.1, rps); // tokens per second
    this._baseRate = this.rate;
    this.last = Date.now();
  }
  /** #58：按比例降低补充速率（429 时降半；全局暂停降为 0）。 */
  degrade(ratio) {
    this.rate = Math.max(0, Number(ratio) ?? 0) * this._baseRate;
  }
  /** #58：恢复期渐进回升补充速率（不瞬时跳回）。 */
  restore() {
    this.rate = Math.min(this._baseRate, this.rate + this._baseRate / 10);
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
    this.bucket = new TokenBucket(Number(cfg.rps ?? 8), Number(cfg.burst ?? 100));
    this.minute = { window: Date.now(), used: 0, limit: Number(cfg.rpm ?? 240) };
    this.state = RATE_STATES.NORMAL;
    this.concurrency = Number(cfg.maxConcurrent ?? 5);   // 当前并发（含降级）
    this.stateSince = Date.now();
    this.stateLog = [];
    this._429Count = 0;
    this._429WindowStart = Date.now();
  }

  /** 请求前门控：全局暂停/冻结新任务时拒绝调度（#17：BACKOFF 满额但暂停新任务）。 */
  allowNewTask() {
    if (this.state === RATE_STATES.GLOBAL_PAUSE) return false;
    if (this.state === RATE_STATES.FROZEN_NEW) return false;
    if (this.state === RATE_STATES.BACKOFF) return false;
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
    if (this._429Count >= 6) { this._setState(RATE_STATES.GLOBAL_PAUSE, "60s 内 429 高频，全局暂停并快照"); this.bucket.degrade(0); this._applyStateConcurrency(); return; }
    if (this._429Count >= 3) { this._setState(RATE_STATES.FROZEN_NEW, "持续限流，冻结新任务"); this.bucket.degrade(0.5); this._applyStateConcurrency(); return; }
    this._setState(RATE_STATES.BACKOFF, "瞬时抖动，指数退避"); this.bucket.degrade(0.5); this._applyStateConcurrency();
  }

  /** 记录一次成功请求：推动状态恢复。 */
  recordSuccess() {
    if (this.state === RATE_STATES.GLOBAL_PAUSE || this.state === RATE_STATES.FROZEN_NEW) {
      this.concurrency = 1; // 从 1 开始渐进（#17：不允许瞬时跳回满额）
      this._setState(RATE_STATES.RECOVER, "限流缓解，进入恢复");
      this.bucket.restore();
      this._recover();
    } else if (this.state === RATE_STATES.RECOVER) {
      this.bucket.restore(); // #58：恢复期渐进回升速率
      this._recover(); // #17：恢复期持续渐进回升，不瞬时跳回满额
    } else if (this.state === RATE_STATES.BACKOFF) {
      this._setState(RATE_STATES.NORMAL, "瞬时抖动结束");
      this._applyStateConcurrency();
    }
  }

  /** #17：按状态显式设定并发（NORMAL/BACKOFF=满额，FROZEN_NEW=3，GLOBAL_PAUSE=1）。 */
  _applyStateConcurrency() {
    const target = concurrencyForState(this.state, this.cfg.maxConcurrent);
    if (target !== null && target !== undefined) this.concurrency = target;
  }
  /** 渐进恢复：从 1 逐步回升，不瞬时跳回满额。 */
  _recover() {
    if (this.state === RATE_STATES.RECOVER) {
      if (this.concurrency < 2) this.concurrency = 2;
      else if (this.concurrency < Number(this.cfg.maxConcurrent ?? 5)) this.concurrency += 1;
    }
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
      concurrencyTarget: concurrencyForState(this.state, this.cfg.maxConcurrent),
    };
  }
}
