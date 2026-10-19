# dsh-bridge · Kimi Work ↔ DSH 桥接插件

把 **Kimi Work** 的任务派发给本机 **DSH（DeepSeek Harness）** 执行，并把产出的文件自动交付过去。
Kimi 当总指挥负责拆解与验收，DSH 当执行手在独立会话里干活——各干各的，Token 互不浪费。

> A Kimi Work plugin that dispatches tasks to your local DSH (DeepSeek Harness) as independent sessions, hands over the files they need, and reads status/results back at any time.

## 它能做什么

- **派任务**：`dsh_dispatch_task` 新建一个独立 DSH 会话并立即开跑，任务在 DSH 的 Web 界面里能看到、能接着聊。
- **交文件**：把已产出的文件（绝对路径）连同任务一起交付；路径清单 + 关键文件快照（默认 ≤ 8 MB）一并收进 DSH 侧 inbox。
- **查进度**：`dsh_task_status` / `dsh_list_tasks` 随时回读状态、会话 id、已收文件和最后一次回复摘要。
- **CLI 兜底**：MCP 通道不可用（DSH 刚启动、插件未装）时，用 `node scripts/dsh-bridge.mjs` 直接调 REST。

## 架构

```
Kimi Work（本插件，MCP stdio shim）
   │  动态端点发现：--endpoint > $DSH_KIMIWORK_ENDPOINT > endpoint.json > 静态兜底
   ▼
DSH 侧插件 dsh-kimiwork-bridge（HTTP /api/kimiwork，仅本机回环）
   ▼
DeepSeek Harness 独立会话（Web 界面可见、可续聊）
```

- 端点是**运行时发现**的：DSH 侧插件启动后把真实基址写进 `~/.dsh/dsh-kimiwork-bridge/endpoint.json`，Kimi 侧每次调用重新读——DSH 换端口也不怕。
- 只接受本机回环地址请求；`cwd` 必须落在 `allowedRoots` 白名单内（硬约束，防越界）；可选 Bearer token。

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `dsh_bridge_info` | 先看这个：本机 DSH 工作区、允许执行的根目录白名单、默认工作目录。 |
| `dsh_dispatch_task` | 派任务：新建独立会话 + 立即开跑 + 一并交付文件。 |
| `dsh_deliver_files` | 只交付文件，不派任务。 |
| `dsh_task_status` | 查某个 task_id 的状态、会话 id、已收文件和最后一次回复摘要。 |
| `dsh_list_tasks` | 最近派给 DSH 的任务列表。 |

详细字段、REST 通道与鉴权边界见 [bridge-api.md](skills/dsh-bridge/references/bridge-api.md)。

## 安装

前置：本机 DSH 正在运行，且 DSH 侧已启用桥接插件 `dsh-kimiwork-bridge`。

1. 把本仓库整个目录拷进 Kimi Work 的插件目录。
2. `scripts/node-path.txt` 由部署脚本生成（node.exe 绝对路径），不进版本库；缺失时启动器按 `DSH_BRIDGE_NODE` → DSH 自带运行时 → PATH 的顺序自动寻找 node。
3. 在 Kimi Work 中启用插件后，`/dsh-bridge` 命令与 5 个 MCP 工具即可用。

## 快速上手

```bash
# 摸清环境：白名单 / 工作区 / 当前端点
node scripts/dsh-bridge.mjs info

# 派任务（instructions 是 DSH 看到的全部上下文：目标 / 约束 / 验收标准 / 汇报格式）
node scripts/dsh-bridge.mjs dispatch \
  --instructions "把 report.pptx 转成 pdf，完成后用 ≤300 字汇报：结论 + 产物绝对路径 + 待确认项" \
  --title "转 PDF" \
  --file "C:\path\report.pptx"

# 查进度 / 列任务
node scripts/dsh-bridge.mjs status --task-id kw-20261016-090038-5ee91e
node scripts/dsh-bridge.mjs list --limit 10
```

## 设计理念（每个决策都有理由）

- **派发是异步的**：返回 `accepted` 只代表任务已入列。预计 ≤ 2 分钟的短任务当场等（最多轮询 3 次）；长任务交给定时等待器推送通知，**禁止无意义轮询烧 Token**。
- **交接卡不断线**：每次派发在 `.dsh-handoff/<task_id>.md` 写交接卡（目标 / 验收标准 / 完成后要做的事），换窗口、隔天回来也能无损接上。
- **安全边界是硬约束**：仅回环、目录白名单、可选 token，缺一个都拒绝；桥接只交付已存在的文件，绝不替你绕过限制。
- **省 Token 的汇报约定**：派发指令结尾固定要求 DSH 用 ≤300 字汇报，否则审计输出会吃掉 4000 字的摘要额度。

完整的指挥流程（等待规则、交接卡模板、唤醒后续接、派发指令写法）见 [SKILL.md](skills/dsh-bridge/SKILL.md)。

## 仓库结构

```
kimi.plugin.json        # 插件清单（MCP server / skill / command 注册）
commands/dsh-bridge.md  # /dsh-bridge 斜杠命令
skills/dsh-bridge/      # 指挥模式 skill（SKILL.md + 接口参考）
scripts/                # MCP stdio shim、CLI 兜底、端点发现、可选 stop hook
locales/                # 英文界面文案
```

## License

[MIT](LICENSE) © island
