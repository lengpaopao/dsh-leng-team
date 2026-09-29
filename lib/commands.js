/**
 * Command router for /team and /dsh-leng-team (fully equivalent) plus custom aliases.
 *
 * Supported subcommands:
 *   /team                       trigger plugin, init team mode, prompt for goal
 *   /team start <目标>          trigger + start a project
 *   /team status                plain-text status of 14 core + 21 conditional roles + module tasks
 *   /team template              show task type + DAG template + conditional roles
 *   /team signoff               show condition-activation signoff sheet
 *   /team rollback              show global rollback budget
 *   /team verify                show independent verification records
 *   /team ratelimit             show token bucket / 429 state
 *   /team selftest | 自检 | 诊断 | test   run a subsystem self-test
 *   /team reset                 global reset (queue/seats/rollback/verification)
 *   /team pause / resume        pause / resume scheduling
 *   /team config                open the expert settings page
 *   /team observability         open the observability panel
 *   /team version               show persona template + plugin version
 */

import { ROLE_MAP } from "./roles.js";

/** Format a self-test report into readable lines. */
function formatSelfTest(st) {
  const ok = st.checks.filter((c) => c.ok).length;
  const bad = st.checks.filter((c) => !c.ok).map((c) => c.name);
  return `dsh-leng-team 自检: ${ok}/${st.checks.length} 项通过` + (bad.length ? `, 异常: ${bad.join(";")}` : ", 全部环节正常");
}

export function parseCommand(text) {
  const t = (text ?? "").trim();
  return {
    text: t,
    args: t.split(/\s+/).filter(Boolean).slice(1), // everything after the command token
  };
}

/**
 * Build the command handler for the orchestrator.
 * @param {LengTeamOrchestrator} orch
 */
