#!/usr/bin/env node
/**
 * DSH 桥接命令行客户端。
 *
 * 用途：MCP 通道不可用时的兜底（DSH 刚启动、MCP 客户端还没重连、
 * 或想让 shell 脚本 / hook 直接调）。字段名与 MCP 的 snake_case 完全一致。
 *
 *   node scripts/dsh-bridge.mjs info
 *   node scripts/dsh-bridge.mjs dispatch --instructions "..." --title T --file A --file B
 *   node scripts/dsh-bridge.mjs deliver  --file DIR --ext .xlsx --note "成品"
 *   node scripts/dsh-bridge.mjs status   --task-id kw-...
 *   node scripts/dsh-bridge.mjs list     --limit 10
 *
 * 端点优先级：--endpoint > $DSH_KIMMIWORK_ENDPOINT > <DSH_HOME>/dsh-kimiwork-bridge/endpoint.json
 * > 静态兜底（dsh web 端口是运行期决定的，正常都从 endpoint.json 发现）。
 */
import { parseArgs } from 'node:util'
import { DEFAULT_BASE_URL, describeConnection, resolveConnection } from './endpoint.mjs'

/** 解析后的命令行令牌，在 parseArgs 之后填入。 */
let activeToken = ''

const OPTIONS = {
  endpoint: { type: 'string' },
  token: { type: 'string' },
  instructions: { type: 'string' },
  title: { type: 'string' },
  cwd: { type: 'string' },
  file: { type: 'string', multiple: true },
  notes: { type: 'string' },
  'workspace-id': { type: 'string' },
  'task-id': { type: 'string' },
  note: { type: 'string' },
  ext: { type: 'string', multiple: true },
  limit: { type: 'string' },
  recursive: { type: 'boolean', default: true },
  snapshot: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h' },
}

const USAGE = `DSH 桥接 CLI

  node dsh-bridge.mjs endpoint                              打印端点发现结果（排查用）
  node dsh-bridge.mjs info                                 看配置、白名单、工作区
  node dsh-bridge.mjs dispatch --instructions "..." [选项]   派任务给 DSH
  node dsh-bridge.mjs deliver  --file <路径> [选项]          只交付文件
  node dsh-bridge.mjs status   --task-id <id>               查任务状态
  node dsh-bridge.mjs list     [--limit 20]                 最近的任务

dispatch / deliver 选项：
  --title <文本>           任务标题
  --cwd <绝对路径>         会话工作目录
  --file <绝对路径>        可重复；目录默认递归展开
  --notes <文本>           给 DSH 的补充说明
  --note <文本>            这次交付的说明
  --workspace-id <id>      挂到 DSH 的某个工作区
  --task-id <id>           挂到已有任务上（deliver）
  --ext <.xlsx>            只收这些扩展名，可重复
  --no-recursive           目录不递归
  --no-snapshot            不另存文件快照
  --endpoint <url>         覆盖端点（默认从 endpoint.json 动态发现）
  --token <令牌>           覆盖共享令牌

端点优先级：--endpoint > $DSH_KIMMIWORK_ENDPOINT > endpoint.json > ${DEFAULT_BASE_URL}
令牌优先级：--token > $DSH_KIMMIWORK_TOKEN > endpoint.json 里的 token > 状态目录的 token 文件
（DSH 桥接开了 requireToken 就必须带令牌，否则一律 401。）
`

function fail(message, code = 2) {
  process.stderr.write(`dsh-bridge: ${message}\n`)
  process.exit(code)
}

async function call(endpoint, route, init) {
  const url = `${endpoint.replace(/\/+$/, '')}${route}`
  const token = activeToken
  let response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    fail(`连不上 DSH（${url}）：${error?.message ?? error}\n` +
      `  端点来源：${describeConnection(CONN)}\n` +
      '  · DSH 没在运行，或桥接插件没启用。先启动 DSH，再调 `endpoint` / `info` 验证。', 3)
  }
  const text = await response.text()
  let body
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    fail(`DSH 返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 400)}`, 4)
  }
  if (response.status === 401) {
    fail('DSH 拒绝了令牌（401）。检查 --token / $DSH_KIMIWORK_TOKEN，' +
      `或 ${CONN.endpointFile} / token 文件里的 token 是否和 DSH 侧一致。`, 6)
  }
  if (!response.ok || body?.ok === false) {
    fail(`DSH 拒绝了这次请求（HTTP ${response.status}）：${body?.error ?? text.slice(0, 400)}`, 5)
  }
  return body
}

const { values: v, positionals } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true })
const command = positionals[0]

if (v.help || command === undefined) {
  process.stdout.write(USAGE)
  process.exit(command === undefined && !v.help ? 1 : 0)
}

const CONN = resolveConnection({ endpoint: v.endpoint, token: v.token })
const endpoint = CONN.baseUrl
activeToken = CONN.token ?? ''
const files = v.file ?? []
const print = (payload) => process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)

switch (command) {
  case 'endpoint': {
    print({
      baseUrl: CONN.baseUrl,
      source: CONN.source,
      tokenSource: CONN.tokenSource,
      endpointFile: CONN.endpointFile,
      describe: describeConnection(CONN),
      meta: CONN.meta ?? null,
    })
    break
  }
  case 'info':
  case 'health': {
    print(await call(endpoint, '/health', { method: 'GET' }))
    break
  }
  case 'dispatch': {
    if (typeof v.instructions !== 'string' || v.instructions.trim() === '') {
      fail('dispatch 需要 --instructions "要 DSH 做的事"')
    }
    print(
      await call(endpoint, '/dispatch', {
        method: 'POST',
        body: JSON.stringify({
          instructions: v.instructions,
          source: 'cli',
          ...(v.title === undefined ? {} : { title: v.title }),
          ...(v.cwd === undefined ? {} : { cwd: v.cwd }),
          ...(v.notes === undefined ? {} : { notes: v.notes }),
          ...(v['workspace-id'] === undefined ? {} : { workspace_id: v['workspace-id'] }),
          ...(files.length === 0 ? {} : { files }),
          ...(v.ext === undefined ? {} : { extensions: v.ext }),
          ...(v.recursive === false ? { recursive: false } : {}),
        }),
      }),
    )
    break
  }
  case 'deliver': {
    if (files.length === 0) fail('deliver 需要至少一个 --file <绝对路径>')
    print(
      await call(endpoint, '/deliver', {
        method: 'POST',
        body: JSON.stringify({
          files,
          source: 'cli',
          ...(v.note === undefined ? {} : { note: v.note }),
          ...(v['task-id'] === undefined ? {} : { task_id: v['task-id'] }),
          ...(v.ext === undefined ? {} : { extensions: v.ext }),
          ...(v.recursive === false ? { recursive: false } : {}),
          ...(v.snapshot === false ? { snapshot: false } : {}),
        }),
      }),
    )
    break
  }
  case 'status': {
    if (typeof v['task-id'] !== 'string' || v['task-id'].trim() === '') fail('status 需要 --task-id <id>')
    print(await call(endpoint, `/tasks/${encodeURIComponent(v['task-id'].trim())}`, { method: 'GET' }))
    break
  }
  case 'list': {
    const limit = Number(v.limit ?? 20)
    print(await call(endpoint, `/tasks?limit=${Number.isFinite(limit) ? limit : 20}`, { method: 'GET' }))
    break
  }
  default:
    process.stderr.write(`dsh-bridge: 未知命令 "${command}"\n\n${USAGE}`)
    process.exit(1)
}
