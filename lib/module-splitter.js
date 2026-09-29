/**
 * Module splitter — decomposes UI/UX design outputs into fine-grained
 * development sub-tasks (one page / one interface / one function each).
 *
 * No single dev session handles all pages. Each module becomes an independent
 * sub-task sharing the global 5-session seat pool. Defects rework only their own
 * module. Outputs are cached (module-level cache) and similar modules reuse
 * templates (cost control).
 */

const DEFAULT_PARSE_RULES = [
  // Page-like: map.html, map2.html, user_center.html ...
  /([A-Za-z0-9_\-.\u4e00-\u9fa5]+\.(?:html|jsx|tsx|vue|js|ts))\b/gi,
  // Named interface/page/function (CJK-aware, no trailing \b which fails after CJK)
  /([A-Za-z0-9_\-.\u4e00-\u9fa5]+(?:接口|页面|功能))/gi,
  // Path-like endpoints
  /(\/[\w\-.\u4e00-\u9fa5\/]+)/gi,
];

/** Default parse prompt used when config.parsePrompt is empty. */
export const DEFAULT_PARSE_PROMPT =
  "解析 UI/UX 设计文档，提取页面清单（.html/.jsx/.tsx/.vue/.js/.ts）与接口清单（接口/端点名），" +
  "每个页面/接口输出为一行：类型|名称。仅输出清单，不要解释。";

export class ModuleSplitter {
  constructor(config = {}) {
    this.config = config;
    // 方案 12.1：缓存键静态因子（领域模板版本 / 角色包版本 / 模型 ID / 调查产物版本）。
    // 静态因子变化（换模板、换模型、升版本）时即使回退版本未变，缓存键也必须变化，禁止复用旧缓存。
    const c = config ?? {};
    const dt = c.domainTemplate ?? {};
    const ver = c.version ?? {};
    const models = c.models ?? {};
    const art = c.discoveryArtifacts ?? {};
    this.staticFp = [dt.version || "1.0.0", ver.personaVersion || "1.0.0", models.product?.model || "glm-5.2", art.version || "1.0.0"].join("|");
  }

  /**
   * Extract a module list from a design document (plain text).
   * @param {string} designDoc
   * @param {{frontend?:string[],backend?:string[]}} [hints] optional explicit hints
   * @returns {{modules: Array<{id:string, role:'frontend'|'backend', module:string, type:string}>}}
   */
  parse(designDoc = "", hints = {}) {
    if (!this.config.enabled) {
      return { modules: [] };
    }

    const seen = new Set();
    const add = (type, role, name) => {
      const key = `${role}:${name.toLowerCase()}`;
      if (!name || seen.has(key)) return;
      seen.add(key);
    };

    const frontend = [];
    const backend = [];

    const collect = (name) => {
      if (/\.(html|jsx|tsx|vue|js|ts)$/i.test(name) || /页面|page/i.test(name)) {
        add("page", "frontend", name);
        if (![...frontend].includes(name)) frontend.push(name);
      } else if (/接口|api|api\//i.test(name) || /^\/[\w\-/]+$/i.test(name)) {
        add("interface", "backend", name);
        if (![...backend].includes(name)) backend.push(name);
      } else if (/功能|function|feature/i.test(name)) {
        add("function", "frontend", name);
        if (![...frontend].includes(name)) frontend.push(name);
      }
    };

    // 1. hints take precedence
    for (const n of hints.frontend ?? []) collect(n);
    for (const n of hints.backend ?? []) collect(n);

    // 2. regex extraction from the doc
    const text = String(designDoc ?? "");
    for (const re of DEFAULT_PARSE_RULES) {
      const matches = text.matchAll(re);
      for (const m of matches) {
        if (m[1]) collect(m[1].trim());
      }
    }

    const modules = [
      ...frontend.map((name) => ({ id: `fe:${name}`, role: "frontend", module: name, type: "page" })),
      ...backend.map((name) => ({ id: `be:${name}`, role: "backend", module: name, type: "interface" })),
    ];
    // 功能型模块（页面/接口之外按功能拆分，方案 2.3 拆分维度：页面/接口/功能）
    const funcs = [];
    for (const re of DEFAULT_PARSE_RULES.slice(1, 2)) {
      const matches = String(designDoc ?? "").matchAll(re);
      for (const m of matches) {
        if (m[1] && /功能|function|feature/i.test(m[1])) {
          const nm = m[1].trim();
          if (nm && !funcs.includes(nm)) funcs.push(nm);
        }
      }
    }
    for (const name of funcs) modules.push({ id: `fn:${name}`, role: "frontend", module: name, type: "function" });
    // 兜底：设计文档中未显式列出页面/接口时，仍生成一个「整体应用」前端模块，
    // 保证开发阶段始终有实际代码产出，避免 dev 阶段空转。
    if (modules.length === 0 && String(designDoc ?? "").trim().length > 0) {
      modules.push({ id: "fe:app", role: "frontend", module: "整体应用", type: "page" });
    }
    return { modules };
  }

  /** Cache key with version context (cost control + 方案 12.1：回退后版本递增、版本不匹配不得复用）。 */
  cacheKey(module, versions = {}, ctx = {}) {
    if (!this.config.cacheEnabled) return null;
    const base = `${module.role}:${module.module}`.toLowerCase();
    const ver = versions?.global ?? 0;
    if (ver === 0) return null; // #42：版本为 0 不缓存（版本不匹配不得复用）
    // #40：缓存键分层——第一层强约束（base+全局版本+静态因子+运行因子），
    // 第二层弱约束（条件角色产物版本全量）；命中规则见编排层（Level1 全匹配可复用，Level2 部分不匹配标记过期重验）。
    let h = 0x811c9dc5;
    const runFp = [ctx.taskType ?? "", ctx.depth ?? ""].filter(Boolean).join("|");
    const strong = base + "|v" + ver + "|" + this.staticFp + "|" + runFp;
    for (let i = 0; i < strong.length; i++) { h ^= strong.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const weak = JSON.stringify(versions ?? {});
    for (let i = 0; i < weak.length; i++) { h ^= weak.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return { key: `${base}#${h.toString(16)}`, strong, weak, versions: versions ?? {} };
  }
}
