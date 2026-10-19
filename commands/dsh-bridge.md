---
name: dsh-bridge
description: 把当前这件事派发给本机 DSH 执行，并把产出的文件交付过去
---

把下面这件事派发给本机 **DSH（DeepSeek Harness）** 去执行：

$ARGUMENTS

按这个顺序做：

1. 先调 `dsh_bridge_info`，看清 `allowedRoots` 白名单和可用的 DSH 工作区。
2. 把这件事写清楚成一段 `instructions`：**目标、约束、什么算做完**。DSH 那边只看到这段文本，上下文不会自己传过去。
3. 把这次已经产出、需要一起交过去的文件，用**绝对路径**放进 `files`。
4. 调 `dsh_dispatch_task`，`cwd` 填这件事该在哪个目录干（拿不准就留空）。
5. 拿到结果后向用户复述：`task_id`、`session_id`、落在了哪个目录、交了几个文件、有没有 `missing_files`。
6. **不要假装任务已经完成。** 派发是异步的，除非用户要求等结果，否则到此为止；用户要结果时再用 `dsh_task_status` 查。

如果 `dsh_bridge_info` 连不上，说明 DSH 没在运行——如实告诉用户，别伪造派发成功。
