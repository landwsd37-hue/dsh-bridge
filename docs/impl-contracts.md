# Kimi Work × DSH 桥接 — 实现契约（勘察定稿，动手前的权威参考）

来源：`C:\Users\island\Desktop\deepseek\_work\app-dsh\node_modules\@deepseek-ai\`（DSH 0.2.0-rc.2 完整未打包源码树）+ 本机已装 `@michengai/dsh-im-connect@0.1.77`。

## 1. DSH 宿主服务契约

### 1.1 注册 HTTP 路由
`@deepseek-ai/dsh-host-webserver/lib/index.js:177`
```js
register(route) // route = { kind: 'exact'|'prefix', path, handler }
// → 返回 disposer () => void；重复 (kind,path) 直接 throw
// 查找：exact 表命中优先，否则前缀表 longest-prefix-wins
```
handler 收到底层 `(req, res)`（裸 node http），可自行读 body、写任意状态码。im-connect 实证可行：
`C:\Users\island\.dsh\profiles\desktop\node_modules\@michengai\dsh-im-connect\lib\manager.js:648`
```js
const basePath = '/api/dsh-im-connect';
const dispose = webServer.register({ kind: 'prefix', path: basePath, handler: async (req, res) => { ... } });
if (typeof dispose === 'function') this.apiDisposers.push(dispose);
```
写请求自检（manager.js:52 `validateApiMutation`）：非 GET/HEAD 必须带 header `API_CLIENT_HEADER === '1'` 且 `content-type: application/json`，否则 403/415。body 用 `readApiJsonBody(req, MAX_API_BODY_BYTES)` 累积字节后再 UTF-8 解码。

### 1.2 建会话 + 注入任务（"自动执行"核心）
`@deepseek-ai/dsh-agent/lib/index.js:451` `async create(options)`；`index.js:464` `async resume(options)`；`index.js:412` `withoutInitiator(operation)`。
im-connect 实证调用点 `...\dsh-im-connect\lib\engine\router.js:537`：
```js
const create = () => agents.create({
  sessionId,
  meta: { cwd: config.cwd || process.cwd(), ...(agentPreset ? { agentPreset } : {}) },
  agentOptions: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
  setup: this.presetSetup(channelId),
});
```
→ 返回 handle，`.agent` 是 live agent。恢复历史：`agents.resume({ resumeSessionId, agentOptions, setup })`（router.js:504）。
注入一轮用户消息（router.js 与 gateway.js:634-638）：
```js
const controller = this.ctx.get('sessionController');
await controller.prompt({ requestId, sessionId: binding.sessionId, mode: 'queue', content }, signal);
```
或对 live agent 追加：`binding.handle?.agent.followup(message)`（router.js:335-340）。
其它：`ctx.agents.get(sessionId)`（router.js:488）、`ctx.get('sessionController').resolveAgent(sessionId)` → `{agent}`（router.js:482）。

### 1.3 presetSetup（router.js:673-704，逐字照抄的形态）
```js
presetSetup(channelId, savedPreset, restoring = false) {
  const ctx = this.ctx;
  const preset = savedPreset || config.agentPreset || 'standard';
  const permission = config.permissionPreset;
  return async (agentCtx, explicitAgent) => {
    const agent = explicitAgent ?? agentCtx.agent;   // 旧版单参数契约读作用域属性
    const session = agent?.session;
    if (ctx.agentPresets?.mount) await ctx.agentPresets.mount(agentCtx, preset);
    if (permission && !preservePermission) {
      try { if (agent?.session) ctx.permissionPresets.set(agent.session, permission); }
      catch (error) { this.log(`[router] 无法应用权限 ${permission}: ...`); }
    }
  };
}
```
服务名：`ctx.agentPresets`（`.mount`）、`ctx.permissionPresets`（`.set(session,preset)` / `.defaultPreset`）。

### 1.4 把会话挂到 GUI 工作区（router.js:632-664）
```js
let workspaces = this.ctx.get?.('workspaceRegistry')?.list?.() ?? [];
if (workspaces.length === 0) { /* 当前没有工作区，网页点不开会话 */ return; }
for (const workspace of workspaces.filter(w => samePath(w.path, preferred))) {
  try { await workspace.attachSession(sessionId); return; } catch (e) { lastError = ...; }
}
```
即 `workspaceRegistry.list()` → `[{ path, attachSession(sessionId) }]`；只有已注册工作区能挂。

### 1.5 默认模型
`...\dsh-im-connect\lib\engine\agent-options.js:12`
```js
export function readHostDefaultModel(ctx) {
  try { return ctx.get?.('agentDefaultModel')?.currentSelection?.(); } catch { return undefined; }
}
```
`resolveImAgentOptions` 铁律：**provider/model 不允许空字符串**，空则抛错（"请先在设置里选择模型"）。

### 1.6 插件入口模板（im-connect `lib/index.js:1-60`）
```js
import Schema from '@deepseek-ai/schemastery';
export const name = 'dsh-im-connect';
export const inject = ['webServer','credentials','agents','agentPresets','agentDefaultModel','llm','permissionPresets'];
export const Config = Schema.object({ stateDir: Schema.string().default(''), ... });
export function apply(ctx, config) {
  ctx.effect(() => {...; return cleanup;}, 'label');
  const stateDir = config.stateDir !== '' ? config.stateDir
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-im-connect');
  ctx.logger(name).info(line);
}
```

## 2. 安装/装载契约（决定"要不要重启 DSH"）

- bundle 必须在 package.json 里声明 `dsh.bundle.patch`，否则 `dsh-plugin-manager` 抛 `ManagementFailure('not-bundle')`（`lib/index.js:1786`）。
- `cordis.patch.yml`（im-connect 原文）：
  ```yaml
  # 把 IM 助理插入 profile。
  - insert:
      - id: im-connect
        name: '@michengai/dsh-im-connect'
  ```
- `installBundle` 流程（`dsh-plugin-manager/lib/index.js:1778-1808`）：pnpm 装 → 比对 package.json 新增依赖 → `not-bundle` 校验 → `evaluatePluginCompatibility` → `selectBundle(name, true)` → **`if (Object.hasOwn(before, name)) return "restart-required"`，即全新包会走 `reload()` 热加载**。
- `reload()`（`lib/index.js:2031`）= `reconcileProfilePatches(root, readProfilePatches('dsh', profile), 'dsh', requiredIds)`；外层 `configure()` 用 `hmr.runExclusive(apply)`；`change()` 里 `application = ctx.get('hmr') !== undefined ? "applied" : "restart-required"`。**本 profile 装了 `include:hmr`（@deepseek-ai/dsh-hmr），所以是 "applied"——新插件可热装载，不必重启宿主。**
- `parseInstallSpec`（`lib/types/install-spec.js:57`）：支持 `file:<绝对路径>`、`<绝对路径>`、`link:`、registry 名、git/tarball。**本地绝对路径 = kind 'path'**，直接读该目录 package.json。
- **兼容闸门**：`evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot/lib/index.js:286-313`）只检查名为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peerDependencies，与运行版本 0.2.0-rc.2 比对（`semver.satisfies(..., {includePrerelease:true})`）。**只要不声明任何 dsh-* peer，就必然通过**；`@deepseek-ai/schemastery` 属于 `@deepseek-ai/` 但不以 `dsh-` 开头，不被检查。
- `C:\Users\island\.dsh\profiles\desktop\node_modules\@deepseek-ai\` 里**只有 schemastery**；其它 `@deepseek-ai/*` 由运行时拦截层（app-boot ResolutionRouter）映射到安装树。
- 当前 profile package.json：`dependencies` 15 项（@linxin666/dsh-web-all、@liustack/modsearch、@michengai/*、billion-context、dsh-claude-style、dsh-context、dsh-cost-meter、dsh-mnemon、dsh-theme-mineradio、dshmarket）；`dsh.profile.bundles` 18 项（顺序见该文件）。
- im-connect package.json 关键字段：`"type":"module"`、`"main":"lib/index.js"`、`"exports"` 映射 `./cordis.patch.yml` 与 `./package.json`、`"engines":{"node":"^22.19.0 || >=24.0.0"}`、`"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`、`peerDependencies` 里 `@deepseek-ai/schemastery":"^3.18.2"`、`peerDependenciesMeta.react.optional`。
- `plugin_manager action=list_bundles` 在 danger-full-access 下**无需审批即成功**。
- DSH CLI：`C:\Users\island\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（`ELECTRON_RUN_AS_NODE=1` 跑 `...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`）。

## 3. Kimi Work 侧事实（补勘察）

- 运行体：`C:\Users\island\AppData\Roaming\kimi-desktop\daimon-bundle\app\daimon\`（`@kimi/daimon` v0.6.7，`"type":"module"`，`engines.node >=24.15.0 <25`，依赖 `@moonshot-ai/agent-core@0.15.7`）。`dist/src/**` 里 **grep 不到** `mcpServers` / `bearerTokenEnvVar` / `startupTimeoutMs` → MCP 客户端在 `@moonshot-ai/agent-core` 或 kimi-code vendor 里，**Kimi 侧 MCP 传输细节仍未证实**（因此桥接必须同时提供纯 REST 备用通道）。
- 会话/文件状态目录 `C:\Users\island\AppData\Roaming\kimi-desktop\kimi-agent\`：
  - `file-edit-journal.json`（129KB）= 撤销日志，结构 `{"agent:main:main:conversation:<uuid>": "<内层 JSON 字符串>"}`，内层 `{"version":1,"turns":[{"turnId","entries":[{"path","before","after","existedBefore","afterDeleted"}]}]}` → **可按 turn 列出被写入/删除的文件及内容**，是 hook 兜底的天然数据源。
  - `user-picked-workspace-folders.json` = `{"C:\\Users\\island\\Desktop\\工作\\数字基建时期\\扫码神器调研":"2026-10-16T01:57:13.860Z"}`（Kimi 当前唯一挂载的工作区）。
  - `trusted-attachment-paths.json` = `{路径: 时间戳}`（Temp 附件 + message-queue-assets）。
  - 其它：`plugin-meta.json`、`plugin-gateway-managed.json`、`created-workspaces.json`、`conversation-*.json`、`goal-completions.json`。
- 本机 node：`C:\Users\island\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` = **v24.21.0**，`zlib.zstdDecompressSync` 存在。
- DSH 会话日志：`C:\Users\island\.dsh\sessions\<工作区编码目录>\<sessionId>\session.v4.jsonl.zstd`，工作区编码形如 `--C-Users-island-Desktop-deepseek--`。**是多帧 zstd 追加**（`zstdDecompressSync` 只解第一帧，实测 1 行）→ **放弃从磁盘读事件**，任务状态改用进程内 `sessionController.inspect()`。

## 4. 已定实现决策（动手依据）

1. DSH 侧插件用**纯 ESM JavaScript**（`lib/*.js`），无 TS 构建；**不声明任何 `@deepseek-ai/dsh-*` peer**（绕开兼容闸门）；只 import `@deepseek-ai/schemastery` + `node:` 内置。
2. 包名 `dsh-kimiwork-bridge`；`dsh.bundle.patch = ./cordis.patch.yml`，patch 插入 `id: kimiwork-bridge`。
3. HTTP 前缀 `/api/kimiwork`：`GET /health`、`POST /mcp`（MCP JSON-RPC：initialize / tools/list / tools/call）、`POST /dispatch`、`POST /deliver`、`GET /tasks`、`GET /task/:id`。
4. 鉴权：自动生成 token 存 `<stateDir>/token`，请求带 `Authorization: Bearer <token>`（或 `?token=`）。**不调用** `connection.requestRejection`（那是给浏览器调用方用的）。
5. **主触发 = MCP 工具**（Kimi 侧 `mcpServers` 指向 `http://127.0.0.1:<port>/mcp`）；**备用 = REST**（Kimi skill 用 curl/node 脚本直调 `/dispatch`）。
6. 每次派发**新建独立会话**，`sessionId = kw:<taskId>`；派发后调用 `workspaceRegistry` 把会话挂到目标工作区，便于在 Web GUI 里点开。
7. 文件交付两级：**路径清单必存**（绝对路径 + size + mtime + sha256 记进 task.json），**关键文件另存快照**到 `<stateDir>/inbox/<taskId>/files/`。
8. 兜底 hook：Kimi 插件声明 `Stop` hook，跑本地脚本扫描配置根目录里"自上次同步后有改动"的文件并 POST 到 `/deliver`；状态文件记 last-run。
9. 项目目录 `C:\Users\island\Desktop\deepseek\kimiwork-bridge\`，子目录 `dsh-plugin\`、`kimi-plugin\`、`tools\`、`_spec\`。
10. DSH 侧安装优先走 `plugin_manager action=install_bundle target=file:<绝对路径>`（应热装载免重启）；失败再退回手工放 `profiles/desktop/node_modules/` + 改 package.json。
