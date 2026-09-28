/**
 * dsh-leng-team — cordis plugin entry point.
 *
 * 14-core + 21-conditional-role full-stack engineering team (V9.3) with:
 *  - /team and /dsh-leng-team slash commands (+ custom aliases, conflict-safe)
 *  - global 5-sub-session concurrency (seat pool + queue, 1-5 configurable)
 *  - 4-minute semantic watchdog (dead-loop / 429 / zombie / seat recovery)
 *  - discovery investigator + conditional-activation 3-way signoff (V9.3)
 *  - global rollback budget + oscillation detection + token bucket / 429 state machine
 *  - independent final verification (3-state, blind review, mirror re-check)
 *  - transactional snapshot + breakpoint recovery
 *  - expert settings page
 *  - observability, cost control, injection protection, resource cleanup
 */

import { createRequire } from "node:module";
import { normalizeConfig, buildSchemasteryConfig } from "./config.js";
import { LengTeamOrchestrator } from "./orchestrator.js";
import { registerSettingsSection } from "./settings-section.js";
import { buildCommandHandler } from "./commands.js";
import { LENG_TEAM_TOOL_NAME, LENG_TEAM_TOOL_DEFINITION } from "./tools.js";

/** dsh 平台把中文命令参数的 UTF-8 字节按系统代码页（GBK）解码成乱码，这里尝试恢复成正确中文。 */
function recoverMojibake(raw) {
  if (!raw || !/[^\x00-\x7F]/.test(raw)) { console.log("[dsh-leng-team] recover: ascii-only"); return raw; }
  try {
    const iconv = createRequire(import.meta.url)("iconv-lite");
    console.log("[dsh-leng-team] recover: iconv loaded gbk=" + iconv.encodingExists("gbk"));
    const recovered = Buffer.from(iconv.encode(raw, "gbk")).toString("utf-8");
    if (recovered === raw) { console.log("[dsh-leng-team] recover: identical"); return raw; }
    const cjk = (recovered.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk === 0) { console.log("[dsh-leng-team] recover: cjk=0 reject"); return raw; }
    const ff = (recovered.match(/\uFFFD/g) || []).length;
    console.log("[dsh-leng-team] recover: cjk=" + cjk + " ff=" + ff + " ratio=" + (recovered.length ? (ff / recovered.length).toFixed(2) : 0));
    if (ff / recovered.length < 0.4) { console.log("[dsh-leng-team] recover: ACCEPT rec=" + JSON.stringify(recovered)); return recovered; }
    console.log("[dsh-leng-team] recover: ratio high reject"); return raw;
  } catch (e) { console.log("[dsh-leng-team] recover: CATCH " + String(e?.message ?? e)); }
  return raw;
}

export const name = "dsh-leng-team";
export const inject = ["agents", "subagents", "settings", "tools", "sessions", "workspaceRegistry", "agentDefaultModel", "llm"];