function launchProject(orch, ctx, goal, exec) {
  if (orch.running || orch.startPending) {
    return { ok: false, message: "已有流水线运行中或即将启动，请先 /team reset 再 /team start <新目标>。" };
  }
  // 第一序列：项目会话 = 当前触发会话改名为项目目标（HARNESS UI 顶级可见、项目名命名）。
  // 平台无 host 端 create-session API（已探查：harness=null、sessions.store 为 KV 存储），
  // 因此项目会话即当前会话改名；改名必须排在流水线启动之前。
  try {
    const sess = exec?.agent?.session;
    let st = null;
    try { if (ctx && typeof ctx.get === "function") st = ctx.get("sessionTitle"); } catch (e) { /* optional */ }
    const title = String(goal).slice(0, 60);
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

  // 立即触发一次轻量会话活动（team status），让前端刷新并应用新标题。
  // 背景：HARNESS 前端标题/侧边栏依赖会话活动事件渲染；若等流水线的
  // 主会话深度求索（可达几十秒）才显示项目会话，体验很差。
  try {
    const sid = exec?.agent?.session?.id ?? exec?.agent?.sessionId;
    const rc = typeof ctx?.get === "function" ? ctx.get("remote") : null;
    if (sid && rc?.commands && typeof rc.commands.execute === "function") {
      rc.commands.execute(sid, "team status");
      console.log("[dsh-leng-team] trigger session activity for title refresh:", sid);
    }
  } catch (e) { console.log("[dsh-leng-team] activity trigger err:", String(e?.message ?? e)); }

  // 第二步：延迟启动流水线（4 秒），先让前端渲染「项目会话已建立」与新标题，
  // 再开始子代理活动——满足"先建立会话，再运行 team"的 UI 时序。
  orch.setStartPending(goal);
  setTimeout(() => {
    try {
      const p = orch.start({ goal }, exec);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) { console.log("[dsh-leng-team] start err:", String(e?.message ?? e)); }
    orch.clearStartPending();
  }, 4000);
  return { ok: true, message: `项目会话已建立：${goal}（当前会话已作为项目会话/总指挥，流水线即将启动）` };
}

export function buildCommandHandler(orch, ctx) {
  let lastPollTs = 0;
  return async function handle(text, exec) {
    const { args } = parseCommand(text);
    const sub = args[0]?.toLowerCase();

    switch (sub) {
      case undefined:
        // bare /team — initialize team mode and ask for a goal
        orch.observability.record("info", "trigger", "团队模式已触发");
        if (orch.activeRun?.goal && orch.running) {
          return { ok: true, message: "已有进行中的项目，输入 /team start <目标> 另起新项目，或 /team status 查看进度。" };
        }
        return { ok: true, message: "已进入 dsh-leng-team 团队模式。请告诉我项目目标（例如：/team start 开发一个任务管理系统）。" };

      case "selftest":
      case "test":
      case "自检":
      case "诊断":
        return { ok: true, message: formatSelfTest(orch.selfTest()) };

      case "start":
      case "开发":
        {
          const goal = args.slice(1).join(" ");
          if (!goal) return { ok: false, message: "请提供项目目标，例如：/team start 开发一个任务管理系统。" };
          return launchProject(orch, ctx, goal, exec);
        }

      case "template":
        {
          const tpl = orch.taskTemplate ?? null;
          const cond = orch.conditional?.candidates ?? [];
          const lines = [`任务类型：${orch.taskType ?? "software"}  模板节点：${tpl?.nodes?.length ?? 0}  回退边：${tpl?.rollbackEdges?.length ?? 0}`];
          lines.push(`条件角色候选：${cond.length ? cond.map((x) => x.roleSlotId + "(" + (x.enabled ? "启用" : "未启用") + ")").join("、") : "无"}`);
          lines.push(`已启用条件角色：${(orch.activeRun?.enabledSlots ?? []).length ? orch.activeRun.enabledSlots.join("、") : "无"}`);
          return { ok: true, message: lines.join("\n") };
        }

      case "signoff":
        {
          const so = orch.activeRun?.signOff ?? orch.conditional?.signoffs?.slice(-1)[0] ?? null;
          if (!so) return { ok: true, message: "当前没有会签单（尚未运行流水线）。" };
          const lines = [`会签单 #${so.id}（版本 ${so.version}）：`];
          for (const cand of so.candidates ?? []) lines.push(`  ${cand.roleSlotId}: ${cand.decision}（${cand.reason}）签名=总指挥${cand.signedBy?.orchestrator ? "✓" : "✗"} 调查${cand.signedBy?.discovery ? "✓" : "✗"} 产品${cand.signedBy?.goal ? "✓" : "✗"}`);
          return { ok: true, message: lines.join("\n") };
        }

      case "rollback":
        {
          const rb = orch.rollback;
          const lines = [`全局回退预算：${rb.usedBudget}/${rb.totalBudget}（窗口 ${Math.round((rb.windowSize ?? 0) / 60000)}min，升级阈值 ${rb.escalationThreshold}）`];
          if (rb.escalated) lines.push(`  ⚠️ 已升级人工裁决：${rb.escalationReason ?? ""}`);
          for (const [k, v] of Object.entries(rb.perEdge ?? {})) lines.push(`  边 ${k}: ${v}/${rb.perEdgeBudget}`);
          return { ok: true, message: lines.join("\n") };
        }

      case "verify":
        {
          const rec = orch.activeRun?.verification ?? null;
          if (!rec) return { ok: true, message: "当前没有独立复验记录（尚未到最终审核）。" };
          const lines = [`独立复验（${rec.conclusion}，置信度 ${rec.confidence ?? "?"}）：`];
          lines.push(`  轮次=${rec.rounds ?? 0} 抽样=${(rec.samples ?? []).length} 镜像=${(rec.mirrorArtifacts ?? []).length} 反方质询=${(rec.counterArguments ?? []).length}`);
          return { ok: true, message: lines.join("\n") };
        }

      case "ratelimit":
        {
          const rl = orch.rateLimiter;
          const lines = [`令牌桶：RPS=${rl.bucket.rate}/${rl.bucket.capacity} RPM=${rl.minute.limit} 并发=${rl.concurrency} 状态=${rl.state}`];
          if (rl._429Count > 0) lines.push(`  近 60s 429 计数=${rl._429Count}（降级阈值 3 / 全局暂停 6）`);
          return { ok: true, message: lines.join("\n") };
        }

      case "poll":
        {
          const last = orch.lastResult || null;
          const ts = last ? last.ts : 0;
          if (ts && ts === lastPollTs) return { ok: true, data: null }; // 无变化不重复返回
          lastPollTs = ts;
          return { ok: true, data: last ? { ts, text: last.text } : null };
        }

      case "status":
        {
          const s = orch.status;
          const lines = [`dsh-leng-team 状态：${s.running ? "运行中" : "待机"}${s.paused ? "（已暂停）" : ""}`];
          lines.push(`- 并发席位：${s.seats.length}/${s.capacity}  队列：${s.queue.length}  限流冻结：${s.frozen}`);
          lines.push(`- 当前阶段：${s.stage}`);
          // 专家流程图摘要（已完成 / 当前 / 待处理）
          try {
            const flow = orch.flowScene();
            lines.push("— 专家流程图 —");
            for (const n of flow.nodes) {
              const mark = n.state === "done" ? "✅" : n.state === "current" ? "▶️" : n.state === "error" ? "❌" : n.state === "blocked" ? "⛔" : "⬜";
              lines.push(`  ${mark} ${n.id} ${n.name}${n.note ? `（${n.note}）` : ""}`);
            }
            if (flow.watchdog) lines.push(`  🐕 ${flow.watchdog.id} 看门狗（${flow.watchdog.note}）`);
          } catch (e) { lines.push(`  （流程图渲染失败：${String(e?.message ?? e)}）`); }
          if (s.seats.length) for (const seat of s.seats) lines.push(`  - 席位${seat.seat}: ${seat.role}${seat.module ? ` (${seat.module})` : ""}`);
          // 统一回环规则：问题池摘要
          try {
            const iss = orch.issues?.summary?.();
            if (iss) {
              lines.push(`- 问题池：总计 ${iss.total}，已关闭 ${iss.closed}，未关闭 ${iss.open}（P0=${iss.bySeverity.P0} P1=${iss.bySeverity.P1} P2=${iss.bySeverity.P2} P3=${iss.bySeverity.P3}）返工 ${iss.reworkTotal}`);
              for (const p of (iss.pool ?? []).slice(0, 8)) lines.push(`  ⚠️ ${p}`);
            }
          } catch (e) { /* optional */ }
          if (s.queue.length) for (const q of s.queue.filter((x) => x.status === "queued").slice(0, 20)) lines.push(`  - 排队: ${q.role}${q.module ? ` (${q.module})` : ""}`);
          return { ok: true, message: lines.join("\n") };
        }

      case "plan":
        {
          const num = Number(args[1]);
          if (!num) return { ok: false, message: "用法：/team plan <方案编号>（例如 /team plan 2）" };
          const run = orch.activeRun;
          if (!run) return { ok: false, message: "当前没有进行中的项目。" };
          run.planChoice = num;
          if (run.pendingConfirm === "plan") run.pendingConfirm = null;
          orch.observability.record("info", "plan", "用户已选择方案 " + num);
          return { ok: true, message: "已选择方案 " + num + "，流水线继续。" };
        }

      case "answer":
      case "回答":
        {
          const num = Number(args[1]);
          const ans = args.slice(2).join(" ").trim();
          if (!num || !ans) return { ok: false, message: "用法：/team answer <疑问编号> <答复>（例如 /team answer 1 支持游客模式）" };
          const run = orch.activeRun;
          if (!run) return { ok: false, message: "当前没有进行中的项目。" };
          run.questionAnswers = run.questionAnswers || {};
          run.questionAnswers[num] = ans;
          if (run.pendingConfirm === "questions") {
            run.pendingConfirm = null;
            orch.observability.record("info", "questions", "已收到疑问 " + num + " 的答复：" + ans);
          } else {
            orch.observability.record("info", "questions", "记录疑问 " + num + " 答复：" + ans);
          }
          return { ok: true, message: "已记录疑问 " + num + " 的答复。" };
        }

      case "confirm":
        {
          const key = args[1]?.toLowerCase();
          if (!key) return { ok: false, message: "用法：/team confirm <requirement|architecture|ui|final>" };
          return orch.confirm(key, true);
        }

      case "reject":
        {
          const key = args[1]?.toLowerCase();
          if (!key) return { ok: false, message: "用法：/team reject <requirement|architecture|ui|final>" };
          return orch.confirm(key, false);
        }

      case "flow":
        return { ok: true, data: orch.flowScene() };

      case "reset":
        {
          const all = args.includes("--all");
          orch.reset({ all });
          return { ok: true, message: all ? "已全局重置（含会话标记清除，本会话可重新 start）" : "已全局重置：队列清空、子会话销毁、席位释放、回退预算与独立复验归零。" };
        }

      case "pause":
        orch.pause();
        return { ok: true, message: "已暂停新任务入队与调度。" };

      case "resume":
        orch.resume();
        return { ok: true, message: "已恢复调度。" };

      case "config":
        {
          const sub = (args[1] ?? "").toLowerCase();
          if (sub === "get") return { ok: true, data: orch.configGet() };
          if (sub === "set") {
            const json = args.slice(2).join(" ");
            if (!json) return { ok: false, message: "用法：/team config set <JSON>（例如 /team config set {\"watchdog\":{\"intervalMs\":240000}}）" };
            let patch;
            try { patch = JSON.parse(json); } catch (e) { return { ok: false, message: "config set: JSON 解析失败 — " + String(e?.message ?? e) }; }
            const next = orch.configSet(patch);
            return { ok: true, message: "配置已保存并生效。", data: next };
          }
          if (sub) return { ok: false, message: "用法：/team config get | /team config set <JSON>" };
          return { ok: true, message: "请在「设置 → 专家页面」中修改 dsh-leng-team 的配置项；或使用 /team config get|set。" };
        }

      case "observability": {
        const snap = orch.observability.snapshot();
        // 方案 17：可观测性附带可量化验收指标（支持 JSON / Markdown 导出）
        try { snap.acceptance = typeof orch.acceptanceSnapshot === "function" ? orch.acceptanceSnapshot() : null; } catch (e) { /* optional */ }
        return { ok: true, message: "可观测性面板（含可量化验收指标）", data: snap };
      }

      case "version":
        return { ok: true, data: orch.version() };

      default: {
        const joined = args.join(" ").toLowerCase();
        // "team 进行自我测试，查看每一个环节是否正常" etc → run self-test
        if (/自检|自我测试|诊断|selftest|self[\s-]?test|环节.*正常/.test(joined)) {
          return { ok: true, message: formatSelfTest(orch.selfTest()) };
        }
        if (orch.running) {
          return { ok: false, message: `已有流水线运行中。可用：selftest / flow / status / template / signoff / rollback / verify / ratelimit / confirm / reset / pause / resume / config / observability / version` };
        }
        const goal = args.join(" ");
        if (goal) {
          // 直接启动，避免 handle() 递归（parseCommand 会剥掉首个 token，递归会无限死循环→爆栈）
          return launchProject(orch, ctx, goal, exec);
        }
        return { ok: false, message: "未知子命令。" };
      }
    }
  };
}
