---
name: dsh-bridge
description: 把 Kimi Work 的任务派发给本机 DSH（DeepSeek Harness）执行，并把产出的文件交付过去；也可用来查 DSH 上任务的状态。
---

# DSH 桥接

把活交给本机的 **DSH（DeepSeek Harness）** 去干，并把产出的文件交付过去。
DSH 那边每次派发都会**新建一个独立会话**立刻开跑，会话在 DSH 的 Web 界面里能看到、能接着聊。

## 什么时候用（指挥模式）

老大的立场：Kimi 是总指挥，DSH 是执行手。**默认由你负责拆解任务流程、把执行环节派给 DSH，不需要等老大点名。**

- **要主动派的情况**：任何多步骤、有实际执行动作的任务——处理文件、批量操作、写脚本跑数据、格式转换、长链路加工、需要独立沙盒会话的探索性任务等。你先拆解，规划好每一步谁干，然后把 DSH 该干的部分派出去；你负责指挥、验收、向老大汇报。
- **留在 Kimi 侧自己做的例外**：
  - 生图、生视频（老大明确排除）。
  - 只能靠 Kimi 侧专属工具完成的事：浏览器操控、widget/自动化交互、飞书 / Notion 等已装 MCP 插件。
  - 纯问答、闲聊、一句话能说清的事——没有可拆解的执行动作，直接答，不要为派而派。
- 老大明确说「这次不要给 DSH」时，尊重指令，本轮不派。

## 怎么用

优先走 MCP 原生工具（插件装好后这些工具直接可用）：

| 工具 | 干什么 |
| --- | --- |
| `dsh_bridge_info` | 先看这个：本机 DSH 的工作区、允许执行的根目录白名单、默认工作目录。 |
| `dsh_dispatch_task` | 派任务给 DSH：新建独立会话 + 立即开跑 + 一并交付文件。 |
| `dsh_deliver_files` | 只交付文件，不派任务。 |
| `dsh_task_status` | 查某个 task_id 的状态、会话 id、已收文件和最后一次回复摘要。 |
| `dsh_list_tasks` | 最近派给 DSH 的任务列表。 |

MCP 工具不可用时（DSH 没开、插件没装），用命令行兜底：

```bash
node scripts/dsh-bridge.mjs info
node scripts/dsh-bridge.mjs dispatch --instructions "把 report.pptx 转成 pdf" --title "转 PDF" --file "C:\path\report.pptx"
node scripts/dsh-bridge.mjs deliver --file "C:\path\out" --ext .xlsx --note "成品"
node scripts/dsh-bridge.mjs status --task-id kw-20261016-090038-5ee91e
node scripts/dsh-bridge.mjs list --limit 10
```

