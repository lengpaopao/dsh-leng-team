/**
 * Full config schema for dsh-leng-team (V9.3).
 *
 * Mirrors the cordis plugin `Config` field (zod) and a JSON schema used by the
 * settings section to render the expert page. All parameters live in the expert page.
 * 无微型办公室/动画：office 配置已删除。
 */

import { ROLES, CONDITIONAL } from "./roles.js";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/** 调查员回环上限单一数据源（用户修订 2026-09-29：3–8，默认 5）。schema 字段与运行时 clamp 均引用此常量。 */
export const DISCOVERY_MAX_ROUNDS = Object.freeze({ min: 3, max: 8, default: 5 });

/** 全部角色 = 14 核心 + 21 条件角色（方案 2.1/2.2）。 */
const ALL_ROLES = [...ROLES, ...CONDITIONAL];
function getZod() {
  try {
    return _require("zod");
  } catch {
    return null;
  }
}

export function buildZodConfig() {
  const z = getZod();
  if (!z) {
    return {
      safeParse: (v) => ({ success: true, data: normalizeConfig(v), error: { issues: [] } }),
    };
  }
  const string = z.string();
  const boolean = z.boolean().default(true);
  const number = (min, max, def) => z.number().min(min).max(max).default(def);

  const roleModel = () => z.object({
    provider: z.string().default("freehub-deepseek-v4-flash-glm5-2-3"),
    model: z.string().default("glm-5.2"),
  }).default({});

  return z.object({
    enabled: z.boolean().default(true),

    trigger: z.object({
      primary: z.string().default("/team"),
      aliases: z.array(z.string()).default(["/dsh-leng-team"]),
      conflictPolicy: z.enum(["useAlias", "block", "force"]).default("useAlias"),
      customAliases: z.array(z.string()).default([]),
    }).default({}),

    // 席位池 & 并发（默认 5，1-5；令牌桶 RPS/RPM 与 429 降级）
    concurrency: z.object({
      maxConcurrent: number(1, 5, 5),
      queueStrategy: z.enum(["fifo", "priority"]).default("fifo"),
      queueTimeoutMs: number(60000, 3600000, 600000),
      rps: number(1, 60, 8),
      rpm: number(10, 1200, 240),
      burst: number(10, 500, 100),
      platformCap: number(1, 5, 5),
      backoffMs: number(100, 60000, 3000),
      degradeThreshold: number(1, 20, 3),
      degradeStrategy: z.enum(["progressive", "immediate"]).default("progressive"),
      globalPauseOn429: z.boolean().default(true),
    }).default({}),

    watchdog: z.object({
      enabled: boolean,
      intervalMs: number(60000, 3600000, 240000),
      similarityThreshold: number(0.5, 1, 0.85),
      repeatRounds: number(3, 20, 6),
      maxRetries429: number(0, 10, 3),
      backoffMs: number(100, 60000, 3000),
      freezeQueueOn429: z.boolean().default(true),
      zombieIdleMs: number(60000, 3600000, 300000),
      action: z.enum(["pause", "rebuild", "terminate"]).default("pause"),
    }).default({}),

    moduleSplit: z.object({
      enabled: boolean,
      parsePrompt: z.string().default(""),
      mergePrompt: z.string().default(""),
      aggregateThreshold: number(3, 100, 8),
      cacheEnabled: z.boolean().default(true),
      reuseTemplates: z.boolean().default(true),
    }).default({}),

    flow: z.object({
      manualConfirm: z.object({
        requirement: boolean,
        architecture: boolean,
        ui: boolean,
        final: boolean,
      }).default({}),
      autoConfirm: z.boolean().default(false),
      confirmTimeoutMs: number(10000, 3600000, 300000),
      maxRework: number(1, 10, 3),
      requirementChangePolicy: z.enum(["block", "routeBack"]).default("routeBack"),
      summaryTokenCap: number(500, 20000, 4000),
      // 修复 F2/F3/F4：以下键此前被 orchestrator 直接读取但四处配置源均未声明（死旋钮），现补齐声明。
      devTimeoutMs: number(60000, 7200000, 1800000),
      taskTimeoutMs: number(30000, 3600000, 300000),
      conditionalTimeoutMs: number(60000, 3600000, 300000),
      gateWaitMs: number(60000, 3600000, 300000),
      manualConfirmDefaults: z.object({
        requirement: boolean,
        architecture: boolean,
        ui: boolean,
        final: boolean,
      }).default({ requirement: true, architecture: false, ui: false, final: false }),
    }).default({}),

    // 修复 F1：模型护栏（上游挂起时切备用模型的兜底）此前只在 orchestrator 内以字面量兜底读取，
    // 四个配置源均无声明 → 无法关闭护栏或改设备用模型。现补齐声明。
    modelGuard: z.object({
      enabled: boolean,
      hangingUpstreams: z.array(z.string()).default(["280b", "dots3-note-prev", "note3-prev"]),
      fallbackProvider: z.string().default("freehub-deepseek-v4-flash-glm5-2-3"),
      fallbackModel: z.string().default("glm-5.2"),
    }).default({}),

    // 条件启用三方会签
    conditional: z.object({
      enabled: z.boolean().default(true),
      threeWaySignoff: z.boolean().default(true),
      divergencePolicy: z.enum(["recordDissent", "escalate", "timeoutDisable"]).default("recordDissent"),
      timeoutPolicy: z.enum(["defaultDisable", "defer", "enable"]).default("defaultDisable"),
      trail: z.boolean().default(true),
      finalAuditCheck: z.boolean().default(true),
    }).default({}),

    // 全局回退预算
    rollback: z.object({
      totalBudget: number(1, 100, 10),
      perNodeBudget: number(1, 20, 5),
      perEdgeBudget: number(1, 10, 3),
      windowSizeMs: number(300000, 3600000, 1800000),
      escalationThreshold: number(1, 50, 8),
    }).default({}),

    // 独立复验
    verification: z.object({
      enabled: z.boolean().default(true),
      rounds: number(1, 10, 3),
      samples: number(1, 10, 3),
      mirror: z.boolean().default(true),
      mirrorBudgetRatio: number(0.01, 1, 0.1),
      conditionalConfirm: z.boolean().default(true),
      blind: z.boolean().default(true),
      counter: z.boolean().default(true),
      evidenceIndependent: z.boolean().default(true),
      externalBaseline: z.boolean().default(true),
    }).default({}),

    // 角色边界
    roleBoundary: z.object({
      forceNonResponsibilities: z.boolean().default(true),
      crossRoleReport: z.boolean().default(true),
      conflictEscalation: z.boolean().default(true),
    }).default({}),

    // 缓存键完整化
    cacheKey: z.object({
      includeConditionalVersions: z.boolean().default(true),
      strictVersionCheck: z.boolean().default(true),
      recordHit: z.boolean().default(true),
      recordMiss: z.boolean().default(true),
    }).default({}),

    // 角色模型覆盖（默认核心 + 条件角色）
    models: z.object({
      ...Object.fromEntries(ROLES.map((r) => [r.key, roleModel()])),
    }).default({}),

    observability: z.object({
      enabled: boolean,
      panelEnabled: boolean,
      refreshMs: number(1000, 60000, 5000),
      show: z.array(z.string()).default(["dag", "queue", "seats", "token", "watchdog", "anomaly", "rework", "handover", "rollback", "signoff", "verification", "rate", "discovery", "gate", "design", "performance", "security_test", "release", "sre", "ci_cd", "accessibility", "i18n", "cache_miss"]),
      exportJson: z.boolean().default(true),
    }).default({}),

    cost: z.object({
      summaryIndex: z.boolean().default(true),
      moduleCache: z.boolean().default(true),
      reuseModules: z.boolean().default(true),
      tieredModels: z.boolean().default(true),
    }).default({}),

    security: z.object({
      inputIsolation: z.boolean().default(true),
      blockPrivilege: z.boolean().default(true),
      blockSensitive: z.boolean().default(true),
      appendGuard: z.boolean().default(true),
    }).default({}),

    version: z.object({
      personaVersion: z.string().default("1.0.0"),
      rollbackEnabled: z.boolean().default(true),
      abTestEnabled: z.boolean().default(false),
    }).default({}),

    finalRegression: z.object({
      enabled: z.boolean().default(true),
      environment: z.string().default("准生产"),
      coverage: z.string().default("全部功能+设计+性能+安全+无障碍+i18n"),
      replicaCompare: z.boolean().default(true),
      blockIfFail: z.boolean().default(true),
      tiers: z.string().default("core,conditional,optional"),
      timeBudgetMs: number(60000, 7200000, 1800000),
    }).default({}),

    deployEnv: z.object({
      adapter: z.enum(["local_process", "container", "remote", "simulated"]).default("local_process"),
      adapters: z.array(z.string()).default(["local_process", "container", "remote", "simulated"]),
    }).default({}),
  }).default({});
}

