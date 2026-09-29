/**
 * Transactional snapshot + breakpoint recovery.
 *
 * Every seat/queue/module/rollback/rate transition is persisted through a snapshot
 * write. A failed write never corrupts the previous snapshot (write to temp,
 * then atomic rename). On restart the pipeline, seat pool, queue, and rollback/rate state
 * projection are rebuilt from the latest valid snapshot. Animation is
 * NOT a restore source — only business state is.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, copyFileSync, unlinkSync } from "node:fs";
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
    this._version = 0;
    this.lastLoadedFrom = null; // 修复 R15：记录本次 load() 实际命中的层级（primary / .prev* / .full-N）
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
      // #56：每 10 次写一次完整快照（轮换保留最近 3 份 .full-N）；超过 7 天归档策略见 README。
      // 修复 R16：这一步挪到「轮换 / 覆盖主文件」之前。它是最容易抛错的一步
      //（实测：把 .full-1 造成目录即得 EISDIR）；原先排在 rename(主文件→.prev) 之后，
      // 于是一旦它失败，主文件已经不在原位，失败现场没有任何有效副本兜底。
      if (this.saveCount % 10 === 0) {
        this.fullN = (this.fullN % 3) + 1;
        writeFileSync(this.file + ".full-" + this.fullN, JSON.stringify({ version, checksum, payload: body }), "utf8");
      }
      // #56：增量链滚动保留最近 3 份（.prev-2 ← .prev-1 ← .prev）
      try { if (existsSync(this.file + ".prev-1")) renameSync(this.file + ".prev-1", this.file + ".prev-2"); } catch { /* ignore */ }
      try { if (existsSync(this.file + ".prev")) renameSync(this.file + ".prev", this.file + ".prev-1"); } catch { /* ignore */ }
      // 修复 R16：此处由「移走主文件」改为「复制主文件」。原实现把主文件 rename 成 .prev，
      // 于是在 renameSync(tmp → file) 之前存在一个「主文件根本不存在」的窗口；
      // 一旦此时抛错（或被进程中断），主文件就永久缺失，只能靠 .prev 兜底 —— 而 .prev
      // 可能尚未生成（首次写入）。复制则保证主文件全程存在且有效，最坏只是备份略旧。
      try { if (existsSync(this.file)) copyFileSync(this.file, this.file + ".prev"); } catch { /* ignore */ }
      renameSync(this.tmpFile, this.file);
      this._version = version;
      return true;
    } catch (e) {
      // 修复 R16：原实现此处执行 `renameSync(this.tmpFile, this.file)`，与紧邻注释
      //「Keep the previous valid snapshot untouched.」以及模块头「A failed write never
      // corrupts the previous snapshot」的承诺正好相反：当 writeFileSync(tmpFile) 只写了
      // 一半就失败（ENOSPC / 进程中断）时，这一行会把半截文件覆盖到主文件上，直接摧毁
      // 最后一份有效快照；实测亦确认「save() 返回 false，但 load() 已经是新版本」。
      // 正确做法：丢弃本次临时文件，主文件保持不动（配合 R15 的逐级回退更稳）。
      try { if (existsSync(this.tmpFile)) unlinkSync(this.tmpFile); } catch { /* ignore */ }
      return false;
    }
  }

  /** 读取并校验单个快照文件。不存在 / 解析失败 / 校验和不符（视为损坏）均返回 null。 */
  _readFile(f) {
    try {
      if (!existsSync(f)) return null;
      const env = JSON.parse(readFileSync(f, "utf8"));
      if (!env?.payload) return env?.state != null ? { state: env.state, version: 0 } : null; // 兼容旧格式
      const actual = createHash("sha256").update(String(env.payload)).digest("hex");
      if (actual !== env.checksum) return null; // 损坏：不静默使用坏数据
      const state = JSON.parse(env.payload)?.state ?? null;
      return state === null ? null : { state, version: Number(env.version ?? 0) };
    } catch {
      return null;
    }
  }

  /** Load the latest valid snapshot, or null. */
  /** #21：读取并校验（校验和不匹配视为损坏，不静默使用坏数据）。
   * 修复 R15：主文件损坏/缺失时，按 .prev → .prev-1 → .prev-2 → .full-N（取 version 最大者）
   * 逐级回退。原实现只读主文件，单点损坏即状态全失 —— 尽管磁盘上同时存有 5 份可用副本
   *（实测：20 次 save 后 .prev/.prev-1/.prev-2/.full-1/.full-2 全在，而主文件一坏 load() 就返回 null）。
   * 命中层级记录在 this.lastLoadedFrom，供上层判定是否发生了降级恢复。 */
  load() {
    const primary = this._readFile(this.file);
    if (primary) { this.lastLoadedFrom = "primary"; return primary.state; }
    for (const suf of [".prev", ".prev-1", ".prev-2"]) {
      const r = this._readFile(this.file + suf);
      if (r) { this.lastLoadedFrom = suf; return r.state; }
    }
    let best = null;
    for (const suf of [".full-1", ".full-2", ".full-3"]) {
      const r = this._readFile(this.file + suf);
      if (r && (!best || r.version > best.r.version)) best = { suf, r };
    }
    if (best) { this.lastLoadedFrom = best.suf; return best.r.state; }
    this.lastLoadedFrom = null;
    return null;
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
