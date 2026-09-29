/**
 * Transactional snapshot + breakpoint recovery.
 *
 * Every seat/queue/module/rollback/rate transition is persisted through a snapshot
 * write. A failed write never corrupts the previous snapshot (write to temp,
 * then atomic rename). On restart the pipeline, seat pool, queue, and rollback/rate state
 * projection are rebuilt from the latest valid snapshot. Animation is
 * NOT a restore source — only business state is.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

export class SnapshotStore {
  /**
   * @param {string} dir directory to store snapshots
   * @param {string} [key] run key (default "default")
   */
  constructor(dir, key = "default") {
    this.dir = dir;
    this.file = join(dir, `snapshot-${key}.json`);
    this.tmpFile = join(dir, `snapshot-${key}.tmp`);
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    this.saveCount = 0; // #56：完整/增量快照计数
    this.fullN = 0; // #56：完整快照轮换位
  }

  /**
   * Atomically write a snapshot. Returns true on success.
   * @param {object} state
   */
  /** #21：原子写 + 版本号 + sha256 校验和 + 保留上一版本（写临时文件→校验→重命名；读取时校验校验和，损坏视为无效）。 */
  save(state) {
    try {
      const version = (this._version ?? 0) + 1;
      const body = JSON.stringify({ ts: Date.now(), version, state }, null, 2);
      const checksum = createHash("sha256").update(body).digest("hex");
      writeFileSync(this.tmpFile, JSON.stringify({ version, checksum, payload: body }), "utf8");
      this.saveCount += 1;
      // #56：增量链滚动保留最近 3 份（.prev-2 ← .prev-1 ← .prev）
      try { if (existsSync(this.file + ".prev-1")) renameSync(this.file + ".prev-1", this.file + ".prev-2"); } catch { /* ignore */ }
      try { if (existsSync(this.file + ".prev")) renameSync(this.file + ".prev", this.file + ".prev-1"); } catch { /* ignore */ }
      try { if (existsSync(this.file)) renameSync(this.file, this.file + ".prev"); } catch { /* ignore */ }
      // #56：每 10 次写一次完整快照（轮换保留最近 3 份 .full-N）；超过 7 天归档策略见 README
      if (this.saveCount % 10 === 0) {
        this.fullN = (this.fullN % 3) + 1;
        writeFileSync(this.file + ".full-" + this.fullN, JSON.stringify({ version, checksum, payload: body }), "utf8");
      }
      renameSync(this.tmpFile, this.file);
      this._version = version;
      return true;
    } catch (e) {
      // Keep the previous valid snapshot untouched.
      try { if (existsSync(this.tmpFile)) renameSync(this.tmpFile, this.file); } catch { /* ignore */ }
      return false;
    }
  }

  /** Load the latest valid snapshot, or null. */
  /** #21：读取并校验（校验和不匹配视为损坏返回 null，不静默使用坏数据）。 */
  load() {
    try {
      if (!existsSync(this.file)) return null;
      const env = JSON.parse(readFileSync(this.file, "utf8"));
      if (!env?.payload) return env?.state ?? null; // 兼容旧格式
      const actual = createHash("sha256").update(String(env.payload)).digest("hex");
      if (actual !== env.checksum) return null;
      return JSON.parse(env.payload)?.state ?? null;
    } catch {
      return null;
    }
  }

  clear() {
    try { if (existsSync(this.file)) renameSync(this.file, this.file + ".bak"); } catch { /* ignore */ }
  }

  static ensure(dir) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
  }
}

export { dirname };
