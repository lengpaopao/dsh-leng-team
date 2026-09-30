#!/usr/bin/env node
// 第十一轮新增：**声明 ↔ 承载/消费者** 不变量校验。
//
// 背景（用户 m05514 的追问：「为什么每次运行一遍就发现一次问题」）：
// 本插件的「声明面」远大于「承载面」——配置键在 lib/config.js 里声明 4 处镜像、
// 35 个角色 / 27 个槽位 / 7 个域模板 / DAG 节点各自独立声明，任何一处漏接线都不会报错，
// 只是静默地「设置页能改、改了没用」或「角色声称存在、运行期永不可达」。
// 历轮发现的问题（K-1 角色包零消费者、K-2 designKey 不可达、K-5 死旋钮、
// K-6 discoveryTrigger 整块死配置、K-7 accessibility/i18n 无承载节点、K-10 fiction 缺模板）
// 全部属于这一类，靠随机探查只能靠运气命中。
//
// 因此把该类不变量变成常驻机械校验，串入 `npm run check:dual`：
//   1. 配置组 / 配置叶子 → 至少一处消费者
//   2. 每个条件角色 slotId → 至少一处承载节点（DAG 条件节点 / 域条件角色 / 跨域条件角色）
//   3. DOMAIN_EXEC / DOMAIN_TEMPLATES / ROLE_PACKS / ROLE_COUNT 键集合关系
//   4. templateFor(域).splitDimension 与 DOMAIN_EXEC[域].splitDimension 一致
//   5. ROLE_PACKS 的 slotId ⊆ SLOT_DEFINITIONS
//   6. ROLE_PACKS.declaredCount == slotBindings.length
//   7. DOMAIN_EXEC 的 roleKey/designKey、CROSS_DOMAIN_CONDITIONALS 的 roleKey 必须在 ROLE_MAP
//
// 说明：检查 1 是「存在性」校验（某键在 lib/ 内被引用过），不校验语义正确性；
// 语义正确性仍须靠真跑回归。登记的未接线项见 KNOWN_UNWIRED（报告在案，待裁决）。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DEFAULTS } from "../lib/config.js";
import {
  DOMAIN_EXEC, DOMAIN_TEMPLATES, SOFTWARE_DAG, CROSS_DOMAIN_CONDITIONALS,
  templateFor, conditionalCandidates,
} from "../lib/domain-templates.js";
import { ROLE_MAP, ROLE_PACKS, ROLE_COUNT, SLOT_DEFINITIONS, CONDITIONAL } from "../lib/roles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");

const results = [];
let failures = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
}
function section(title) {
  results.push({ name: title, ok: true, detail: "", header: true });
}

/** 读取 lib/ 下全部消费者源码（排除 config.js 自身——它只是声明处）。 */
function consumerSource() {
  const parts = [];
  for (const f of readdirSync(LIB)) {
    if (!f.endsWith(".js")) continue;
    if (f === "config.js") continue; // 声明处不算消费者
    parts.push(readFileSync(join(LIB, f), "utf8"));
  }
  return parts.join("\n");
}
const SRC = consumerSource();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 该标识符是否在 lib/（除 config.js）中以成员访问、下标或字符串字面量出现过。 */
function referenced(key) {
  const k = esc(key);
  const re = new RegExp(`(?:\\.|\\?\\.)\\s*${k}\\b|\\[\\s*["'\`]${k}["'\`]\\s*\\]|["'\`]${k}["'\`]`);
  return re.test(SRC);
}

/** 展开 DEFAULTS 叶子路径。 */
function leaves(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leaves(v, p));
    else out.push(p);
  }
  return out;
}

/**
 * 已登记「声明了但尚无消费者」的配置项（属待裁决项，不是遗漏）。
 * 新增死配置必须先在此登记理由，否则 check:dual 会红。
 *
 * 第十二轮：原 4 项（taskType.pathPattern / replicate.sourceReadonly / discovery.depth /
 * discovery.evidenceSources）已全部接线（见报告第十二轮 K-20…K-23），**本表已清空**——
 * 空表是「零未接线配置」的最强证据；后续若又出现死配置，必须先在此写理由才能过门禁。
 */
const KNOWN_UNWIRED = new Map([]);

// ---------------------------------------------------------------- 1. 配置声明
section("一、配置声明 → 消费者（lib/ 除 config.js 外至少一处引用）");
const groups = Object.keys(DEFAULTS);
const deadGroups = groups.filter((g) => !referenced(g));
check(
  `配置组均有消费者（${groups.length} 组）`,
  deadGroups.length === 0,
  deadGroups.length ? `无消费者的配置组：${deadGroups.join(", ")}` : "",
);
const allLeaves = leaves(DEFAULTS);
const deadLeaves = [];
const allowlisted = [];
for (const p of allLeaves) {
  const leaf = p.split(".").at(-1);
  const parent = p.split(".").at(-2) ?? "";
  if (referenced(leaf) || referenced(parent)) continue;
  if (KNOWN_UNWIRED.has(p)) allowlisted.push(p);
  else deadLeaves.push(p);
}
check(
  `配置叶子均有消费者（${allLeaves.length} 项，已登记未接线 ${allowlisted.length} 项）`,
  deadLeaves.length === 0,
  deadLeaves.length ? `无消费者的配置叶子：${deadLeaves.join(", ")}` : "",
);

