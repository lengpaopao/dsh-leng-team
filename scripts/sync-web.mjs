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

const SYNC_FILES = [
  "package.json",
  "cordis.patch.yml",
  "README.md",
  "lib/index.js", "lib/tools.js", "lib/commands.js", "lib/orchestrator.js",
  "lib/roles.js", "lib/config.js", "lib/discovery.js", "lib/domain-templates.js",
  "lib/conditional.js", "lib/issues.js", "lib/rollback-budget.js", "lib/verification.js",
  "lib/watchdog.js", "lib/rate-limiter.js", "lib/module-splitter.js", "lib/observability.js",
  "lib/snapshot.js", "lib/similarity.js", "lib/settings-section.js",
  "client/client.js",
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
console.log("\n--- 3/4 SHA256 校验 ---");
let diff = 0;
for (const rel of SYNC_FILES) {
  const sp = path.join(srcDir, rel);
  const dp = path.join(dstDir, rel);
  if (!fs.existsSync(sp)) continue;
  if (!fs.existsSync(dp) || sha(sp) !== sha(dp)) { console.log(`  DIFF ${rel}`); diff++; }
}
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
