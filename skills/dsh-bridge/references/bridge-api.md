# DSH 桥接 · 接口参考

桥接由两端组成：

- **DSH 侧**：插件 `dsh-kimiwork-bridge`，在本机回环地址上挂一个 HTTP 前缀（默认 `/api/kimiwork`）。
- **Kimi 侧**：本插件，通过 MCP 或命令行调用那个前缀。

端点基址：**运行时发现**，不是固定端口。DSH 侧插件启动后把真实基址写进
`~/.dsh/dsh-kimiwork-bridge/endpoint.json`（含 `baseUrl` / `port` / `pid` / 令牌 / `updatedAt`），
Kimi 侧每次调用都重新读它，顺序是：
`--endpoint` > `$DSH_KIMMIWORK_ENDPOINT` > `endpoint.json` > 静态兜底 `http://127.0.0.1:19387/api/kimiwork`。

`dsh_bridge_info`（或 `node scripts/dsh-bridge.mjs endpoint`）会报出它读到的是哪个基址、来源是什么。

---

## MCP 工具

### `dsh_bridge_info`

无参数。返回：

```json
{
  "server": "dsh-kimiwork-bridge",
  "version": "0.1.0",
  "stateDir": "C:\\Users\\island\\.dsh\\dsh-kimiwork-bridge",
  "apiPath": "/api/kimiwork",
  "allowedRoots": ["C:\\Users\\island\\Desktop\\工作"],
  "defaultCwd": "C:\\Users\\island\\Desktop\\工作",
  "snapshotMaxBytes": 8388608,
  "requireToken": false,
  "workspaces": [{ "id": "ws-1", "name": "工作", "path": "C:\\Users\\island\\Desktop\\工作" }],
  "pending": [{ "sessionId": "kw:20261016-090038-5ee91e", "taskId": "kw-20261016-090038-5ee91e" }]
}
```

`allowedRoots` 为空表示**不限制执行目录**（不推荐）。`workspaces[].id` 可以填进 `dsh_dispatch_task.workspace_id`，把会话直接挂到 DSH 的某个工作区下。

### `dsh_dispatch_task`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `instructions` | string | ✅ | 要 DSH 做的事。DSH 那边看到的就是这段文本，写清目标 / 约束 / 验收标准。 |
| `title` | string | | 任务标题，默认取 `instructions` 前 60 字。 |
| `cwd` | string | | 会话工作目录（绝对路径）。不填 → 配置的默认目录 → 文件所在目录 → 白名单第一个根。 |
| `files` | string[] | | 一并交付的文件或目录绝对路径。目录默认递归展开。 |
| `notes` | string | | 补充说明。 |
| `workspace_id` | string | | 挂到 DSH 的某个工作区（用 `dsh_bridge_info` 查 id）。 |

返回：

```json
{
  "task_id": "kw-20261016-090038-5ee91e",
  "session_id": "kw:20261016-090038-5ee91e",
  "status": "running",
  "cwd": "C:\\Users\\island\\Desktop\\工作\\out",
  "file_count": 3,
  "missing_files": [],
  "snapshot_dir": "C:\\Users\\island\\.dsh\\dsh-kimiwork-bridge\\inbox\\kw-20261016-090038-5ee91e\\files",
  "hint": "…"
}
```

`missing_files` 非空表示你给的部分路径在 DSH 那边不存在——**务必转告用户**，不要吞掉。

### `dsh_deliver_files`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `files` | string[] | ✅ | 文件或目录绝对路径。 |
| `task_id` | string | | 挂到已有任务上；不填则新建一条独立交付。 |
| `note` | string | | 这次交付的说明。 |
| `recursive` | bool | | 目录是否递归，默认 `true`。 |
| `extensions` | string[] | | 只收这些扩展名，如 `[".pptx",".xlsx"]`。 |
| `snapshot` | bool | | 是否另存快照，默认 `true`。 |

返回 `{ delivery_id, status, received, missing_files, snapshot_dir }`。

### `dsh_task_status`

入参 `{ task_id }`。返回：

```json
{
  "taskId": "kw-20261016-090038-5ee91e",
  "status": "done",
  "title": "转 PDF",
  "sessionId": "kw:20261016-090038-5ee91e",
  "cwd": "C:\\Users\\island\\Desktop\\工作\\out",
  "createdAt": "2026-10-16T09:00:38.000Z",
  "finishedAt": "2026-10-16T09:02:11.000Z",
  "fileCount": 3,
  "files": [{ "path": "…", "size": 12345, "mtime": "…", "snapshot": "…", "existed": true }],
  "lastReply": "已完成：…",
  "error": null
}
```

`status` 取值：`accepted` → `running` → `done` / `failed`。
`done` 之后 `lastReply` 是 DSH 最后一次助手回复的**摘要**（最多 4000 字），不是全文；全文去 DSH 界面看那个 `sessionId`。

### `dsh_list_tasks`

入参 `{ limit }`（默认 20）。返回 `{ tasks: [...] }`，元素与 `dsh_task_status` 同构。

---

## REST 通道

MCP 走不通时可以直接 POST（字段名与 MCP 的 snake_case 一致）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/dispatch` | body 同 `dsh_dispatch_task`，额外接受 `"source": "rest"`。 |
| `POST` | `/deliver` | body 同 `dsh_deliver_files`。 |
| `POST` | `/mcp` | MCP JSON-RPC（streamable HTTP）。 |
| `GET` | `/health` / `/info` | 同 `dsh_bridge_info`。 |
| `GET` | `/tasks?limit=20` | 任务列表。 |
| `GET` | `/tasks/<task_id>` | 单任务。 |

响应统一 `{ "ok": true, ... }`，失败时 `{ "ok": false, "error": "…" }` 并带 HTTP 状态码。

---

## 鉴权与边界

- 只接受**本机回环地址**的请求（`127.0.0.1` / `::1`），其它一律 403。
- 默认**不要求 token**（`requireToken: false`）。打开后需要 `Authorization: Bearer <token>`，token 在 `<stateDir>/token` 里。
- `cwd` 必须落在 `allowedRoots` 白名单内，否则 400 拒绝。
- 交付的文件**不在白名单内**也允许（只会打上 `outsideRoots: true` 标记），因为临时产物常常在系统临时目录里。

---

## 落盘位置（DSH 侧）

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/dsh-kimiwork-bridge/tasks/<task_id>.json` | 每个任务的完整台账 |
| `~/.dsh/dsh-kimiwork-bridge/deliveries/<id>.json` | 独立交付记录 |
| `~/.dsh/dsh-kimiwork-bridge/inbox/<task_id>/files/` | 文件快照副本 |
| `~/.dsh/dsh-kimiwork-bridge/log.ndjson` | 事件日志 |
| `~/.dsh/dsh-kimiwork-bridge/token` | 可选的访问 token |

`DSH_HOME` 环境变量会覆盖 `~/.dsh`。