function getSchema() {
  try {
    return _require("@deepseek-ai/schemastery");
  } catch {
    return null;
  }
}

export function buildSchemasteryConfig() {
  const S = getSchema();
  if (!S) {
    return (v) => normalizeConfig(v);
  }
  const str = (d) => S.string().default(d);
  const b = (d) => S.boolean().default(d);
  const num = (d, min, max) => S.number().min(min).max(max).default(d);
  const arr = (a) => S.array(S.string()).default(a);
  const roleModel = S.object({
    provider: str("freehub-deepseek-v4-flash-glm5-2-3"),
    model: str("glm-5.2"),
  }).default({ provider: "freehub-deepseek-v4-flash-glm5-2-3", model: "glm-5.2" });

  return S.object({
    enabled: b(true),

    trigger: S.object({
      primary: str("/team"),
      aliases: arr(["/dsh-leng-team"]),
      conflictPolicy: str("useAlias"),
      customAliases: arr([]),
    }).default(DEFAULTS.trigger),

    concurrency: S.object({
      maxConcurrent: num(5, 1, 5),
      queueStrategy: str("fifo"),
      queueTimeoutMs: num(600000, 60000, 3600000),
      rps: num(8, 1, 60),
      rpm: num(240, 10, 1200),
      backoffMs: num(3000, 100, 60000),
      degradeThreshold: num(3, 1, 20),
      degradeStrategy: str("progressive"),
      globalPauseOn429: b(true),
    }).default(DEFAULTS.concurrency),

    watchdog: S.object({
      enabled: b(true),
      intervalMs: num(240000, 60000, 3600000),
      similarityThreshold: num(0.85, 0.5, 1),
      repeatRounds: num(6, 3, 20),
      maxRetries429: num(3, 0, 10),
      backoffMs: num(3000, 100, 60000),
      freezeQueueOn429: b(true),
      zombieIdleMs: num(300000, 60000, 3600000),
      action: str("pause"),
    }).default(DEFAULTS.watchdog),

    moduleSplit: S.object({
      enabled: b(true),
      parsePrompt: str(""),
      mergePrompt: str(""),
      aggregateThreshold: num(8, 3, 100),
      cacheEnabled: b(true),
      reuseTemplates: b(true),
    }).default(DEFAULTS.moduleSplit),

    flow: S.object({
      manualConfirm: S.object({
        requirement: b(true),
        architecture: b(false),
        ui: b(false),
        final: b(false),
      }).default(DEFAULTS.flow.manualConfirm),
      autoConfirm: b(false),
      confirmTimeoutMs: num(300000, 10000, 3600000),
      maxRework: num(3, 1, 10),
      requirementChangePolicy: str("routeBack"),
      summaryTokenCap: num(4000, 500, 20000),
      // 修复 F2/F3/F4：补齐 orchestrator 读取但未声明的流程键（死旋钮）。
      devTimeoutMs: num(1800000, 60000, 7200000),
      taskTimeoutMs: num(300000, 30000, 3600000),
      conditionalTimeoutMs: num(300000, 60000, 3600000),
      gateWaitMs: num(300000, 60000, 3600000),
      manualConfirmDefaults: S.object({
        requirement: b(true),
        architecture: b(false),
        ui: b(false),
        final: b(false),
      }).default(DEFAULTS.flow.manualConfirmDefaults),
    }).default(DEFAULTS.flow),

    // 修复 F1：模型护栏声明（详见 zod 段注释）。
    modelGuard: S.object({
      enabled: b(true),
      hangingUpstreams: arr(["280b", "dots3-note-prev", "note3-prev"]),
      fallbackProvider: str("freehub-deepseek-v4-flash-glm5-2-3"),
      fallbackModel: str("glm-5.2"),
    }).default(DEFAULTS.modelGuard),

    conditional: S.object({
      enabled: b(true),
      threeWaySignoff: b(true),
      divergencePolicy: str("recordDissent"),
      timeoutPolicy: str("defaultDisable"),
      trail: b(true),
      finalAuditCheck: b(true),
    }).default(DEFAULTS.conditional),

    rollback: S.object({
      totalBudget: num(10, 1, 100),
      perNodeBudget: num(5, 1, 20),
      perEdgeBudget: num(3, 1, 10),
      windowSizeMs: num(1800000, 300000, 3600000),
      escalationThreshold: num(8, 1, 50),
    }).default(DEFAULTS.rollback),

    verification: S.object({
      enabled: b(true),
      rounds: num(3, 1, 10),
      samples: num(3, 1, 10),
      mirror: b(true),
      blind: b(true),
      counter: b(true),
      evidenceIndependent: b(true),
      externalBaseline: b(true),
    }).default(DEFAULTS.verification),

    roleBoundary: S.object({
      forceNonResponsibilities: b(true),
      crossRoleReport: b(true),
      conflictEscalation: b(true),
    }).default(DEFAULTS.roleBoundary),

    cacheKey: S.object({
      includeConditionalVersions: b(true),
      strictVersionCheck: b(true),
      recordHit: b(true),
      recordMiss: b(true),
    }).default(DEFAULTS.cacheKey),

    models: S.object(Object.fromEntries(ROLES.map((r) => [r.key, roleModel]))).default(DEFAULTS.models),

    roles: S.object(Object.fromEntries(ROLES.map((r) => [r.key, S.object({ personaCore: str(r.personaCore) }).default({ personaCore: r.personaCore })]))).default(DEFAULTS.roles),

    observability: S.object({
      enabled: b(true),
      panelEnabled: b(true),
      refreshMs: num(5000, 1000, 60000),
      show: arr(["dag", "queue", "seats", "token", "watchdog", "anomaly", "rework", "handover", "rollback", "signoff", "verification", "rate", "discovery", "gate", "design", "performance", "security_test", "release", "sre", "ci_cd", "accessibility", "i18n", "cache_miss"]),
      exportJson: b(true),
    }).default(DEFAULTS.observability),

    cost: S.object({
      summaryIndex: b(true),
      moduleCache: b(true),
      reuseModules: b(true),
      tieredModels: b(true),
    }).default(DEFAULTS.cost),

    security: S.object({
      inputIsolation: b(true),
      blockPrivilege: b(true),
      blockSensitive: b(true),
      appendGuard: b(true),
    }).default(DEFAULTS.security),

    version: S.object({
      personaVersion: str("1.0.0"),
      rollbackEnabled: b(true),
      abTestEnabled: b(false),
    }).default(DEFAULTS.version),
  });
}

