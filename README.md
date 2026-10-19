# Kimi Work ↔ DSH 桥接

让 **Kimi Work** 把活派给本机的 **DSH（DeepSeek Harness）** 去跑，并把 Kimi 这边产出的文件送到 DSH 手上。

- 派发是**异步**的：调用成功 = 任务已入列，DSH 会新开一个独立会话立刻开跑。
- 桥接只在**本机回环**上监听，除了令牌还有**目录白名单**——只允许在白名单里的目录下开会话。

> A bridge that lets Kimi Work dispatch tasks to your local DSH (DeepSeek Harness) as independent sessions, hand over files, and read status back.

---

## 一、它由两半组成

| 半边 | 位置 | 作用 |
| --- | --- | --- |
| **DSH 侧插件** `dsh-kimiwork-bridge` | [`dsh-plugin/`](dsh-plugin) | 在 DSH 的 web 服务上挂 `/api/kimiwork`（REST + MCP 双通道）：建独立会话、注入任务、盯状态、收文件快照。 |
| **Kimi 侧插件** `dsh-bridge` | [`kimi-plugin/`](kimi-plugin) | 给 Kimi Work 挂 5 个 MCP 工具 + 技能 + 斜杠命令 + CLI 兜底，负责把活派出去。 |
| **部署 / 自测脚本** | [`tools/`](tools) | 一键部署任一侧、MCP 探针、冒烟与集成测试。 |

两边通过 **MCP（JSON-RPC）** 对接，但中间隔了一层 stdio shim：

```
Kimi Work ──stdio──▶ kimi-plugin/scripts/dsh-bridge-mcp.cmd   （Kimi 拉起的子进程）
                          │  tools/call 转发
                          ▼
                     DSH /api/kimiwork/mcp   （HTTP，本机回环）
```

- **端点不写死**。`dsh web` 的端口是**运行期**决定的。DSH 侧插件启动时把真实基址、端口、pid、令牌写进 `~/.dsh/dsh-kimiwork-bridge/endpoint.json`，Kimi 侧每次调用都重新读它。优先级：
  `--endpoint` > `$DSH_KIMMIWORK_ENDPOINT` > `endpoint.json` > 静态兜底 `http://127.0.0.1:19387/api/kimiwork`（只在端点文件缺失时命中）。
- **为什么走 stdio 而不是让 Kimi 直接连 HTTP**：插件挂在 DSH 自己的 web 服务上，`prefix` 路由在 dsh web 的 cookie 鉴权层**之前**命中，所以 HTTP 理论上通。但 Kimi 的 HTTP MCP 客户端行为没法在本机自证；stdio 这条能整条本地实测（`tools/probe-mcp.mjs --stdio`），出问题也能直接看到 shim 的 stderr。

## 二、数据怎么流

```
Kimi Work ──MCP tools/call──▶ DSH  /api/kimiwork/mcp
                                    │
                                    ├─ sessionController.create()   → 新建独立会话 kw:<时间戳>
                                    ├─ sessionController.prompt()   → 把任务+文件路径注入这轮对话
                                    ├─ ctx.on('agent/status')       → 等它不 running 了
                                    └─ sessionController.inspect()  → 抓最后一次助手回复当摘要

Kimi Work ──POST /deliver────▶ 文件快照落 ~/.dsh/dsh-kimiwork-bridge/inbox/<task_id>/files/
```

DSH 侧所有运行时数据都在 `~/.dsh/dsh-kimiwork-bridge/`：`tasks/`、`deliveries/`、`inbox/`、`log.ndjson`、`token`。

## 三、怎么用

装好之后，三种用法（任选）：

1. **自然语言**——直接说「把这批文件交给 DSH 处理」「DSH 那边跑完了吗」，Kimi 会自己调工具。
2. **斜杠命令**——`/dsh-bridge:派发 把 out/ 里的表合并成一张总表`。
3. **CLI 兜底**（MCP 连不上时用，字段名和 MCP 完全一致）：

```bash
node kimi-plugin/scripts/dsh-bridge.mjs info
node kimi-plugin/scripts/dsh-bridge.mjs dispatch --instructions "要 DSH 做的事" --file <绝对路径>
node kimi-plugin/scripts/dsh-bridge.mjs status   --task-id kw-20261016-091448-189947
node kimi-plugin/scripts/dsh-bridge.mjs list
```

