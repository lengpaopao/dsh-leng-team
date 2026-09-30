#!/usr/bin/env node
/**
 * sync-web.mjs — #2 优化：一键同步插件源码到 web 安装副本（含一致性校验、SHA 校验、可选重启）。
 *
 * 用法：
 *   node scripts/sync-web.mjs            # 仅同步文件 + 校验（不重启）
 *   node scripts/sync-web.mjs --restart  # 同步后重启 dsh web 并打印访问 URL
 *
 * 同步前先跑 scripts/check-dual-sync.mjs（#5 双份一致性），不一致则中止。
 * 副本写入采用整写（UTF-8 无 BOM），规避运行中文件锁。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESTART = process.argv.includes("--restart");
const srcDir = ROOT;
const dstDir = process.env.DSH_LENG_TEAM_DST || "C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-leng-team";

// 第十二轮 K-18：同步清单不再手写。此前 SYNC_FILES 是硬编码数组，
// 新增 lib/stage-reuse.js 后 sync-web 仍报 "ALL SYNCED (0 diff)"，但副本里根本没有该文件，
// 安装副本 import 直接 ERR_MODULE_NOT_FOUND（假绿比报错更危险）。
// 现在：根文件白名单 + lib/client 目录下 *.js 全量自动发现 + 双向完整性校验。
const ROOT_FILES = ["package.json", "cordis.patch.yml", "README.md"];
function discoverFiles(sub, ext) {
  const abs = path.join(srcDir, sub);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => `${sub}/${e.name}`);
}
const SYNC_FILES = [
  ...ROOT_FILES.filter((f) => fs.existsSync(path.join(srcDir, f))),
  ...discoverFiles("lib", ".js"),
  ...discoverFiles("client", ".js"),
];
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const utf8 = { encoding: "utf8" };

console.log(`[sync-web] 源码=${srcDir}`);
console.log(`[sync-web] 副本=${dstDir}  restart=${RESTART}`);

// 1) 双份一致性校验（#5）
console.log("\n--- 1/4 双份一致性校验 (check-dual-sync) ---");
try {
  const out = execFileSync(process.execPath, [path.join(srcDir, "scripts", "check-dual-sync.mjs")], { encoding: "utf8" });
  console.log(out.trim());
  if (!/DUAL-SYNC ALL PASS/.test(out)) throw new Error("dual-sync 校验未通过");
} catch (e) {
  console.error("[sync-web] 中止：双份一致性校验失败");
  process.exit(1);
}

// 2) 同步文件（整写绕锁）
console.log("\n--- 2/4 同步文件 ---");
if (!fs.existsSync(dstDir)) { fs.mkdirSync(dstDir, { recursive: true }); }
for (const rel of SYNC_FILES) {
  const sp = path.join(srcDir, rel);
  const dp = path.join(dstDir, rel);
  if (!fs.existsSync(sp)) { console.log(`  跳过(源码不存在): ${rel}`); continue; }
  fs.mkdirSync(path.dirname(dp), { recursive: true });
  fs.writeFileSync(dp, fs.readFileSync(sp), utf8);
  console.log(`  wrote ${rel}`);
}

// 3) SHA256 校验
console.log("\n--- 3/4 SHA256 校验 + 发布面完整性 ---");
let diff = 0;
for (const rel of SYNC_FILES) {
  const sp = path.join(srcDir, rel);
  const dp = path.join(dstDir, rel);
  if (!fs.existsSync(sp)) continue;
  if (!fs.existsSync(dp) || sha(sp) !== sha(dp)) { console.log(`  DIFF ${rel}`); diff++; }
}
// 3b) K-18 双向完整性：副本 lib/*.js 缺一个都算失败（曾经的假绿），多一个则告警提示陈旧残留。
for (const sub of ["lib", "client"]) {
  const srcSet = new Set(discoverFiles(sub, ".js").map((f) => path.basename(f)));
  const dstAbs = path.join(dstDir, sub);
  const dstSet = fs.existsSync(dstAbs)
    ? new Set(fs.readdirSync(dstAbs, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => e.name))
    : new Set();
  for (const f of srcSet) if (!dstSet.has(f)) { console.log(`  MISSING ${sub}/${f}（副本缺失，插件会在 import 时崩溃）`); diff++; }
  for (const f of dstSet) if (!srcSet.has(f)) console.log(`  WARN 副本多余 ${sub}/${f}（源码已不存在，建议删除以消除误导）`);
}
console.log(`  同步清单=${SYNC_FILES.length} 个文件（自动发现 lib/*.js、client/*.js）`);
console.log(diff === 0 ? "  ALL SYNCED (0 diff)" : `  ${diff} 个文件不一致!`);
if (diff > 0) process.exit(1);

// 4) 可选重启
if (RESTART) {
  console.log("\n--- 4/4 重启 dsh web ---");
  const ps = `
$ErrorActionPreference = 'Continue'
$ports = 3080, 8787
foreach ($p in $ports) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop; "killed pid=$_ port=$p" } catch { "kill failed port=$p" } }
}
Start-Sleep -Seconds 2
$dsh = Get-ChildItem "$env:LOCALAPPDATA\\Doubao\\User Data\\sandbox_runtime\\bases\\*\\node\\dsh.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $dsh) { $dsh = Get-Command dsh.cmd -ErrorAction SilentlyContinue }
if ($dsh) {
  $dshPath = if ($dsh -is [System.IO.FileInfo]) { $dsh.FullName } else { $dsh.Source }
  Start-Process -FilePath $dshPath -ArgumentList 'web','--no-open'
  "started: $dshPath"
} else { "dsh.cmd 未找到，请手动重启 web" }
`;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60000 });
    console.log(out.trim());
    console.log("[sync-web] 等待 web 就绪…");
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const log = fs.readFileSync("C:/Users/Administrator/.dsh/web_start.log", "utf8");
      const m = log.match(/dsh web: (http:\/\/\S+)/);
      console.log(m ? `[sync-web] 访问: ${m[1]}` : "[sync-web] 日志未找到访问 URL");
    } catch { console.log("[sync-web] 未能读取 web_start.log"); }
  } catch (e) {
    console.error("[sync-web] 重启步骤失败（文件已同步）：", e.message);
  }
}

console.log("\n[sync-web] 完成");