export function buildSettingsSections() {
  const roleSection = (title, keys, note) => ({
    title,
    note,
    fields: keys.map((key) => ({
      key: `models.${key}.provider`,
      type: "text",
      label: `${ALL_ROLES.find((r) => r.key === key)?.label ?? key} 提供方（留空=继承）`,
    })).concat(keys.map((key) => ({
      key: `models.${key}.model`,
      type: "text",
      label: `${ALL_ROLES.find((r) => r.key === key)?.label ?? key} 模型（留空=继承父会话）`,
    }))),
  });

  return [
    { title: "总开关", fields: [{ key: "enabled", type: "toggle", label: "启用 dsh-leng-team" }] },
    {
      title: "触发与命令",
      fields: [
        { key: "trigger.primary", type: "text", label: "主命令" },
        { key: "trigger.aliases", type: "text", label: "等价命令（逗号分隔）" },
        { key: "trigger.customAliases", type: "text", label: "自定义别名（逗号分隔，唯一性校验）" },
        { key: "trigger.conflictPolicy", type: "select", label: "命令冲突策略", options: ["useAlias", "block", "force"] },
      ],
    },
    {
      title: "席位池与并发（默认 5）",
      fields: [
        { key: "concurrency.maxConcurrent", type: "number", label: "最大子会话并发（1-5，默认 5）", min: 1, max: 5 },
        { key: "concurrency.queueStrategy", type: "select", label: "队列策略", options: ["fifo", "priority"] },
        { key: "concurrency.priorityEnabled", type: "toggle", label: "P0-P3 优先级" },
        { key: "concurrency.keyPathReserve", type: "toggle", label: "关键路径预留席位" },
        { key: "concurrency.reservedSeats", type: "number", label: "预留席位数（默认 1）", min: 0, max: 4 },
        { key: "concurrency.queueTimeoutMs", type: "number", label: "排队超时告警（毫秒）", min: 60000, max: 3600000 },
        { key: "concurrency.rps", type: "number", label: "令牌桶 RPS", min: 1, max: 60 },
        { key: "concurrency.burst", type: "number", label: "令牌桶突发容量（默认 100）", min: 10, max: 500 },
        { key: "concurrency.platformCap", type: "number", label: "DSH 平台并发上限探测（1-5，默认 5）", min: 1, max: 5 },
        { key: "concurrency.rpm", type: "number", label: "令牌桶 RPM", min: 10, max: 1200 },
        { key: "concurrency.backoffMs", type: "number", label: "429 退避基数（毫秒）", min: 100, max: 60000 },
        { key: "concurrency.degradeThreshold", type: "number", label: "429 降级触发阈值", min: 1, max: 20 },
        { key: "concurrency.degradeStrategy", type: "select", label: "429 恢复策略", options: ["progressive", "immediate"] },
        { key: "concurrency.globalPauseOn429", type: "toggle", label: "严重限流全局暂停" },
      ],
    },
    {
      title: "看门狗（默认 4 分钟）",
      fields: [
        { key: "watchdog.enabled", type: "toggle", label: "启用看门狗" },
        { key: "watchdog.intervalMs", type: "number", label: "轮询周期（毫秒，默认 240000=4 分钟）", min: 60000, max: 3600000 },
        { key: "watchdog.similarityThreshold", type: "number", label: "语义相似度阈值", min: 0.5, max: 1, step: 0.05 },
        { key: "watchdog.repeatRounds", type: "number", label: "连续重复轮次", min: 3, max: 20 },
        { key: "watchdog.maxRetries429", type: "number", label: "429 最大重试", min: 0, max: 10 },
        { key: "watchdog.backoffMs", type: "number", label: "退避时长（毫秒）", min: 100, max: 60000 },
        { key: "watchdog.freezeQueueOn429", type: "toggle", label: "持续限流冻结队列" },
        { key: "watchdog.zombieIdleMs", type: "number", label: "僵尸会话判定（毫秒）", min: 60000, max: 3600000 },
        { key: "watchdog.action", type: "select", label: "死循环处置", options: ["pause", "rebuild", "terminate"] },
      ],
    },
    {
      title: "开发模块拆分",
      fields: [
        { key: "moduleSplit.enabled", type: "toggle", label: "按页面/接口自动拆分子任务" },
        { key: "moduleSplit.aggregateThreshold", type: "number", label: "动态子工位聚合阈值", min: 3, max: 100 },
        { key: "moduleSplit.cacheEnabled", type: "toggle", label: "模块级缓存" },
        { key: "moduleSplit.reuseTemplates", type: "toggle", label: "重复模块复用模板" },
        { key: "moduleSplit.parsePrompt", type: "textarea", label: "文档解析规则（提取页面/接口清单）" },
        { key: "moduleSplit.mergePrompt", type: "textarea", label: "模块产物合并规则" },
      ],
    },
    {
      title: "流程控制",
      fields: [
        { key: "flow.manualConfirm.requirement", type: "toggle", label: "需求定稿人工确认" },
        { key: "flow.manualConfirm.architecture", type: "toggle", label: "架构定稿人工确认" },
        { key: "flow.manualConfirm.ui", type: "toggle", label: "UI 定稿人工确认" },
        { key: "flow.manualConfirm.final", type: "toggle", label: "最终交付人工确认" },
        { key: "flow.autoConfirm", type: "toggle", label: "测试模式（需确认环节默认通过并标注）", hint: "开启=测试时默认通过并标注「需确认」；关闭=正式模式，等待 /team confirm <key> 人工拍板" },
        { key: "flow.confirmTimeoutMs", type: "number", label: "确认等待超时（毫秒，默认 300000）", min: 10000, max: 3600000 },
        { key: "flow.maxRework", type: "number", label: "最大返工次数", min: 1, max: 10 },
        { key: "flow.requirementChangePolicy", type: "select", label: "需求变更策略", options: ["block", "routeBack"] },
        { key: "flow.summaryTokenCap", type: "number", label: "摘要压缩 Token 上限", min: 500, max: 20000 },
        { key: "flow.devTimeoutMs", type: "number", label: "单角色开发超时（毫秒，默认 1800000）", min: 60000, max: 7200000 },
        { key: "flow.taskTimeoutMs", type: "number", label: "单任务执行超时（毫秒，默认 300000）", min: 30000, max: 3600000 },
        { key: "flow.conditionalTimeoutMs", type: "number", label: "有条件合格确认超时（毫秒，默认 300000；超时按不合格回退）", min: 60000, max: 3600000 },
        { key: "flow.gateWaitMs", type: "number", label: "P0 门禁阻断等待上限（毫秒，默认 300000）", min: 60000, max: 3600000 },
      ],
    },
    {
      // 修复 F1：模型护栏此前不可配置（无 UI、无声明），此处开放关键旋钮。
      // hangingUpstreams 为数组，UI 无数组控件故不暴露，可在配置文件直改（默认已内置常见挂起上游）。
      title: "模型护栏",
      fields: [
        { key: "modelGuard.enabled", type: "toggle", label: "启用模型护栏（父会话命中挂起上游时切换备用模型）" },
        { key: "modelGuard.fallbackProvider", type: "text", label: "备用 Provider（默认 freehub-deepseek-v4-flash-glm5-2-3）" },
        { key: "modelGuard.fallbackModel", type: "text", label: "备用模型（默认 glm-5.2）" },
      ],
    },
    {
      title: "条件启用三方会签",
      fields: [
        { key: "conditional.enabled", type: "toggle", label: "启用条件角色机制" },
        { key: "conditional.threeWaySignoff", type: "toggle", label: "三方会签（总指挥+调查员+产品经理）" },
        { key: "conditional.divergencePolicy", type: "select", label: "分歧处理", options: ["recordDissent", "escalate", "timeoutDisable"] },
        { key: "conditional.timeoutPolicy", type: "select", label: "会签超时策略", options: ["defaultDisable", "defer", "enable"] },
        { key: "conditional.trail", type: "toggle", label: "全程留痕" },
        { key: "conditional.finalAuditCheck", type: "toggle", label: "最终审核检查会签单" },
      ],
    },
    {
      title: "全局回退预算",
      fields: [
        { key: "rollback.totalBudget", type: "number", label: "全局回退总预算", min: 1, max: 100 },
        { key: "rollback.perNodeBudget", type: "number", label: "单节点预算", min: 1, max: 20 },
        { key: "rollback.perEdgeBudget", type: "number", label: "单边预算", min: 1, max: 10 },
        { key: "rollback.windowSizeMs", type: "number", label: "滑动窗口（毫秒，默认 30 分钟）", min: 300000, max: 3600000 },
        { key: "rollback.escalationThreshold", type: "number", label: "升级阈值", min: 1, max: 50 },
      ],
    },
    {
      title: "独立复验（最终审核）",
      fields: [
        { key: "verification.enabled", type: "toggle", label: "启用独立复验" },
        { key: "verification.rounds", type: "number", label: "复验轮次（≥3）", min: 1, max: 10 },
        { key: "verification.samples", type: "number", label: "抽样数", min: 1, max: 10 },
        { key: "verification.mirror", type: "toggle", label: "镜像复验" },
        { key: "verification.mirrorBudgetRatio", type: "number", label: "镜像复验 Token 预算比例（0-1，默认 0.1）", min: 0.01, max: 1, step: 0.05 },
        { key: "verification.conditionalConfirm", type: "toggle", label: "有条件合格用户确认（超时默认不合格）" },
        { key: "verification.blind", type: "toggle", label: "盲审（不读执行角色完成声明）" },
        { key: "verification.counter", type: "toggle", label: "反方质询" },
        { key: "verification.evidenceIndependent", type: "toggle", label: "证据链独立" },
        { key: "verification.externalBaseline", type: "toggle", label: "外部对照（复刻对源基线）" },
      ],
    },
    {
      title: "角色边界",
      fields: [
        { key: "roleBoundary.forceNonResponsibilities", type: "toggle", label: "强制声明「不负责什么」" },
        { key: "roleBoundary.crossRoleReport", type: "toggle", label: "越权处理（上报总指挥）" },
        { key: "roleBoundary.conflictEscalation", type: "toggle", label: "职责冲突上报" },
      ],
    },
    {
      title: "缓存键完整化",
      fields: [
        { key: "cacheKey.includeConditionalVersions", type: "toggle", label: "条件角色产物版本单列" },
        { key: "cacheKey.strictVersionCheck", type: "toggle", label: "版本完整校验（不匹配不复用）" },
        { key: "cacheKey.recordHit", type: "toggle", label: "缓存命中记录" },
        { key: "cacheKey.recordMiss", type: "toggle", label: "缓存失效记录" },
      ],
    },
    {
      title: "任务类型识别",
      fields: [
        { key: "taskType.enabled", type: "toggle", label: "启用任务类型识别" },
        { key: "taskType.replicateKeywords", type: "text", label: "复刻类关键词（逗号分隔）" },
        { key: "taskType.pathPattern", type: "text", label: "路径信号模式（source→target）" },
        { key: "taskType.intentDetection", type: "toggle", label: "意图识别（现有项目/桌面文件夹）" },
      ],
    },
    {
      title: "复刻模式",
      fields: [
        { key: "replicate.forceInvestigation", type: "toggle", label: "复刻/迁移/重构/二开强制调查" },
        { key: "replicate.depth", type: "select", label: "调查深度", options: ["light", "standard", "deep"] },
        { key: "replicate.sourceReadonly", type: "toggle", label: "源目录只读" },
        { key: "replicate.skipAllowed", type: "toggle", label: "允许跳过调查（复刻类默认禁止）" },
      ],
    },
    {
      title: "调查自动触发",
      fields: [
        { key: "discoveryTrigger.enabled", type: "toggle", label: "启用自动触发评估" },
        { key: "discoveryTrigger.mode", type: "select", label: "触发模式", options: ["force", "auto", "skip"] },
        { key: "discoveryTrigger.threshold", type: "number", label: "自动触发阈值（≥10 强制 deep）", min: 1, max: 20 },
        { key: "discoveryTrigger.depthMapping", type: "text", label: "深度映射（light/standard/deep）" },
        { key: "discoveryTrigger.domainDefault", type: "text", label: "领域默认策略" },
        { key: "discoveryTrigger.userOverride", type: "toggle", label: "允许用户显式覆盖" },
        { key: "discoveryTrigger.recordSkip", type: "toggle", label: "跳过记录" },
        { key: "discoveryTrigger.maxLoops", type: "number", label: "最大回环", min: 1, max: 5 },
        { key: "discoveryTrigger.escalation", type: "text", label: "超限升级策略" },
      ],
    },
    {
      title: "调查评分权重",
      fields: [
        { key: "discoveryWeights.goal", type: "number", label: "目标模糊度（0-3）", min: 0, max: 5 },
        { key: "discoveryWeights.requirement", type: "number", label: "需求不确定性", min: 0, max: 5 },
        { key: "discoveryWeights.tech", type: "number", label: "技术不确定性", min: 0, max: 5 },
        { key: "discoveryWeights.data", type: "number", label: "数据不确定性", min: 0, max: 5 },
        { key: "discoveryWeights.risk", type: "number", label: "风险等级", min: 0, max: 5 },
        { key: "discoveryWeights.compliance", type: "number", label: "合规要求", min: 0, max: 5 },
        { key: "discoveryWeights.scale", type: "number", label: "任务规模", min: 0, max: 5 },
        { key: "discoveryWeights.existing", type: "number", label: "已有资料（-2）", min: -5, max: 0 },
        { key: "discoveryWeights.time", type: "number", label: "时间约束（-1）", min: -5, max: 0 },
      ],
    },
    {
      title: "调查员",
      fields: [
        { key: "discovery.enabled", type: "toggle", label: "启用调查员" },
        { key: "discovery.depth", type: "select", label: "调查深度", options: ["light", "standard", "deep"] },
        { key: "discovery.evidenceSources", type: "text", label: "证据源" },
        { key: "discovery.skipWhenClear", type: "toggle", label: "目标明确可跳过" },
        { key: "discovery.sufficiencyGate", type: "toggle", label: "调查充分性门禁" },
        { key: "discovery.maxRounds", type: "number", label: "最大回环（3-8 次）", min: DISCOVERY_MAX_ROUNDS.min, max: DISCOVERY_MAX_ROUNDS.max },
      ],
    },
    {
      title: "调查产物",
      fields: [
        { key: "discoveryArtifacts.schema", type: "text", label: "产物 Schema" },
        { key: "discoveryArtifacts.index", type: "toggle", label: "产物索引" },
        { key: "discoveryArtifacts.summary", type: "toggle", label: "摘要" },
        { key: "discoveryArtifacts.evidenceChain", type: "toggle", label: "证据链" },
        { key: "discoveryArtifacts.version", type: "text", label: "产物版本" },
      ],
    },
    {
      title: "设计闭环",
      fields: [
        { key: "designClosure.crossReview", type: "toggle", label: "设计交叉评审" },
        { key: "designClosure.gate", type: "toggle", label: "设计评审门禁" },
        { key: "designClosure.contractFreeze", type: "toggle", label: "设计契约冻结" },
        { key: "designClosure.designTest", type: "toggle", label: "设计测试（纳入专职测试与回归）" },
        { key: "designClosure.maxRounds", type: "number", label: "设计回退最大次数", min: 1, max: 5 },
      ],
    },
    {
      title: "角色启用（条件角色按领域与条件启用）",
      fields: CONDITIONAL.map((r) => ({
        key: `roleEnable.${r.key}`,
        type: "toggle",
        label: `${r.label}（false=强制禁用）`,
      })),
    },
    {
      title: "质量门禁回环",
      fields: [
        { key: "qualityGate.problemLevels", type: "text", label: "问题分级" },
        { key: "qualityGate.maxLoops", type: "number", label: "最大回环", min: 1, max: 10 },
        { key: "qualityGate.forceReviewExecution", type: "toggle", label: "执行类强制复核" },
        { key: "qualityGate.riskAcceptance", type: "text", label: "风险接受权限" },
        { key: "qualityGate.blockOnOpenPool", type: "toggle", label: "未关闭问题池阻断最终审核" },
        { key: "qualityGate.p3AutoAccept", type: "toggle", label: "P3 自动接受（限制范围并公示）" },
      ],
    },
    {
      title: "角色包",
      fields: [
        { key: "rolePack.enabled", type: "toggle", label: "领域角色包启用" },
        { key: "rolePack.domain", type: "text", label: "默认领域角色包" },
        { key: "rolePack.persona", type: "text", label: "角色 System Prompt 来源" },
        { key: "rolePack.modelTier", type: "text", label: "模型分级" },
      ],
    },
    {
      title: "最终全功能回归",
      fields: [
        { key: "finalRegression.enabled", type: "toggle", label: "启用最终全功能回归" },
        { key: "finalRegression.environment", type: "text", label: "回归环境" },
        { key: "finalRegression.coverage", type: "text", label: "覆盖范围" },
        { key: "finalRegression.replicaCompare", type: "toggle", label: "复刻类源目标对比" },
        { key: "finalRegression.blockIfFail", type: "toggle", label: "未通过阻断最终审核" },
        { key: "finalRegression.tiers", type: "text", label: "分层执行（core,conditional,optional）" },
        { key: "finalRegression.timeBudgetMs", type: "number", label: "回归时间预算（毫秒，默认 1800000=30 分钟）", min: 60000, max: 7200000 },
      ],
    },
    {
      title: "部署环境适配器（#54）",
      fields: [
        { key: "deployEnv.adapter", type: "select", label: "环境适配器", options: ["local_process", "container", "remote", "simulated"] },
        { key: "deployEnv.adapters", type: "text", label: "可用适配器列表（逗号分隔）" },
      ],
    },
    {
      title: "最终审核三态",
      fields: [
        { key: "finalReview.threeState", type: "toggle", label: "三态结论（合格/有条件合格/不合格）" },
        { key: "finalReview.p2UserConfirm", type: "toggle", label: "P2 风险接受需用户确认" },
        { key: "finalReview.p3LimitedScope", type: "toggle", label: "P3 限制范围并公示" },
        { key: "finalReview.dualPersonClassification", type: "toggle", label: "问题分级双人复核" },
        { key: "finalReview.independentVerification", type: "toggle", label: "独立复验写入快照" },
      ],
    },
    {
      title: "最终审核（源基线对比/调查报告/差异清单/调查闭环/设计闭环/回归/复验 7 项检查）",
      fields: [
        { key: "finalAudit.baselineCompare", type: "toggle", label: "源基线对比（复刻类对照源项目基线）" },
        { key: "finalAudit.artifactReportCheck", type: "toggle", label: "调查报告检查" },
        { key: "finalAudit.diffListCheck", type: "toggle", label: "差异清单检查" },
        { key: "finalAudit.investigationClosureCheck", type: "toggle", label: "调查闭环检查" },
        { key: "finalAudit.designClosureCheck", type: "toggle", label: "设计闭环检查" },
        { key: "finalAudit.finalRegressionCheck", type: "toggle", label: "最终回归检查" },
        { key: "finalAudit.verificationCheck", type: "toggle", label: "独立复验检查" },
      ],
    },
    {
      title: "领域模板",
      fields: [
        { key: "domainTemplate.default", type: "text", label: "默认模板" },
        { key: "domainTemplate.selectable", type: "text", label: "可选模板" },
        { key: "domainTemplate.autoDetect", type: "toggle", label: "auto 识别" },
        { key: "domainTemplate.version", type: "text", label: "模板版本" },
        { key: "domainTemplate.autoConfirmTimeout", type: "text", label: "auto 确认超时" },
      ],
    },
    {
      title: "可量化验收",
      fields: [
        { key: "acceptance.p0p1BlockRate", type: "number", label: "P0/P1 阻断率（%）", min: 0, max: 100 },
        { key: "acceptance.p2RecordRate", type: "number", label: "P2 问题池记录率（%）", min: 0, max: 100 },
        { key: "acceptance.p2CloseConfirmRate", type: "number", label: "P2 合法关闭或用户确认率（%）", min: 0, max: 100 },
        { key: "acceptance.p3TraceRate", type: "number", label: "P3 留痕率（%）", min: 0, max: 100 },
        { key: "acceptance.rollbackVersionRate", type: "number", label: "回退版本递增率（%）", min: 0, max: 100 },
        { key: "acceptance.staleRate", type: "number", label: "下游 stale 标记率（%）", min: 0, max: 100 },
        { key: "acceptance.riskAcceptRate", type: "number", label: "风险接受记录率（%）", min: 0, max: 100 },
        { key: "acceptance.signoffRate", type: "number", label: "会签留痕率（%）", min: 0, max: 100 },
        { key: "acceptance.finalAuditRate", type: "number", label: "最终审核检查率（%）", min: 0, max: 100 },
        { key: "acceptance.independentVerificationRate", type: "number", label: "独立复验执行率（%）", min: 0, max: 100 },
        { key: "acceptance.rollbackBudgetRate", type: "number", label: "回退预算执行率（%）", min: 0, max: 100 },
        { key: "acceptance.cacheKeyRate", type: "number", label: "缓存键版本完整率（%）", min: 0, max: 100 },
        { key: "acceptance.roleBoundaryRate", type: "number", label: "角色边界声明完整率（%）", min: 0, max: 100 },
      ],
    },
    roleSection("角色模型覆盖（14 核心 + 21 条件角色，独立指定）", ALL_ROLES.map((r) => r.key)),
    {
      title: "可观测性",
      fields: [
        { key: "observability.enabled", type: "toggle", label: "启用可观测性" },
        { key: "observability.panelEnabled", type: "toggle", label: "启用面板" },
        { key: "observability.refreshMs", type: "number", label: "面板刷新（毫秒）", min: 1000, max: 60000 },
        { key: "observability.exportJson", type: "toggle", label: "支持导出 JSON" },
      ],
    },
    {
      title: "成本控制",
      fields: [
        { key: "cost.summaryIndex", type: "toggle", label: "摘要 + 产物索引" },
        { key: "cost.moduleCache", type: "toggle", label: "模块级缓存" },
        { key: "cost.reuseModules", type: "toggle", label: "重复模块复用" },
        { key: "cost.tieredModels", type: "toggle", label: "按角色分级模型" },
      ],
    },
    {
      title: "提示词注入防护",
      fields: [
        { key: "security.inputIsolation", type: "toggle", label: "父会话输入隔离" },
        { key: "security.blockPrivilege", type: "toggle", label: "越权指令拦截" },
        { key: "security.blockSensitive", type: "toggle", label: "敏感指令过滤" },
        { key: "security.appendGuard", type: "toggle", label: "角色提示词追加约束" },
      ],
    },
    {
      title: "版本管理",
      fields: [
        { key: "version.personaVersion", type: "text", label: "提示词模板版本" },
        { key: "version.rollbackEnabled", type: "toggle", label: "支持回滚" },
        { key: "version.abTestEnabled", type: "toggle", label: "A/B 测试" },
      ],
    },
  ];
}