CLI 找不到 DSH 时退出码 `3`，令牌不对退出码 `6`，被拒（含白名单）退出码 `5`。

完整的指挥流程（等待规则、交接卡、派发指令怎么写）见 [`kimi-plugin/skills/dsh-bridge/SKILL.md`](kimi-plugin/skills/dsh-bridge/SKILL.md)。

## 四、5 个 MCP 工具

| 工具 | 干什么 | 关键入参 |
| --- | --- | --- |
| `dsh_dispatch_task` | 派活：新建独立 DSH 会话并立刻开跑 | `instructions`(必填)、`files`、`cwd`、`title`、`notes` |
| `dsh_deliver_files` | 只交文件，不让 DSH 干活 | `files`(必填)、`task_id`、`note`、`extensions` |
| `dsh_task_status` | 查某个任务：状态 / 会话 id / 已收文件 / 最后一次回复摘要 | `task_id` |
| `dsh_list_tasks` | 最近的任务列表 | `limit` |
| `dsh_bridge_info` | 先摸环境：白名单、默认目录、DSH 工作区、在跑的任务 | — |

完整字段、返回样例和 REST 路由见 [`kimi-plugin/skills/dsh-bridge/references/bridge-api.md`](kimi-plugin/skills/dsh-bridge/references/bridge-api.md)。

任务状态：`accepted` → `running` → `done` / `failed`。`done` 之后 `lastReply` 是 DSH 最后一次回复的**摘要**（最多 4000 字），不是全文。

## 五、安全边界

三道，都在 DSH 侧：

1. **只认回环**——非 `127.0.0.1`/`::1` 的请求一律 403。
2. **共享令牌**——`requireToken: true` 时所有路由都要 `Authorization: Bearer <token>`，令牌在 `~/.dsh/dsh-kimiwork-bridge/token`（纯文本或 JSON 均可）。
3. **执行目录白名单**——`allowedRoots` 之外的 `cwd` 直接 400 拒绝。

改白名单：编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `kimiwork-bridge` 那条的 `config.allowedRoots`，**这个文件是被监听的，存盘即生效**，不用重启 DSH：

```yaml
- id: kimiwork-bridge          # 只能靠 id 去合并，别再加 name:
  config:
    requireToken: true
    promptTimeoutMs: 30000
    allowedRoots:
      - 'C:\Users\island\Desktop'
```

> 注意：这条 profile 覆盖**必须只写 `id`**。写成 `id` + `name` 时，因为 bundle 里的条目名换成了相对路径，两者不再合并，配置会静默退回默认值（`requireToken: false`、白名单为空）。

## 六、改代码 / 重新部署

```bash
# DSH 侧（内容哈希构建目录，绕开 ESM 模块缓存，部署后无需重启 DSH）
node tools/deploy-dsh-plugin.mjs
# 然后让 DSH 重新装载条目：
#   plugin_manager set_bundle target=dsh-kimiwork-bridge enabled=false
#   plugin_manager set_bundle target=dsh-kimiwork-bridge enabled=true

# Kimi 侧（同步 + 生成 tools.json / node-path.txt，不烘任何令牌）
node tools/deploy-kimi-plugin.mjs
```

部署脚本会顺手生成两个文件到插件里：`scripts/tools.json`（工具 schema，直接从 `dsh-plugin/lib/mcp.js` 的 `TOOLS` 导出，两边同一份）和 `scripts/node-path.txt`（node 绝对路径，给 `.cmd` 启动器兜底，**不进版本库**）。

### 为什么 DSH 侧要搞「内容哈希构建目录」

DSH 的 ESM 模块缓存按**绝对路径 URL** 生效：`lib/index.js` 一旦加载过，原地覆盖再 reload 也只会命中旧缓存，改动永远不生效，除非重启 DSH。
（DSH 自带的 `dsh-hmr` 本来能替换模块缓存，但 base bundle 把它配成了 `root: []`——只监听 profile 配置、不监听模块源码，而且要改也得在启动前配。）

