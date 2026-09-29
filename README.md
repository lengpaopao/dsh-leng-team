# dsh-leng-team

14-role（总指挥 + 23 专业角色，含条件启用角色）软件研发团队插件（DSH），支持 software / data_analysis / research / content / document / generic 领域模板。

V9.3 流水线：
**触发 → 总指挥初始化 + 原始需求快照 → 产品经理轻量目标理解 → 任务类型/任务性质识别 → 调查触发评估 → 调查员（复刻强制/充分性门禁回环）→ 条件启用三方会签 → 产品经理正式定义 → 需求分析师 → 架构师 + 技术负责人 → 数据（条件）→ 安全 → UX + UI → 设计交叉评审 + 设计安全复审 + 设计评审门禁 + 契约冻结 → 总指挥拆分 → 全局任务队列（默认 5 并发席位池，P0-P3 优先级 + 预留席位）→ 模块开发子会话（页面/接口/功能）→ 父会话汇总整合 → 代码评审 → 专职测试 → 性能/安全测试（条件）→ 运维 → DevOps/发布（条件）→ 部署安全审查 → 部署验证/冒烟 → SRE（条件）→ 文档 → 上线前安全复查 → 最终全功能回归 → 最终审核（独立复验三态）**

## 触发方式

| 命令 | 说明 |
| --- | --- |
| `/team` 或 `/dsh-leng-team` | 触发团队模式，引导输入项目目标 |
| `/team start <目标>` | 启动项目 |
| `/team status` | 查看 14 角色 + 模块子任务状态（纯文本） |
| `/team flow` | 查看专家流程图 |
| `/team reset` | 全局重置（清队列、销毁子会话、释放席位） |
| `/team pause` / `/team resume` | 暂停 / 恢复调度 |
| `/team version` | 查看提示词模板与插件版本 |
| `/team selftest` | 逐环节自检（角色包、DAG、会签、回退预算、缓存键等） |
| `/team confirm <key>` / `/team reject <key>` | 人工确认 / 拒绝（正式模式默认等待人工拍板） |
| `/team observability` | 可观测性面板数据 |
| `/team config` | 打开专家配置页 |

`/dsh-leng-team` 与 `/team` 完全等价，并支持自定义别名（专家页配置，启动时唯一性校验，冲突按策略处理）。

## 核心能力

- **全局并发硬上限 5（1–5 可配）**：席位池统一管理主角色会话与开发拆分模块会话，超限任务自动排队；队列策略 fifo / priority，P0/P1 预留席位，P0 可抢占排队位置。
- **429 防护**：全局令牌桶（RPS/RPM）+ 单角色配额 + 429 状态机（NORMAL→BACKOFF→FROZEN_NEW→GLOBAL_PAUSE→RECOVER），并发自动降级（5→3→2/1）并渐进恢复，全局暂停期间快照落盘。
- **4 分钟语义看门狗**：语义相似度多轮比对识别死循环（非超时）、429 退避与冻结、僵尸会话席位回收、销毁前事务快照、异常告警。
- **调查员机制**：discovery 插槽前置到产品经理正式定义之前；任务类型识别七类（greenfield/replicate/migrate/refactor/enhancement/research/generic）；调查触发评估 force/auto/skip（9 维评分卡）；调查充分性门禁（≤2 轮回环，超限升级）；复刻/迁移/重构/二开强制调查禁止跳过，输出 12 项复刻清单。
- **条件启用三方会签**：总指挥 + 调查员 + 产品经理三方会签，分歧记录异议/升级人工确认，超时默认禁用并记录风险接受，最终审核检查。
- **产品经理两阶段**：轻量目标理解（调查前）+ 正式定义（调查后）；产品经理不直接派发执行任务。
- **设计闭环**：设计交叉评审 → 设计安全复审 → 设计评审门禁 → 设计契约冻结 + Mock → 设计测试与回退；设计版本纳入缓存键与回退版本管理。
- **全局回退预算**：总预算 10 / 单节点 5 / 单边 3 / 滑动窗口 30min / 升级阈值 8；跨节点震荡自动识别；超限强制人工裁决。
- **缓存键完整化**：领域模板/方案/契约/设计/角色包/模型/输入/依赖/调查深度/证据/源基线/任务类型/条件角色产物版本/会签/回退/独立复验版本聚合 hash；版本不匹配不复用，命中与失效留痕。
- **独立复验强化**：角色隔离、≥3 轮抽样、镜像复验、盲审、反方质询、证据链独立、外部对照（复刻对照源基线）；最终审核三态（合格/有条件合格/不合格）。
- **事务化快照 + 断点恢复**：席位/队列/模块/全部阶段产物原子化持久化，重启可恢复；不能恢复标记 rebuild。
- **可量化验收**：P0/P1 阻断率、P2 记录率与合法关闭率、P3 留痕率、回退版本递增率、风险接受记录率、会签留痕率、最终审核闭环检查率 7 项 100% 全量进入可观测性面板。
- **无微型办公室、无动画、无 `/team world`**：仅业务真相 + 专家流程图。