export const DEFAULTS = {
  enabled: true,
  trigger: { primary: "/team", aliases: ["/dsh-leng-team"], conflictPolicy: "useAlias", customAliases: [] },
  concurrency: { maxConcurrent: 5, queueStrategy: "fifo", queueTimeoutMs: 600000, priorityEnabled: true, keyPathReserve: true, reservedSeats: 1, rps: 8, burst: 100, platformCap: 5, rpm: 240, backoffMs: 3000, degradeThreshold: 3, degradeStrategy: "progressive", globalPauseOn429: true },
  watchdog: { enabled: true, intervalMs: 240000, similarityThreshold: 0.85, repeatRounds: 6, maxRetries429: 3, backoffMs: 3000, freezeQueueOn429: true, zombieIdleMs: 300000, action: "pause" },
  moduleSplit: { enabled: true, parsePrompt: "", mergePrompt: "", aggregateThreshold: 8, cacheEnabled: true, reuseTemplates: true },
  flow: { manualConfirm: { requirement: true, architecture: false, ui: false, final: false }, autoConfirm: false, confirmTimeoutMs: 300000, maxRework: 3, requirementChangePolicy: "routeBack", summaryTokenCap: 4000, devTimeoutMs: 1800000, taskTimeoutMs: 300000, conditionalTimeoutMs: 300000, gateWaitMs: 300000, manualConfirmDefaults: { requirement: true, architecture: false, ui: false, final: false } },
  // 修复 F1：模型护栏默认值（此前仅存在于 orchestrator 的字面量兜底中）。
  modelGuard: { enabled: true, hangingUpstreams: ["280b", "dots3-note-prev", "note3-prev"], fallbackProvider: "freehub-deepseek-v4-flash-glm5-2-3", fallbackModel: "glm-5.2" },
  conditional: { enabled: true, threeWaySignoff: true, divergencePolicy: "recordDissent", timeoutPolicy: "defaultDisable", trail: true, finalAuditCheck: true },
  rollback: { totalBudget: 10, perNodeBudget: 5, perEdgeBudget: 3, windowSizeMs: 1800000, escalationThreshold: 8 },
  verification: { enabled: true, rounds: 3, samples: 3, mirror: true, mirrorBudgetRatio: 0.1, conditionalConfirm: true, blind: true, counter: true, evidenceIndependent: true, externalBaseline: true },
  roleBoundary: { forceNonResponsibilities: true, crossRoleReport: true, conflictEscalation: true },
  cacheKey: { includeConditionalVersions: true, strictVersionCheck: true, recordHit: true, recordMiss: true },
  taskType: { enabled: true, replicateKeywords: "复刻,克隆,仿照,参照,重写,二开,还原,重建,照搬", pathPattern: "source→target", intentDetection: true },
  replicate: { forceInvestigation: true, depth: "deep", sourceReadonly: true, skipAllowed: false },
  discovery: { enabled: true, depth: "standard", evidenceSources: "内置", skipWhenClear: true, sufficiencyGate: true, maxRounds: 5 },
  discoveryTrigger: { enabled: true, mode: "auto", threshold: 6, depthMapping: "light/standard/deep", domainDefault: "领域默认", userOverride: true, recordSkip: true, maxLoops: 2, escalation: "人工裁决" },
  discoveryWeights: { goal: 3, requirement: 3, tech: 3, data: 3, risk: 3, compliance: 3, scale: 2, existing: -2, time: -1 },
  discoveryArtifacts: { schema: "内置", index: true, summary: true, evidenceChain: true, version: "1.0.0" },
  designClosure: { crossReview: true, gate: true, contractFreeze: true, designTest: true, maxRounds: 3 },
  roleEnable: Object.fromEntries(CONDITIONAL.map((r) => [r.key, true])),
  qualityGate: { problemLevels: "P0-P3", maxLoops: 3, forceReviewExecution: true, riskAcceptance: "P0/P1禁止", blockOnOpenPool: true, p3AutoAccept: true },
  rolePack: { enabled: true, domain: "software", persona: "内置", modelTier: "high/mid/low" },
  finalRegression: { enabled: true, environment: "准生产", coverage: "全部功能+设计+性能+安全+无障碍+i18n", replicaCompare: true, blockIfFail: true, tiers: "core,conditional,optional", timeBudgetMs: 1800000 },
  deployEnv: { adapter: "local_process", adapters: ["local_process", "container", "remote", "simulated"] },
  finalReview: { threeState: true, p2UserConfirm: true, p3LimitedScope: true, dualPersonClassification: true, independentVerification: true },
  finalAudit: { baselineCompare: true, artifactReportCheck: true, diffListCheck: true, investigationClosureCheck: true, designClosureCheck: true, finalRegressionCheck: true, verificationCheck: true },
  domainTemplate: { default: "software", selectable: "全部", autoDetect: true, version: "1.0.0", autoConfirmTimeout: "超时不启动" },
  acceptance: { p0p1BlockRate: 100, p2RecordRate: 100, p2CloseConfirmRate: 100, p3TraceRate: 100, rollbackVersionRate: 100, staleRate: 100, riskAcceptRate: 100, signoffRate: 100, finalAuditRate: 100, independentVerificationRate: 100, rollbackBudgetRate: 100, cacheKeyRate: 100, roleBoundaryRate: 100 },
  models: Object.fromEntries(ALL_ROLES.map((r) => [r.key, { provider: "freehub-deepseek-v4-flash-glm5-2-3", model: "glm-5.2" }])),
  roles: Object.fromEntries(ALL_ROLES.map((r) => [r.key, { personaCore: r.personaCore }])),
  observability: { enabled: true, panelEnabled: true, refreshMs: 5000, show: ["dag", "queue", "seats", "token", "watchdog", "anomaly", "rework", "handover", "rollback", "signoff", "verification", "rate", "discovery", "gate", "design", "performance", "security_test", "release", "sre", "ci_cd", "accessibility", "i18n", "cache_miss"], exportJson: true },
  cost: { summaryIndex: true, moduleCache: true, reuseModules: true, tieredModels: true },
  security: { inputIsolation: true, blockPrivilege: true, blockSensitive: true, appendGuard: true },
  version: { personaVersion: "1.0.0", rollbackEnabled: true, abTestEnabled: false },
};

/** 深度合并：数组整体替换，嵌套对象逐层合并（补全方案 14 全部配置组）。 */
function deepMerge(def, src) {
  const out = { ...(def ?? {}), ...(src ?? {}) };
  for (const k of Object.keys(def ?? {})) {
    if (
      def[k] && typeof def[k] === "object" && !Array.isArray(def[k]) &&
      src?.[k] && typeof src[k] === "object" && !Array.isArray(src[k])
    ) {
      out[k] = deepMerge(def[k], src[k]);
    }
  }
  return out;
}

/** Normalize a raw config with defaults + clamp concurrency to 1..5（V9.3 默认 5）。 */
export function normalizeConfig(raw = {}) {
  const c = deepMerge(DEFAULTS, raw);
  c.concurrency.maxConcurrent = Math.max(1, Math.min(5, Number(c.concurrency.maxConcurrent) || 5));
  c.trigger.aliases = Array.isArray(c.trigger.aliases) ? c.trigger.aliases : [];
  c.trigger.customAliases = Array.isArray(c.trigger.customAliases) ? c.trigger.customAliases : [];
  return c;
}