脚本要求 `node` 在 PATH 上；不在的话用 DSH 自带的：
`C:\Users\island\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

长任务等待用「DSH 等待器」定时任务（纯代码轮询，不烧对话 token），见下文「等待规则」。

详细字段见 `references/bridge-api.md`。

## 硬规则

1. **路径必须是绝对路径。** `files` 里给目录会递归展开（默认递归，可用 `recursive:false` 关掉，用 `extensions` 过滤扩展名）。
2. **你要先自己产出文件，再交付。** 桥接只负责把已存在的文件交过去，不会替你生成内容。
3. **派发是异步的。** `dsh_dispatch_task` 返回 `accepted` 只代表任务已入列、DSH 已开跑。等待规则见下节，**轮询不许烧 token**。
4. **需要 DSH 正在运行。** 连不上就是 DSH 没开，如实告诉用户，不要伪造派发成功。
5. **白名单是硬约束。** `cwd` 落在允许根目录之外会被拒绝——这是刻意设计。被拒时把白名单原样告诉用户，让他自己决定要不要放开（改的是 DSH 侧 profile 的 `cordis.patch.yml` 里 `kimiwork-bridge` 的 `config.allowedRoots`），**不要试图绕过**。
6. **任务 id 要留住。** 派发后把 `task_id` 和 `session_id` 告诉用户，后面查状态、继续对话都要用。

## 等待规则（省 token 核心）

按预计时长分流，**禁止无意义轮询**：

- **短任务（预计 ≤ 2 分钟）**：当场等。`sleep 40` 后查 `dsh_task_status`，最多 3 次；告诉用户「在等 DSH，约 1 分钟」。
- **长任务（预计 > 2 分钟）**：**不要自己轮询**。
  1. 写好交接卡（见下节）。
  2. 触发「DSH 等待器」定时任务（手动触发，runInput 传 `{"task_id": "<task_id>"}`）。
  3. 告诉用户：「任务已派出，预计要 X 分钟，完成后会推送通知，不用在这等」，然后结束等待。
- 推送到达后按「唤醒后续接」流程走。
- **绝对不要说「已经做完了」**，除非状态明确是 `done`。

## 交接卡（换窗口也不断线）

每次派发**必须**在 `cwd` 下写交接卡 `<cwd>\.dsh-handoff\<task_id>.md`：

```markdown
# <任务标题>
- task_id: kw-...
- session_id: kw:...
- 派发时间: <ISO 时间>
- cwd: <DSH 工作目录>
## 任务目标
<一句话>
## 验收标准
<怎么算 DSH 干完了>
## 完成后我要做的事
<验收后接下来的步骤，写给未来的自己>
## 状态
pending
```

- 本技能配了 `sessionStart`：每次开新会话都会加载它。加载后若当前项目区的 `.dsh-handoff/` 里有 `pending` 的卡，先查状态，已完成的直接走「唤醒后续接」。
- 所以哪怕老大另开新窗口、或者隔天才回来，只要说清楚是哪个项目区，你就能无损接上。

## 唤醒后续接

收到「DSH 等待器」的完成推送、或老大说「DSH 那边完事了吗」时：

1. 读交接卡（`.dsh-handoff/<task_id>.md`），回忆上下文。
2. `dsh_task_status` 拉状态，对照「验收标准」验收。
3. 产物在 `files` 的绝对路径里，直接读；要看 DSH 说了什么看 `lastReply`。
4. 向老大汇报：结果、产物路径、有没有待确认项。
5. 做「完成后我要做的事」，然后把交接卡状态改成 `closed`。

## 派发指令怎么写

`instructions` 是 DSH 看到的全部上下文，要求：

- 写清目标、约束、验收标准。
- **结尾固定要求汇报格式**：「完成后用 ≤300 字汇报：结论 + 产物绝对路径 + 待确认项。不要过程日志、审计输出。」——不然 DSH 的审计尾巴会吃掉 4000 字的 `lastReply` 摘要额度，还污染你的上下文。

## 一次典型的交接

1. 接到一个多步骤任务，先拆解：规划自己扛，执行环节里适合 DSH 的派给 DSH。
2. 你先把需要交付的前置产出做完（比如 `C:\Users\island\Desktop\工作\out\清洗后.xlsx`）。
3. `dsh_bridge_info` 看一眼白名单和工作区。
4. `dsh_dispatch_task`：
   - `instructions`：目标 / 约束 / 验收标准 / 汇报格式（见上节）。
   - `title`：一句话标题。
   - `files`：把上面产出的文件绝对路径放进去。
   - `cwd`：不填就落在文件所在目录；要挂到某个 DSH 工作区就填它的路径（`dsh_bridge_info` 里有）。
   - `notes`：补充上下文。
5. 在 `cwd` 下写交接卡 `.dsh-handoff/<task_id>.md`。
6. 按「等待规则」分流：短任务当场等，长任务触发「DSH 等待器」并告知用户等推送。
7. 拿到 `task_id`，向用户复述：派了什么、在哪个会话、怎么查。

## 反过来：DSH 的产出怎么回到这边

DSH 任务返回的 `files` 里是绝对路径，直接读它们就行。
桥接在 DSH 侧还留了快照副本（`snapshot` 字段），原文件被改动或删除后仍然可读——需要原始内容时优先读快照。