## 安装

```bash
dsh plugin --profile web add <路径或tarball>
```

注册后在 web profile 的 `package.json` 的 `dsh.profile.bundles` 加入 `dsh-leng-team`，重启 web 生效。

已在 **web profile 实际激活验证通过**：
- `dsh --profile web --dump-config` 可见 `- id: dsh-leng-team, name: dsh-leng-team`；
- 启动 web 后 `web_start.log` 正常打印 `dsh web: http://127.0.0.1:3080/?token=…`，无 `plugin tree failed to load` 报错；
- 全部 lib/client 文件 `node --check` 通过。

### web 环境 API 适配（重要，改动时勿回退）

web profile 的 cordis/dsh 运行时与 headless 不同，本插件已按 web 契约实现：

| 项 | 说明 |
| --- | --- |
| `Config` | 必须是 **Standard Schema** 对象（`Config["~standard"].validate`）。用 dsh 内置 `@deepseek-ai/schemastery`（Schema 实例同时满足：可调用 + 有 `~standard` + 有 `toJSON`），经 `createRequire` 解析；ESM 下不可用裸 `require`。 |
| 顶级/嵌套对象 | 全部加 `.default(...)`，保证空对象不抛 `ValidationError`。 |
| `ctx.tools.register` | 只接受**单个定义对象** `{ name, description, parameters, execute, output }`，`output` 必须含 `{ schema, render, presentationMeta? }`。 |
| `ctx.settings` | `installSection(owner, ns, schema, entry, hooks)`：`owner` 传 `ctx`、`schema` 传 schemastery 实例、`entry` 传 `undefined`（无 composition base）；`installSection` 内部已注册 namespace，勿再单独 `register` 同名 ns。schema 必须用 schemastery：普通函数无 `toJSON`（describe 崩）、zod 对象不可调用（resolve 崩）。 |
| agent 事件 | 用 `ctx.on('agent/status' | 'agent/request-error', ({agent,status,error})=>…)`（cordis 事件风格、单 payload 对象），不用 `ctx.agents.on`。 |
| 不依赖的服务 | `slots`、`expose` 在 web 服务端上下文不可用（会导致 `pending` 或 `without inject`），本插件不注入/不使用。 |

## 排障 / Troubleshooting

### 1. web 访问提示 "dsh web authentication required; reopen the URL printed by dsh web"（401）

dsh web 的认证机制（源码级结论，见 `@deepseek-ai/dsh-client-connection`）：

