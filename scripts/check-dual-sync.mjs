#!/usr/bin/env node
/**
 * check-dual-sync.mjs —— #5 优化：config.js 与 client.js 双份默认值一致性校验。
 *
 * 服务端（lib/config.js）与客户端（client/client.js）各维护一份专家设置默认值，
 * 历史上有两次只改一边导致不一致。本脚本对关键默认值/字段范围做提取比对，
 * 不一致时 exit 1 并打印差异。被 scripts/sync-web.mjs 在同步前调用。
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

const checks = [
  // [名称, 块键, 字段键]
  ["discovery.maxRounds 默认值", "discovery", "maxRounds"],
  ["discoveryTrigger.maxLoops 默认值", "discoveryTrigger", "maxLoops"],
  ["designClosure.maxRounds 默认值", "designClosure", "maxRounds"],
  ["qualityGate.maxLoops 默认值", "qualityGate", "maxLoops"],
];
const fieldChecks = [
  ["discovery.maxRounds 范围", "discovery.maxRounds"],
  ["discoveryTrigger.maxLoops 范围", "discoveryTrigger.maxLoops"],
  ["designClosure.maxRounds 范围", "designClosure.maxRounds"],
  ["qualityGate.maxLoops 范围", "qualityGate.maxLoops"],
];

let fails = 0;
for (const [name, block, key] of checks) {
  const a = defValue(cfg, block, key);
  const b = defValue(client, block, key);
  const okV = a !== null && a === b;
  console.log(`${okV ? "PASS" : "FAIL"}  默认值 ${name}: config=${a} client=${b}`);
  if (!okV) fails++;
}
for (const [name, key] of fieldChecks) {
  const a = fieldRange(cfg, key);
  const b = fieldRange(client, key);
  const okV = a !== null && JSON.stringify(a) === JSON.stringify(b);
  console.log(`${okV ? "PASS" : "FAIL"}  范围   ${name}: config=[${a}] client=[${b}]`);
  if (!okV) fails++;
}
// 版本一致性：package.json release 与 orchestrator 读包（#1 单一数据源抽查）
const pkg = JSON.parse(read("package.json"));
const orch = read("lib/orchestrator.js");
if (orch.includes(`release: pkg.release || pkg.version`) && orch.includes('_require("../package.json")')) {
  console.log(`PASS  版本单一数据源: release=${pkg.release || pkg.version}`);
} else {
  console.log(`FAIL  版本单一数据源: orchestrator 未读取 package.json`);
  fails++;
}

console.log(fails === 0 ? "\nDUAL-SYNC ALL PASS" : `\nDUAL-SYNC FAILS=${fails}`);
process.exit(fails === 0 ? 0 : 1);
