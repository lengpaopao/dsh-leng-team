#!/usr/bin/env node
/**
 * bump-version.mjs — 版本号单一真相源（SSOT）。
 *
 * 问题：此前版本号散落在三处，手动修改极易漂移：
 *   1. package.json "release"  字段（显示版本，如 V26.10.1）
 *   2. package.json "version"  字段（semver，如 26.0.1）
 *   3. git commit 消息         （手写，容易与上面不一致）
 *
 * 方案：以 "release" 为唯一权威版本号，version 由 release 自动派生，
 *       commit 消息由脚本生成。只需调用一次，三处永远一致。
 *
 * 用法：
 *   node scripts/bump-version.mjs V26.10.2              # 指定新版本
 *   node scripts/bump-version.mjs --patch                # 自动 patch +1
 *   node scripts/bump-version.mjs V26.10.2 --push        # 提交后推送
 *   node scripts/bump-version.mjs V26.10.2 --push --release  # 推送 + 创建 GitHub Release
 *
 * 版本号格式：V + YYYYMMDD + NN  或  V + YY.MM.Patch
 *   兼容两种命名风格，以 V 开头。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = path.join(ROOT, "package.json");

// ── 参数解析 ──────────────────────────────────────────────
const args = process.argv.slice(2);
let newVersion = null;
let doPush = false;
let doRelease = false;

for (const a of args) {
  if (a === "--push") doPush = true;
  else if (a === "--release") doRelease = true;
  else if (a === "--patch") newVersion = "AUTO_PATCH";
  else if (a.startsWith("V") || /^\d/.test(a)) newVersion = a;
}

if (!newVersion) {
  console.error("用法: node scripts/bump-version.mjs <新版本号|--patch> [--push] [--release]");
  console.error("示例: node scripts/bump-version.mjs V26.10.2 --push --release");
  process.exit(1);
}

// ── 读取当前 package.json ──────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
const currentRelease = pkg.release || "V00000000";
const currentVersion = pkg.version || "0.0.0";

console.log(`[bump-version] 当前 release=${currentRelease}  version=${currentVersion}`);

// ── 解析新版本号 ──────────────────────────────────────────
function parseRelease(rel) {
  // 支持 VYYYYMMDDNN 和 VYY.MM.Patch 两种格式
  const m1 = rel.match(/^V(\d{8})(\d{2})$/);
  if (m1) return { style: "date", yyyymmdd: m1[1], seq: parseInt(m1[2], 10) };
  const m2 = rel.match(/^V(\d{2})\.(\d{1,2})\.(\d+)$/);
  if (m2) return { style: "semver", yy: m1[1], mm: m2[2], patch: parseInt(m2[3], 10) };
  return null;
}

function deriveVersion(release) {
  const p = parseRelease(release);
  if (!p) return release; // 无法解析则原样返回
  if (p.style === "date") {
    // VYYYYMMDDNN → YYYY.M.NN（年.月.序号）
    const yyyy = p.yyyymmdd.slice(0, 4);
    const mm = p.yyyymmdd.slice(4, 6);
    return `${yyyy}.${parseInt(mm, 10)}.${p.seq}`;
  }
  // VYY.MM.Patch → YY.MM.Patch
  return `${p.yy}.${p.mm}.${p.patch}`;
}

let finalRelease;
if (newVersion === "AUTO_PATCH") {
  const p = parseRelease(currentRelease);
  if (!p) {
    console.error("[bump-version] 无法解析当前 release 格式，无法自动 patch");
    process.exit(1);
  }
  if (p.style === "date") {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const seq = p.yyyymmdd === today ? p.seq + 1 : 1;
    finalRelease = `V${today}${String(seq).padStart(2, "0")}`;
  } else {
    finalRelease = `V${p.yy}.${p.mm}.${p.patch + 1}`;
  }
} else {
  // 确保以 V 开头
  finalRelease = newVersion.startsWith("V") ? newVersion : `V${newVersion}`;
}

const finalVersion = deriveVersion(finalRelease);

console.log(`[bump-version] 新 release=${finalRelease}  新 version=${finalVersion}`);

// ── 更新 package.json ─────────────────────────────────────
pkg.release = finalRelease;
pkg.version = finalVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("[bump-version] package.json 已更新");

// ── 生成 commit 消息（第三处：自动对齐） ──────────────────
// 从新 release 提取描述部分（用户可在提交后手动编辑，但版本号不会错）
const commitMsg = `${finalRelease}: 版本更新 ${currentRelease} → ${finalRelease}`;

// ── 提交 ──────────────────────────────────────────────────
console.log(`\n[bump-version] 提交: ${commitMsg}`);
execFileSync("git", ["add", "package.json"], { cwd: ROOT, stdio: "inherit" });

// 检查是否有其他未提交变更
const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
if (status) {
  console.log("[bump-version] 检测到其他未提交变更，一并提交:");
  console.log(status.split("\n").map((l) => `  ${l}`).join("\n"));
  execFileSync("git", ["add", "-A"], { cwd: ROOT, stdio: "inherit" });
}

execFileSync("git", ["commit", "-m", commitMsg], { cwd: ROOT, stdio: "inherit" });
console.log("[bump-version] 提交完成");

// ── 推送 ──────────────────────────────────────────────────
if (doPush) {
  console.log("\n[bump-version] 推送至 GitHub...");
  try {
    execFileSync("git", ["push", "origin", "master"], { cwd: ROOT, stdio: "inherit" });
    console.log("[bump-version] 推送成功");
  } catch (e) {
    console.error("[bump-version] 推送失败（可能是网络问题），代码已本地提交");
    console.error(`  ${e.message}`);
  }
}

// ── 创建 Release ──────────────────────────────────────────
if (doRelease && doPush) {
  console.log("\n[bump-version] 创建 GitHub Release...");
  try {
    execFileSync("gh", [
      "release", "create", finalRelease,
      "--title", `dsh-leng-team ${finalRelease}`,
      "--notes", commitMsg,
      "--latest",
    ], { cwd: ROOT, stdio: "inherit" });
    console.log(`[bump-version] Release ${finalRelease} 创建成功`);
  } catch (e) {
    console.error(`[bump-version] Release 创建失败: ${e.message}`);
  }
} else if (doRelease && !doPush) {
  console.log("[bump-version] --release 需要 --push，跳过 Release 创建");
}

// ── 验证三处一致 ──────────────────────────────────────────
console.log("\n[bump-version] ─── 三处一致性验证 ───");
const pkgAfter = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
const headMsg = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: ROOT, encoding: "utf8" }).trim();
const headRelease = execFileSync("git", ["log", "-1", "--format=%H"], { cwd: ROOT, encoding: "utf8" }).trim();

const checks = [
  { label: "package.json release", value: pkgAfter.release, expected: finalRelease },
  { label: "package.json version", value: pkgAfter.version, expected: finalVersion },
  { label: "commit 消息版本号", value: headMsg.startsWith(finalRelease) ? finalRelease : "MISMATCH", expected: finalRelease },
];

let allOk = true;
for (const c of checks) {
  const ok = c.value === c.expected;
  if (!ok) allOk = false;
  console.log(`  ${ok ? "✅" : "❌"} ${c.label}: ${c.value} ${ok ? "" : `(期望 ${c.expected})`}`);
}

if (allOk) {
  console.log("\n[bump-version] ✅ 三处版本号完全一致，SSOT 生效");
} else {
  console.log("\n[bump-version] ❌ 版本号不一致，请手动修复!");
  process.exit(1);
}