- 启动时 web 进程持有 **launchToken**，打印的访问 URL 形如 `http://127.0.0.1:3080/?token=<launchToken>`。
- 首次访问：仅当请求满足 **GET + 路径 `/` + 且仅一个 token 参数 + 带 Host 头 + token 与 launchToken 严格相等**（恒定时间字节比较）时，服务端 303 重定向到 `./` 并 `Set-Cookie` 一个**签名会话 cookie**（绑定 authority、HttpOnly、SameSite=Strict、带过期时间）。
- 后续访问：凭该 cookie 通过（`isAuthenticated`），无需再带 token。
- 任一条件不满足 → 一律 401。

常见 401 原因与处理：

| 原因 | 现象 | 处理 |
| --- | --- | --- |
| **URL token 与当前实例 launchToken 不一致**（最常见：日志 URL 来自旧实例/守护残留；或有多个 web 进程抢 3080） | 复制日志 URL 仍 401 | 完全停止监听 3080/8787 的 node 进程 → 重新 `dsh web --no-open` → 等 12-15s → **以最新 `web_start.log` 的 URL 为准**原样打开 |
| 请求缺 Host 头（裸 IP/代理/某些 curl 场景） | HTTP 直连 401 | 确保请求带 `Host: 127.0.0.1:3080` |
| 浏览器残留旧 cookie（端口/域名变化后 authority 不匹配） | 换 URL 后仍 401 | 清除该站点 cookie 后重开 URL |
| token 已过期/被轮换 | 之前能用、现在 401 | 重启 web 取最新 URL |

排查步骤：

```powershell
# 1) 确认 3080 监听与进程
Get-NetTCPConnection -LocalPort 3080 -State Listen
# 2) 杀掉占用（含 8787）
Get-NetTCPConnection -LocalPort 3080,8787 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
# 3) 重启并取最新 URL（token 以本次日志为准）
Start-Process -FilePath dsh.cmd -ArgumentList 'web','--no-open'
Start-Sleep -Seconds 15
Get-Content "$env:USERPROFILE\.dsh\web_start.log" -Encoding UTF8 | Select-String 'dsh web:'
```

> 提示：web GUI 仅用于 `/team selftest`、专家设置页与流程图。插件的功能健康度不依赖 GUI——本仓库断言基线（204 项）与冒烟测试直接在安装副本上运行，均可独立验证。

### 2. 插件改动后不生效

- 改动 `lib/` 或 `client/` 源码后，**必须同步到安装副本**并重启 web。推荐一键脚本（V2026092906 起提供）：

```bash
# 在【源码仓库】目录运行（安装副本不含 scripts/，不要在副本里跑）
npm run sync-web          # 同步源码→副本 + 双份默认值一致性校验 + SHA256 校验
npm run sync-web -- --restart   # 同步后自动重启 dsh web
```

- 忘了同步的典型症状：`/team version` 的 release 仍是旧值、`/team selftest` 新增检查项不出现。

### 3. 端口被占用 / 插件重复加载

- `3080` 为 web 主端口，`8787` 为辅助端口；多实例会互相抢端口，导致日志 URL 与请求目标不一致（见第 1 节）。
- 确认 bundles 注册唯一：web profile `package.json` 的 `dsh.profile.bundles` 中 `dsh-leng-team` 只出现一次。

## Known Limitations

- software 模板为研发流水线主链；data_analysis / research / content 走领域化流水线，强叙事创作（小说、剧本）不在内置模板范围。
- 全局并发默认 5，长链任务排队时间会变长；并发 5 不会必然触发 429，但风险高于并发 3，已配令牌桶 + 429 状态机自动降级。
- 快照保存业务状态（含全部阶段产物）；无动画、无办公室。
- `slots` UI 导航入口在 web 服务端不注册；专家页参数经 `settings` 系统读取/写入。
- 条件启用会签超时默认禁用条件角色，可能漏启用；最终审核检查并记录风险接受。
- 独立复验在单模型架构下只能相对独立，不能绝对独立。
- 全局回退预算超限必须人工裁决，可能增加交付时间。
- 中文长命令参数受平台编码限制，稳定以英文子命令为主。