export const Config = buildSchemasteryConfig(); // schemastery schema（可调用 + ~standard + toJSON）

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return;


  const orch = new LengTeamOrchestrator(ctx, cfg);

  // 会话删除 -> 若删除的是当前项目会话则立即全局重置（销毁子会话、清席位队列、停看门狗）
  try {
    if (typeof ctx.on === "function") {
      ctx.on("session/disposed", (session) => {
        const dsid = session && session.id;
        if (dsid) orch._parentDisposed(dsid);
      });
      console.log("[dsh-leng-team] session/disposed listener armed");
    }
  } catch (e) { console.log("[dsh-leng-team] session/disposed listener err:", String(e?.message ?? e)); }

  // ---- runtime probe: discover session-creation capabilities (0.1.7) ----
  try {
    const ss = typeof ctx.get === "function" ? ctx.get("sessions") : null;
    console.log("[dsh-leng-team] sessions svc keys:", ss ? Object.keys(ss).join(",") : "null");
    if (ss && typeof ss.binding === "function") {
      const b = ss.binding("__probe__");
      console.log("[dsh-leng-team] sessions.binding keys:", b ? Object.keys(b).join(",") : "null", "| session keys:", b && b.session ? Object.keys(b.session).join(",") : "null");
    }
    const sa = typeof ctx.get === "function" ? ctx.get("subagents") : null;
    console.log("[dsh-leng-team] subagents keys:", sa ? Object.keys(sa).join(",") : "null");
    const h = typeof ctx.get === "function" ? ctx.get("harness") : null;
    console.log("[dsh-leng-team] harness keys:", h ? Object.keys(h).join(",") : "null");
    if (h && h.handle && typeof h.handle === "function") { console.log("[dsh-leng-team] harness.handle: function"); }
    const ss2 = typeof ctx.get === "function" ? ctx.get("sessions") : null;
    if (ss2 && ss2.store && typeof ss2.store === "object") {
      console.log("[dsh-leng-team] sessions.store keys:", Object.keys(ss2.store).join(","));
      const proto = Object.getPrototypeOf(ss2.store);
      if (proto) console.log("[dsh-leng-team] sessions.store proto:", Object.getOwnPropertyNames(proto).join(","));
    }
    if (ss2 && typeof ss2.binding === "function") {
      try {
        const b = ss2.binding("__probe__");
        console.log("[dsh-leng-team] sessions.binding keys:", b ? Object.keys(b).join(",") : "null");
        if (b && b.session) console.log("[dsh-leng-team] binding.session keys:", Object.keys(b.session).join(","));
        if (b && typeof b.session === "object" && b.session) {
          const sp = Object.getPrototypeOf(b.session);
          if (sp) console.log("[dsh-leng-team] binding.session proto:", Object.getOwnPropertyNames(sp).join(","));
        }
      } catch (e) { console.log("[dsh-leng-team] binding probe err:", String(e?.message ?? e)); }
    }
    if (sa && sa.continuations) {
      console.log("[dsh-leng-team] subagents.continuations keys:", Object.keys(sa.continuations).join(","));
    }
  } catch (e) { console.log("[dsh-leng-team] sessions probe err", String(e?.message ?? e)); }


  // ---- 1. Canonical tool (web-profile register contract: single definition object) ----
  ctx.tools.register({
    ...LENG_TEAM_TOOL_DEFINITION,
    execute: async (args, exec) => {
      const action = args?.action ?? "start";
      const goal = args?.goal ?? "";
      switch (action) {
        case "start":
          if (!goal) throw new Error("请提供项目目标");
          return orch.start({ goal }, exec);
        case "status": return { ok: true, ...orch.status, flow: orch.flowScene() };
        case "flow": return { ok: true, flow: orch.flowScene() };
        case "template": return { ok: true, taskType: orch.taskType, nodes: (orch.taskTemplate?.nodes ?? []).length, enabled: (orch.activeRun?.enabledSlots ?? []) };
        case "signoff": return { ok: true, signoff: orch.activeRun?.signOff ?? orch.conditional?.signoffs?.slice(-1)[0] ?? null };
        case "rollback": return { ok: true, rollback: orch.rollback.snapshot() };
        case "verify": return { ok: true, verification: orch.activeRun?.verification ?? null };
        case "ratelimit": return { ok: true, rate: orch.rateLimiter.snapshot() };
        case "selftest": { const st = orch.selfTest(); return { ok: !!st?.ok, ...st }; }
        case "confirm": {
          const key = (args?.key ?? "").toLowerCase();
          if (!key) throw new Error("请提供确认环节 key：requirement|architecture|ui|final");
          return orch.confirm(key, args?.ok !== false);
        }
        case "reject": {
          const key = (args?.key ?? "").toLowerCase();
          if (!key) throw new Error("请提供确认环节 key：requirement|architecture|ui|final");
          return orch.confirm(key, false);
        }
        case "reset": orch.reset(); return { ok: true, message: "已重置" };
        case "pause": orch.pause(); return { ok: true, message: "已暂停" };
        case "resume": orch.resume(); return { ok: true, message: "已恢复" };
        case "version": return { ok: true, data: orch.version() };
        case "observability": return { ok: true, data: orch.observability.snapshot() };
        default: throw new Error(`未知动作：${action}`);
      }
    },
  });

  // ---- 2. Expert settings page (0.1.7 adapter: old installSection removed; isolate for now) ----
  try {

    registerSettingsSection(ctx, cfg);
  }
  catch (e) { console.log("[dsh-leng-team] settings section skipped (0.1.7 api):", String(e?.message ?? e)); }

  // ---- 3. Slash commands: /team, /dsh-leng-team, custom aliases ----
  const handler = buildCommandHandler(orch, ctx);
  const aliasSet = new Set([cfg.trigger.primary, ...(cfg.trigger.aliases ?? []), ...(cfg.trigger.customAliases ?? [])].filter(Boolean));

  try {
    ctx.inject(["commands"], (cmdCtx) => {
      const norm = (raw) => raw.replace(/^\/+/, "").trim().toLowerCase();
      const registerOne = (rawName) => {
        const nm = norm(rawName);
        if (!nm) return;
        try {
          // 启动时唯一性校验：与已注册命令冲突时按 conflictPolicy 处理（useAlias=记录并继续 / block=跳过 / force=覆盖注册）
          let existing = [];
          try { existing = Array.isArray(cmdCtx.commands.list(nm)) ? cmdCtx.commands.list(nm) : []; } catch (e) { existing = []; }
          const conflict = existing.some((c) => c.name === nm);
          if (conflict) {
            if (cfg.trigger.conflictPolicy === "block") {
              console.log(`[dsh-leng-team] 命令冲突（${nm} 已被其他命令占用），按策略 block 跳过注册`);
              return;
            }
            console.log(`[dsh-leng-team] 命令冲突（${nm} 已被其他命令占用），按策略 ${cfg.trigger.conflictPolicy} 继续`);
          }
          cmdCtx.commands.register({
            name: nm,
            description:
              "dsh-leng-team 工程团队：总指挥 + 14 核心 + 21 条件角色（V9.3）。子命令：selftest / start <目标> / template / signoff / rollback / verify / ratelimit / status / reset / pause / resume / config / observability / version。",
            input: { syntax: "selftest | start <目标> | template | signoff | rollback | verify | ratelimit | status | reset | pause | resume | config | observability | version", hint: "不带参数进入团队模式并引导输入项目目标；输入\"自检/自我测试/诊断\"可逐环节自检" },
            async handler(invocation) {
          try {
            let rawInput = invocation?.rawInput ?? "";
            const recovered = recoverMojibake(rawInput);
            if (recovered !== rawInput) {
              rawInput = recovered;
              console.log("[dsh-leng-team] recovered rawInput:", JSON.stringify(rawInput));
            }
            console.log("[dsh-leng-team] command invoked:", JSON.stringify(rawInput), "as", nm);
            const full = `${nm} ${rawInput}`.trim();
            // 用户口径：/team <目标> 直接建项目。非已知子命令的非空输入一律视为项目目标，
            // 改写为 start <目标> 复用下方启动分支。
            const t0 = rawInput.trim();
            const KNOWN_SUB = /^(start|开发|selftest|self|自检|自我测试|诊断|template|signoff|rollback|verify|ratelimit|status|flow|reset|pause|resume|config|observability|version|poll|confirm|reject|plan)\b/;
            if (t0 && !KNOWN_SUB.test(t0)) {
              rawInput = `start ${t0}`;
            }
            // start runs async; ack immediately, pipeline continues in background
            if (/^(start|开发)/.test(rawInput.trim())) {
              const goal = rawInput.trim().replace(/^(start|开发)\s*/, "").trim();
              if (goal) {
                // 幂等锁：已有流水线运行中则直接拒绝（同步预检查，避免 await 阻塞）
                if (orch.running || orch.startPending) {
                  const run = orch.activeRun;
                  if (orch.running && run) {
                    return { kind: "error", text: `已有流水线运行中（${run.id ?? "?"}）：${run.goal ?? ""}\n如需另起项目，请先 /team reset 再 /team start <新目标>。` };
                  }
                  return { kind: "error", text: "项目会话已建立，流水线即将启动，请稍候片刻；如需另起项目，请先 /team reset。" };
                }
                // 复用检测：同一会话已用于 team 项目 -> 要求新建会话（每次测试/项目使用新会话）
                const curSid = invocation?.agent?.session?.id ?? invocation?.agent?.id ?? null;
                if (orch.checkReuse(curSid)) {
                  const last = orch.lastGoal ? `（最近项目：${orch.lastGoal.slice(0, 30)}）` : "";
                  return { kind: "error", text: `当前会话已用于 team 项目${last}。每次测试请先新建会话（Ctrl+Alt+N 或侧边栏 + 新会话），再输入 /team <目标>。` };
                }
                // 第一序列：项目会话 = 当前触发会话改名为项目目标（HARNESS UI 顶级可见、项目名命名）。
                // 平台无 host 端 create-session API（已探查：harness=null、sessions.store 为 KV 存储），
                // 因此项目会话即当前会话改名；改名必须排在流水线启动之前。
                try {
                  const sess = invocation?.agent?.session;
                  let st = null;
                  try { if (typeof ctx.get === "function") st = ctx.get("sessionTitle"); } catch (e) { /* optional */ }
                  const title = goal.slice(0, 60);
                  if (sess && st && typeof st.rename === "function") {
                    st.rename(sess, title);
                    console.log("[dsh-leng-team] session renamed (project):", title);
                  } else {
                    console.log("[dsh-leng-team] sessionTitle unavailable, skip rename");
                  }
                } catch (e) { console.log("[dsh-leng-team] rename err:", String(e?.message ?? e)); }
                if (typeof orch.recordResult === "function") {
                  try { orch.recordResult(`项目会话已建立：${goal}（当前会话=项目会话/总指挥，流水线即将启动）`); } catch (e) { /* optional */ }
                }
                // 立即注入一条「项目会话已建立」用户消息 -> 产生真实会话活动事件 -> 侧边栏立刻出现项目会话
                // （0.1.7 侧边栏只响应会话活动事件：user/message 等；rename/refreshList/命令均不重渲染）
                try {
                  const injSid = invocation?.agent?.session?.id ?? invocation?.agent?.id ?? null;
                  const agsvc = typeof ctx.get === "function" ? ctx.get("agents") : null;
                  const agent = agsvc && typeof agsvc.get === "function" ? agsvc.get(injSid) : null;
                  if (agent && typeof agent.followup === "function") {
                    let msg = null;
                    try {
                      const req = createRequire(import.meta.url);
                      const llmmod = req("@deepseek-ai/dsh-llm");
                      if (llmmod && typeof llmmod.createUserMessage === "function") {
                        msg = llmmod.createUserMessage({ content: [{ type: "text", text: `【项目会话已建立】目标：${goal}
本会话已作为项目会话（总指挥/中央调度台），14 核心 + 21 条件角色专家流水线正在后台运行。请勿直接执行该项目任务，由专家流水线全权负责；你仅需确认项目会话已建立。可输入 /team status 查看进度、/team flow 查看专家流程图。` }], source: { kind: "user" } });
                      }
                    } catch (e2) { /* fallback below */ }
                    if (!msg) {
                      msg = {
                        role: "user",
                        id: "team-banner-" + Math.random().toString(36).slice(2),
                        content: [{ type: "text", text: `【项目会话已建立】目标：${goal}
本会话已作为项目会话（总指挥/中央调度台），14 核心 + 21 条件角色专家流水线正在后台运行。请勿直接执行该项目任务，由专家流水线全权负责；你仅需确认项目会话已建立。可输入 /team status 查看进度、/team flow 查看专家流程图。` }],
                        source: { kind: "user" }
                      };
                    }
                    agent.followup(msg);
                    console.log("[dsh-leng-team] injected project banner (followup) for sidebar activity:", injSid);
                  } else {
                    console.log("[dsh-leng-team] agent.followup unavailable: svc=", !!agsvc, "agent=", !!agent);
                  }
                } catch (e) { console.log("[dsh-leng-team] inject banner err:", String(e?.message ?? e)); }

  // NOTE: the previous "team status" activity trigger was removed — it recorded an extra
  // "team·已完成" entry in the conversation stream. The followup banner inject above already
  // produces the session activity event the sidebar needs (verified: project session appears instantly).

                // 第二步：延迟启动流水线（4 秒），先让前端渲染「项目会话已建立」与新标题，
                // 再开始子代理活动——满足"先建立会话，再运行 team"的 UI 时序。
                orch.setStartPending(goal);
                setTimeout(() => {
                  try {
                    const p = orch.start({ goal }, { agent: invocation.agent });
                    if (p && typeof p.catch === "function") p.catch(() => {});
                    console.log("[dsh-leng-team] pipeline launched in background:", goal);
                  } catch (e) {
                    console.log("[dsh-leng-team] start fire err:", String(e?.message ?? e));
                  }
                  orch.clearStartPending();
                }, 800);
                return { kind: "success", text: `项目会话已建立：${goal}（当前会话已作为项目会话/总指挥，流水线即将启动）\n可输入 /team status 查看进度，/team flow 查看专家流程图。` };
              }
              return { kind: "error", text: "请提供项目目标，例如：/team start 开发一个任务管理系统。" };
            }
            // sync subcommands (handler is async; must await to read the real result)
            const result = await handler(full, { agent: invocation.agent });
            console.log("[dsh-leng-team] handler result:", JSON.stringify(result));
            // poll 无变化：静默，不向会话写消息（避免 3 秒轮询刷屏）
            if (/^poll$/.test(rawInput.trim()) && result?.ok === true && result?.data === null) {
              return { kind: "success" };
            }
            if (result?.message) return { kind: "success", text: result.message };
            if (result?.ascii) return { kind: "success", text: result.ascii };
            if (result?.data) return { kind: "success", text: formatData(result.data) };
            return { kind: "success", text: "dsh-leng-team 已就绪。" };
          } catch (e) {
            console.log("[dsh-leng-team] command error:", String(e?.message ?? e));
            return { kind: "error", text: `dsh-leng-team 命令执行出错：${String(e?.message ?? e)}` };
          }
        },
        });
      } catch (e) {
        console.log("[dsh-leng-team] register failed for", nm, ":", String(e?.message ?? e));
      }
    };

    for (const a of aliasSet) registerOne(a);
    console.log("[dsh-leng-team] commands registered:", JSON.stringify([...aliasSet]));
    try {
      const probe = cmdCtx.commands.list("__probe__");
      console.log("[dsh-leng-team] probe names:", probe.map((c) => c.name).join(","));
      console.log("[dsh-leng-team] probe has team:", probe.some((c) => c.name === "team"), "| has de_coi:", probe.some((c) => c.name === "de_coi"));
    } catch (e) {
      console.log("[dsh-leng-team] probe err:", String(e?.message ?? e));
    }
  });
  } catch (e) {
    console.log("[dsh-leng-team] commands inject failed:", String(e?.message ?? e));
  }

  // ---- 4. Watchdog event wiring（web 端用 cordis 事件风格 ctx.on，payload 为单对象） ----
  ctx.effect(() => ctx.on("agent/status", ({ agent, status }) => {
    if (status === "error") {
      orch.observability.recordAnomaly("agent_error", `Agent ${agent?.id} 状态异常`);
    }
  }));
  // 429 事件（存在则监听，不存在静默跳过）
  try {
    ctx.effect(() => ctx.on("agent/request-error", ({ agent, error }) => {
      const msg = String(error?.message ?? error ?? "");
      if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
        const taskId = agent?.id;
        orch.watchdog.record429(taskId, error);
        orch.rateLimiter.record429();
        orch.observability.record("warning", "429", `Agent ${taskId} 触发限流（并发降至 ${orch.rateLimiter.concurrency}）`);
      }
    }));
  } catch { /* 该事件不存在时忽略 */ }

  // ---- 5. Expose（web 端无 expose 服务；能力经 leng_team 工具暴露，此处省略） ----

  // ---- 6. Lifecycle cleanup (resource release / memory-leak prevention) ----
  ctx.on("dispose", () => {
    orch.reset();
    orch.watchdog.clear();
  });
}

function formatData(data) {
  if (data?.plugin || data?.personaVersion) {
    return `dsh-leng-team v${data.plugin ? "0.1.0" : ""} · 提示词模板 v${data.personaVersion} · ${data.roles ?? 13} 角色 · 并发≤${data.concurrency} · 429状态=${data.rateState ?? "-"} · 回退=${data.rollbackUsed ?? 0}/10 · 看门狗 ${(data.watchdogIntervalMs / 60000).toFixed(0)} 分钟`;
  }
  return JSON.stringify(data, null, 2);
}
