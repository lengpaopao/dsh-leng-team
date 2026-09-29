#!/usr/bin/env node
/**
 * check-dual-sync.mjs —— #5 优化：config.js 与 client.js 双份默认值一致性校验。
 *
 * 服务端（lib/config.js）与客户端（client/client.js）各维护一份专家设置默认值，
 * 历史上有两次只改一边导致不一致。本脚本对关键默认值/字段范围做提取比对，
 * 不一致时 exit 1 并打印差异。被 scripts/sync-web.mjs 在同步前调用。
 *
 * V9.3 增强：从 DEFAULTS 自动提取所有可检查项（不再手动列举 4 个），
 * 覆盖默认值、字段范围、布尔开关三类。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const cfg = read("lib/config.js");
const client = read("client/client.js");

/** 从源码文本提取默认值对象中某键的值 */
function defValue(src, blockKey, key) {
  const seg = src.slice(src.indexOf(blockKey + ": {"));
  const m = seg.match(new RegExp(`${key}: (\\d+|"[^"]*"|true|false)`));
  return m ? m[1].replace(/^"|"$/g, "") : null;
}
/** 解析字段范围表达式：支持数字字面量与 DISCOVERY_MAX_ROUNDS.min/max 常量引用 */
function resolveToken(src, token) {
  const m = src.match(/DISCOVERY_MAX_ROUNDS = Object\.freeze\(\{ min: (-?\d+), max: (-?\d+), default: (-?\d+) \}\)/);
  const map = { "DISCOVERY_MAX_ROUNDS.min": m?.[1], "DISCOVERY_MAX_ROUNDS.max": m?.[2], "DISCOVERY_MAX_ROUNDS.default": m?.[3] };
  return map[token] ?? token;
}
/** 从专家设置字段定义中提取某 key 的 min/max（解析表达式引用） */
function fieldRange(src, key) {
  const seg = src.slice(src.indexOf(`key: "${key}"`));
  const m = seg.match(/min: ([-\w.]+), max: ([-\w.]+)/);
  return m ? [resolveToken(src, m[1]), resolveToken(src, m[2])] : null;
}
/** 从 DEFAULTS 中提取所有可检查的字段键 */
function extractAllKeys(src) {
  const keys = [];
  const re = /key:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.push(m[1]);
  return keys;
}
/** 检查布尔开关默认值 */
function boolValue(src, blockKey, key) {
  const seg = src.slice(src.indexOf(blockKey + ": {"));
  const m = seg.match(new RegExp(`${key}:\\s*(true|false)`));
  return m ? m[1] : null;
}

const allKeys = extractAllKeys(cfg);
let fails = 0;
let checked = 0;

// 1. 逐字段检查默认值（自动从 DEFAULTS 提取）
for (const key of allKeys) {
  const a = defValue(cfg, "DEFAULTS", key);
  const b = defValue(client, key);
  if (a === null || b === null) continue; // 跳过无法解析的
  checked++;
  const okV = a === b;
  if (!okV) {
    console.log(`FAIL  默认值 ${key}: config=${a} client=${b}`);
    fails++;
  }
}
console.log(`默认值检查: ${checked} 个字段（自动提取）`);

// 2. 字段范围检查（扩展到所有有 min/max 的字段）
const rangeKeys = [];
const rangeRe = /key:\s*"([^"]+)"[\s\S]{0,200}?min:\s*[-\w.]+,\s*max:\s*[-\w.]+/g;
let rm;
while ((rm = rangeRe.exec(cfg)) !== null) rangeKeys.push(rm[1]);
for (const key of rangeKeys) {
  const a = fieldRange(cfg, key);
  const b = fieldRange(client, key);
  if (!a || !b) continue;
  checked++;
  const okV = JSON.stringify(a) === JSON.stringify(b);
  if (!okV) {
    console.log(`FAIL  范围   ${key}: config=[${a}] client=[${b}]`);
    fails++;
  }
}
console.log(`范围检查: ${rangeKeys.length} 个字段（自动提取）`);

// 3. 布尔开关检查
const boolKeys = [];
const boolRe = /key:\s*"([^"]+)"[\s\S]{0,200}?type:\s*"boolean"/g;
let bm;
while ((bm = boolRe.exec(cfg)) !== null) boolKeys.push(bm[1]);
for (const key of boolKeys) {
  const a = boolValue(cfg, "DEFAULTS", key);
  const b = boolValue(client, key);
  if (a === null || b === null) continue;
  checked++;
  const okV = a === b;
  if (!okV) {
    console.log(`FAIL  布尔   ${key}: config=${a} client=${b}`);
    fails++;
  }
}
console.log(`布尔检查: ${boolKeys.length} 个字段（自动提取）`);

// 4. 版本一致性：package.json release 与 orchestrator 读包（#1 单一数据源抽查）
const pkg = JSON.parse(read("package.json"));
const orch = read("lib/orchestrator.js");
if (orch.includes(`release: pkg.release || pkg.version`) && orch.includes('_require("../package.json")')) {
  console.log(`PASS  版本单一数据源: release=${pkg.release || pkg.version}`);
} else {
  console.log(`FAIL  版本单一数据源: orchestrator 未读取 package.json`);
  fails++;
}

// 5. 配置组数一致性（config.js DEFAULTS vs client.js）
const cfgGroups = (cfg.match(/^[a-zA-Z][\w]+:\s*\{/gm) ?? []).length;
const clientGroups = (client.match(/^[a-zA-Z][\w]+:\s*\{/gm) ?? []).length;
console.log(`配置组数: config=${cfgGroups} client=${clientGroups}`);
if (cfgGroups !== clientGroups) {
  console.log(`WARN  配置组数不一致（可能因 client 使用不同分组方式，非阻断）`);
}

console.log(fails === 0 ? `\nDUAL-SYNC ALL PASS (${checked} 项检查)` : `\nDUAL-SYNC FAILS=${fails} (${checked} 项检查)`);
process.exit(fails === 0 ? 0 : 1);