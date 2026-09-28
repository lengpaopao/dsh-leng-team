/**
 * Tool definitions for dsh-leng-team.
 *
 * Exposes one canonical tool (leng_team) that the parent agent calls, plus the
 * command router for /team / /dsh-leng-team.
 */

export const LENG_TEAM_TOOL_NAME = "leng_team";

export const LENG_TEAM_TOOL_DEFINITION = {
  name: LENG_TEAM_TOOL_NAME,
  description:
    "启动 dsh-leng-team 工程团队流水线（V9.3）：任务类型识别→调查员→条件启用三方会签→产品经理→需求→架构→安全→UX/UI→设计评审门禁→按页面/接口拆分的并行开发（全局并发≤5，令牌桶+429 状态机自动降级）→代码评审→测试→运维→文档→最终审核（独立复验三态）。内置4分钟语义看门狗、全局回退预算、事务快照。用户说目标/任务即可触发。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "动作：start（启动项目）/ status / flow / template / signoff / rollback / verify / ratelimit / selftest / confirm / reject / reset / pause / resume / version / observability",
        enum: ["start", "status", "flow", "template", "signoff", "rollback", "verify", "ratelimit", "selftest", "confirm", "reject", "reset", "pause", "resume", "version", "observability"],
      },
      goal: {
        type: "string",
        description: "项目目标（action=start 时必填）",
      },
      key: {
        type: "string",
        description: "确认键（action=confirm / reject 时必填，如 requirement/architecture/ui/final）",
      },
      ok: {
        type: "boolean",
        description: "确认结果（action=confirm 时必填 true；action=reject 时必填 false）",
      },
    },
    required: ["action"],
  },
  // dsh-tools (web profile) 硬性要求：output 必须为 { schema, render, presentationMeta? }
  output: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean", description: "操作是否成功" },
        message: { type: "string", description: "人类可读结果（status/template/signoff/rollback/verify/ratelimit/reset 等）" },
      },
    },
    render: (_args, value) => {
      const text = typeof value === "string"
        ? value
        : (value?.message ?? (value?.ascii ?? JSON.stringify(value)));
      return [{ type: "text", text: String(text ?? "ok") }];
    },
  },
};