所以 `deploy-dsh-plugin.mjs` 把整套 `lib/*.js` 复制到 `lib/builds/<内容哈希>/` 这个**从未被加载过的新 URL** 下，并把 bundle patch 的 `insert.name` 指过去：
换代码 = 换 URL = 一次干净的新模块加载，**部署后不用重启 DSH**。

## 七、自测

```bash
node tools/smoke-bridge.mjs         # 28 条断言：假宿主 + 假 sessionController，起真 http 服务跑全链路（含 endpoint.json 发布/清理）
node tools/verify-plugin.mjs        # 14 条断言：把**已装进 profile 的真实入口**拉起来（真 http 服务冒充 webServer），验路由/端点发布/卸载
node tools/probe-mcp.mjs            # 直连 DSH 的 HTTP MCP 端点（initialize / tools/list / tools/call / 未知工具）
node tools/probe-mcp.mjs --stdio    # 拉起 Kimi 侧 .cmd 启动器，按 MCP over stdio 实测整条链
```

## 八、排错

| 现象 | 原因 / 处理 |
| --- | --- |
| CLI 退出码 3「连不上 DSH」 | 端点不对。先 `dsh-bridge.mjs endpoint` 看它读的是哪个端点、来源是什么。 |
| `endpoint.json` 不存在 / 端点退回了 19387 | DSH 侧插件没启用，或 `dsh web` 还没 listen。看 DSH 日志里有没有 `endpoint published: <url> -> ...`；用 `dsh plugin --profile desktop list` 确认 `kimiwork-bridge` 在。 |
| HTTP 401 | 令牌不对：`endpoint.json` 里的 token 与 DSH 侧现用令牌不一致（插件重启换过令牌）。让 DSH 侧重载一次插件即可重写端点文件。 |
| Kimi 里看不到 5 个 `dsh_*` 工具 | 装的是旧版（`url` 方式）的清单 → 在 Kimi 里卸掉重装；还不行就看 daemon 日志里 `dsh-bridge` 这个 MCP 的 stderr。 |
| daemon 日志里 `[dsh-bridge] node.exe not found` | Kimi 宿主 PATH 里没有 node，启动器按 `DSH_BRIDGE_NODE` → 同目录 `node-path.txt` → `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe` → `where node` 顺序找。重跑 `deploy-kimi-plugin.mjs` 会重写 `node-path.txt`。 |
| HTTP 400「不在允许执行的根目录白名单内」 | 白名单没包含这个目录，去 profile 的 `cordis.patch.yml` 加。 |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | 历史坑：`sessionController.prompt(request, signal)` 的第二个参数是**必填**的 AbortSignal。现在的代码传的是 `AbortSignal.timeout(promptTimeoutMs)`。 |
| 改了插件代码行为不变 | 见第六节：必须走 `deploy-dsh-plugin.mjs` + 重载，不能只覆盖文件。 |

## 九、还没做的

- **Stop hook 只是写好了、没有启用**。`kimi-plugin/scripts/kimiwork-stop-hook.mjs` 会在 Kimi 每轮结束时读它的改动日志 `file-edit-journal.json`，把这一轮新建/改过的文件兜底交付给 DSH（幂等、永远退出码 0）。
  按 Kimi 插件规范，**声明了 `hooks` 的插件不能自动注册，必须用户本人过目**——所以它没写进清单。点头后加上这一行、重跑 `deploy-kimi-plugin.mjs` 即可：

  ```json
  "hooks": [{ "event": "Stop", "command": "<node 绝对路径> ./scripts/kimiwork-stop-hook.mjs", "timeout": 30 }]
  ```

  （`node` 不在 Kimi 宿主 PATH 里，hook 的 command 得写 node 绝对路径。）

- **Kimi 直连 HTTP 的方式没验证**。清单现在走 `command` 起 stdio shim；`url` 方式理论上也能用（插件路由在 dsh web 鉴权层之前命中），但 Kimi 的 HTTP MCP 客户端在本机没实测过。

- DSH 产出的文件目前靠读快照（`inbox/`）拿回 Kimi 侧，没有做反向的自动推送。

## 十、实现契约

动手前把两边的接口契约都核实过，定稿在 [`docs/impl-contracts.md`](docs/impl-contracts.md)（DSH 宿主服务契约、装载/热加载机制、Kimi Work 侧事实、已定实现决策）。

## License

[MIT](LICENSE) © island
