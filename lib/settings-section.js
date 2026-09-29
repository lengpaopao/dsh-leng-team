/**
 * Expert settings page for dsh-leng-team.
 *
 * Registers the settings namespace + section so all parameters render in the
 * Settings → Expert page, with validation and illegal-value clamping.
 */

import { buildSchemasteryConfig, buildSettingsSections, normalizeConfig } from "./config.js";

export const SETTINGS_NAMESPACE = "dsh-leng-team";

/**
 * Register the settings namespace on the host.
 *
 * 0.1.7 platform API: `ctx.settings.register(ns, schema, options)` (SettingsProvider).
 * Older versions used `installSection(owner, ns, schema, entry, hooks)` — keep it as a
 * compatibility fallback so the same code runs on both.
 *
 * The client "专家设置" page reads the namespace through `settingsScope.bind({namespace})`.
 */
export function registerSettingsSection(ctx, config) {
  const schemaFn = buildSchemasteryConfig();
  // 修复 F5：删除死占位代码 `const base = normalizeConfig({}).flow ? undefined : undefined;`
  //（三元两分支同值，且 base 从未被使用，第 28 行用的是字面量 base: undefined）。

  // register() API (0.1.7 SettingsProvider): returns owner scope {get, watch, update, replace}
  if (typeof ctx.settings?.register === "function") {
    ctx.settings.register(SETTINGS_NAMESPACE, schemaFn, {
      base: undefined,
      applies: "live",
      validate: (section) => {
        const normalized = normalizeConfig(section);
        const check = schemaFn["~standard"];
        if (check) {
          const r = check.validate(normalized);
          if (r.issues && r.issues.length) return r.issues[0].message ?? "配置校验失败";
        }
        return undefined;
      },
    });
    console.log("[dsh-leng-team] settings namespace registered via ctx.settings.register");
    return;
  }

  // installSection() compatibility (older dsh-settings)
  if (typeof ctx.settings?.installSection === "function") {
    ctx.settings.installSection(
      ctx,
      SETTINGS_NAMESPACE,
      schemaFn,
      undefined,
      {
        setSource: () => {},
        onChange: () => { /* persisted by settings store */ },
        validate: (section) => {
          const normalized = normalizeConfig(section);
          const check = schemaFn["~standard"];
          if (check) {
            const r = check.validate(normalized);
            if (r.issues && r.issues.length) return r.issues[0].message ?? "配置校验失败";
          }
          return undefined;
        },
      }
    );
    console.log("[dsh-leng-team] settings section installed via installSection");
    return;
  }

  console.log("[dsh-leng-team] settings API unavailable: register/installSection not found");
}

export function LengTeamSettingsPage(props) {
  return {
    type: "LengTeamSettingsPage",
    props: {
      title: "dsh-leng-team（专家页面）",
      note: "提示：修改看门狗周期、并发上限等参数后建议重启插件，定时器配置方可完全生效。并发上限固定 1-5（默认 5），输入大于 5 自动强制修正为 5。",
      sections: buildSettingsSections(),
    },
  };
}