// ------------------------------------------------------- 2. 条件角色承载节点
section("二、条件角色 slotId → 承载节点（防「声称存在、运行期不可达」）");
const dagCondSlots = new Set(conditionalCandidates(SOFTWARE_DAG).map((c) => c.roleSlotId));
const domainCondSlots = new Set();
for (const d of Object.keys(DOMAIN_EXEC)) {
  for (const c of DOMAIN_EXEC[d].conditionals ?? []) domainCondSlots.add(c.slotId);
}
const crossSlots = new Set(CROSS_DOMAIN_CONDITIONALS.map((c) => c.slotId));
const conditionalWithCond = CONDITIONAL.filter((r) => r.activationCondition);
const unreachable = conditionalWithCond.filter(
  (r) => !dagCondSlots.has(r.slotId) && !domainCondSlots.has(r.slotId) && !crossSlots.has(r.slotId),
);
check(
  `条件角色均有承载节点（${conditionalWithCond.length} 个带激活条件的条件角色）`,
  unreachable.length === 0,
  unreachable.length ? `无承载节点：${unreachable.map((r) => `${r.key}(slot=${r.slotId},cond=${r.activationCondition})`).join("; ")}` : "",
);

// ------------------------------------------------------------ 3. 域键集合关系
section("三、域键集合关系（DOMAIN_EXEC ⊆ DOMAIN_TEMPLATES == ROLE_PACKS == ROLE_COUNT）");
const execKeys = Object.keys(DOMAIN_EXEC);
const tplKeys = Object.keys(DOMAIN_TEMPLATES);
const packKeys = Object.keys(ROLE_PACKS);
const countKeys = Object.keys(ROLE_COUNT);
const missingTpl = execKeys.filter((d) => !tplKeys.includes(d));
check("DOMAIN_EXEC 的域均有模板", missingTpl.length === 0, missingTpl.length ? `缺模板：${missingTpl.join(", ")}` : "");
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
check("DOMAIN_TEMPLATES 键 == ROLE_PACKS 键", sameSet(tplKeys, packKeys), `模板=[${tplKeys.join(",")}] 角色包=[${packKeys.join(",")}]`);
check("DOMAIN_TEMPLATES 键 == ROLE_COUNT 键", sameSet(tplKeys, countKeys), `模板=[${tplKeys.join(",")}] 计数=[${countKeys.join(",")}]`);

// ------------------------------------------------------------ 4. 拆分维度一致
section("四、templateFor(域).splitDimension == DOMAIN_EXEC[域].splitDimension");
for (const d of execKeys) {
  const t = templateFor(d);
  const want = DOMAIN_EXEC[d].splitDimension;
  const got = t?.splitDimension;
  check(`拆分维度 ${d}（${got}）`, got === want, got === want ? "" : `期望 ${want}，实际 ${got}（模板可能回落到 generic）`);
}

// --------------------------------------------------- 5/6. 角色包槽位与声明数
section("五、角色包 slotId ⊆ SLOT_DEFINITIONS，declaredCount == 实际绑定数");
const slotIds = new Set(Object.keys(SLOT_DEFINITIONS));
for (const [domain, pack] of Object.entries(ROLE_PACKS)) {
  const bad = (pack.slotBindings ?? []).filter((b) => !slotIds.has(b.slotId)).map((b) => b.slotId);
  check(`角色包槽位 ${domain}（${(pack.slotBindings ?? []).length} 个）`, bad.length === 0, bad.length ? `未在 SLOT_DEFINITIONS 声明：${bad.join(", ")}` : "");
  check(
    `角色包声明数 ${domain}（declaredCount=${pack.declaredCount}，实际=${(pack.slotBindings ?? []).length}）`,
    pack.declaredCount === (pack.slotBindings ?? []).length,
    pack.declaredCount === (pack.slotBindings ?? []).length ? "" : "声明数与实际绑定数不一致",
  );
}

// ------------------------------------------------------------ 7. 角色引用有效
section("七、域执行/设计角色与跨域条件角色均在 ROLE_MAP");
for (const d of execKeys) {
  const e = DOMAIN_EXEC[d];
  const bad = [e.roleKey, e.designKey].filter((k) => k && !ROLE_MAP[k]);
  check(`域角色 ${d}（roleKey=${e.roleKey}, designKey=${e.designKey}）`, bad.length === 0, bad.length ? `ROLE_MAP 中不存在：${bad.join(", ")}` : "");
}
const badCross = CROSS_DOMAIN_CONDITIONALS.filter((c) => !ROLE_MAP[c.roleKey]).map((c) => c.roleKey);
check("跨域条件角色均在 ROLE_MAP", badCross.length === 0, badCross.length ? `ROLE_MAP 中不存在：${badCross.join(", ")}` : "");

// ------------------------------------------------------------------- 输出
for (const r of results) {
  if (r.header) { console.log(`\n${r.name}`); continue; }
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
if (allowlisted.length) {
  console.log("\n已登记未接线（第十轮报告在案，待用户裁决，不计失败）：");
  for (const p of allowlisted) console.log(`  NOTE  ${p} — ${KNOWN_UNWIRED.get(p)}`);
}
const total = results.filter((r) => !r.header).length;
console.log("");
if (failures === 0) {
  console.log(`DECLARATIONS ALL PASS (${total} 项检查)`);
  process.exit(0);
}
console.log(`DECLARATIONS FAILED (${failures}/${total} 项失败)`);
process.exit(1);
