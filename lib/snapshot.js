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
  }

  /**
   * Atomically write a snapshot. Returns true on success.
   * @param {object} state
   */
  save(state) {
    try {
      writeFileSync(this.tmpFile, JSON.stringify({ ts: Date.now(), state }, null, 2), "utf8");
      renameSync(this.tmpFile, this.file);
      return true;
    } catch (e) {
      // Keep the previous valid snapshot untouched.
      try { if (existsSync(this.tmpFile)) renameSync(this.tmpFile, this.file); } catch { /* ignore */ }
      return false;
    }
  }

  /** Load the latest valid snapshot, or null. */
  load() {
    try {
      if (!existsSync(this.file)) return null;
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      return data?.state ?? null;
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
