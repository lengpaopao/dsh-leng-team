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

/**
 * 修复 H1（第八轮「全覆盖」端到端真跑实测发现）：模块名可信度过滤。
 * DEFAULT_PARSE_RULES 的规则 2 会在中文散文里吞下整句句子片段——实测把
 * 「内部模块间通过统一的状态接口」「本文档没有列出任何页面」当成模块名，
 * 随后按该名字派发开发子任务、写模块级缓存。这里做保守过滤：
 *   - 含 `/` 或 `.` 的（文件名 / 端点路径）直接可信；
 *   - 纯 ASCII 标识符可信；
 *   - 纯中文候选限长 12 字符，且不得含常见虚词/连接词（句子片段典型特征）。
 * 这是启发式兜底，不是解析器；根治方案是把 moduleSplit.parsePrompt 接上 LLM 解析
 * （该配置项当前零消费，见第八轮报告 H2）。
 */
const CJK_FRAGMENT_MARKERS = /(的|了|是|在|和|与|并|或|通过|进行|负责|用于|支持|包括|以及|统一|没有|无需|需要|可以|这个|那个|我们|本文|任何|列出|采用|实现|完成|输出|确保|保证|同时|因此|所以|并且)/;

function isPlausibleModuleName(name) {
  const n = String(name ?? "").trim();
  if (!n) return false;
  if (n.length > 60) return false;
  if (n.includes("/") || n.includes(".")) return true; // 文件名 / 端点路径
  if (/^[A-Za-z0-9_\-\s]+$/.test(n)) return true; // 纯 ASCII 标识符
  if (n.length > 12) return false; // 过长的纯中文串几乎必然是句子片段
  if (CJK_FRAGMENT_MARKERS.test(n)) return false; // 含虚词/连接词 → 句子片段
  return true;
}

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

    // 修复 H1（第八轮全覆盖真跑实测发现）：原实现有两处结构性缺陷。
    // ① collect() 的第三分支把「功能」类名塞进 frontend（type:"page"），随后下方的 funcs
    //    二次扫描又把**同一个名字**以 type:"function" 推一次 → 同一 role+module 产出两个模块
    //    （fe:导出功能 + fn:导出功能）；实测二者 cacheKey 完全相同
    //    （frontend:导出功能#d8464698）→ 同一产物被派发两次，模块级缓存还塌缩到同一个键上。
    // ② 原 add() 只写 seen、不写任何清单，去重实际靠 `![...list].includes(name)`，seen 是空壳。
    // 现统一为「role:module 归一化去重表」，并在入口做名称可信度过滤（见 isPlausibleModuleName）。
    const seen = new Map();
    const rid = (role, type) => (type === "function" ? "fn" : role === "frontend" ? "fe" : "be");
    const push = (role, rawName, type) => {
      const nm = String(rawName ?? "").trim();
      if (!isPlausibleModuleName(nm)) return;
      const key = `${role}:${nm.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.set(key, { id: `${rid(role, type)}:${nm}`, role, module: nm, type });
    };

    const collect = (rawName) => {
      const nm = String(rawName ?? "").trim();
      if (!nm) return;
      if (/\.(html|jsx|tsx|vue|js|ts)$/i.test(nm) || /页面|page/i.test(nm)) push("frontend", nm, "page");
      else if (/接口|api|endpoint/i.test(nm) || /^\/[\w\-./]+$/.test(nm)) push("backend", nm, "interface");
      else if (/功能|function|feature/i.test(nm)) push("frontend", nm, "function");
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

    // 兜底：设计文档中未显式列出页面/接口时，仍生成一个「整体应用」前端模块，
    // 保证开发阶段始终有实际代码产出，避免 dev 阶段空转。
    // H1 注：修复前规则 2 几乎总能命中中文散文，兜底形同虚设（其存在意义被架空）；
    // 加入可信度过滤后，兜底按设计意图生效。
    if (seen.size === 0 && text.trim().length > 0) {
      // 保持历史 id `fe:app` 不变（该 id 自 V9.3 起固定，避免对外契约漂移）
      seen.set("frontend:整体应用", { id: "fe:app", role: "frontend", module: "整体应用", type: "page" });
    }
    // 保持原契约的输出分组顺序：页面 → 接口 → 功能（sort 稳定，组内维持文档出现顺序）
    const typeOrder = { page: 0, interface: 1, function: 2 };
    return { modules: [...seen.values()].sort((a, b) => (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3)) };
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
