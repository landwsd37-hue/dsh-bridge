#!/usr/bin/env node
/**
 * dsh-bridge MCP stdio 服务端（Kimi Work 侧）。
 *
 * Kimi Work 用 `command` 方式拉起本进程，按 MCP JSON-RPC over stdio 通信；
 * 真正的工具执行在本机已运行的 DSH 桥接插件里（HTTP）。本文件只管转发：
 *
 *   initialize / ping / tools/list  -> 本地应答（DSH 没开也能正常握手、列出工具）
 *   tools/call 及其它               -> 转发到 <baseUrl>/mcp（DSH 侧唯一实现）
 *
 * 端点由 ../scripts/endpoint.mjs 动态发现，顺序：
 *   --endpoint > $DSH_KIMIWORK_ENDPOINT > <DSH_HOME>/dsh-kimiwork-bridge/endpoint.json > 静态兜底
 *
 * 协议输出只走 stdout（一行一个 JSON），诊断信息只走 stderr。
 */
import { createInterface } from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeConnection, resolveConnection } from './endpoint.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS_FILE = join(HERE, 'tools.json')
const SERVER_INFO = { name: 'dsh-bridge', version: '0.2.0' }
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--endpoint' && argv[i + 1] !== undefined) {
      out.endpoint = argv[i + 1]
      i += 1
    } else if (arg === '--token' && argv[i + 1] !== undefined) {
      out.token = argv[i + 1]
      i += 1
    }
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))

function log(message) {
  try {
    process.stderr.write(`[dsh-bridge] ${message}\n`)
  } catch {
    /* 宿主不接 stderr 时忽略 */
  }
}

/** tools.json 由 tools/deploy-kimi-plugin.mjs 从 dsh-plugin/lib/mcp.js 生成。 */
function loadTools() {
  try {
    if (!existsSync(TOOLS_FILE)) return undefined
    const value = JSON.parse(readFileSync(TOOLS_FILE, 'utf8'))
    if (Array.isArray(value?.tools) && value.tools.length > 0) return value.tools
    if (Array.isArray(value) && value.length > 0) return value
    return undefined
  } catch (error) {
    log(`tools.json 读取失败：${error?.message ?? error}`)
    return undefined
  }
}

const TOOLS = loadTools()

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, payload) {
  return { jsonrpc: '2.0', id, result: payload }
}

function failure(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
}

function callTimeoutMs() {
  const fromEnv = Number(process.env.DSH_KIMIWORK_TIMEOUT_MS)
  if (Number.isFinite(fromEnv) && fromEnv > 1000) return fromEnv
  return 180000
}

/** 转发一条 JSON-RPC 消息到 DSH 桥接的 /mcp 端点。 */
async function forward(message, conn) {
  const response = await fetch(`${conn.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(conn.token === undefined ? {} : { authorization: `Bearer ${conn.token}` }),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(callTimeoutMs()),
  })
  const text = await response.text()
  if (response.status === 202 || text.trim() === '') return undefined
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`DSH 回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? text.slice(0, 300)
    throw new Error(`DSH 返回 HTTP ${response.status}：${detail}`)
  }
  return payload
}

function unreachableHint(conn, error) {
  return [
    `连不上 DSH 桥接：${conn.baseUrl}`,
    `原因：${error?.message ?? error}`,
    `端点来源：${conn.source}${conn.meta?.pid === undefined ? '' : `（DSH 进程 pid ${conn.meta.pid}）`}`,
    `端点文件：${conn.endpointFile}`,
    '',
    '排查顺序：',
    '1. DSH 桌面版是否在运行（dsh web 起在哪个端口，桥接就跟到哪个端口）；',
    '2. 桥接插件是否启用：dsh plugin --profile desktop list 里看 kimiwork-bridge；',
    '3. 上面前两步都没问题时删掉旧端点文件再让插件重启一次：',
    `   ${conn.endpointFile}`,
  ].join('\n')
}

async function handleRequest(message) {
  const method = typeof message?.method === 'string' ? message.method : ''
  const id = message?.id

  if (method === 'initialize') {
    const requested = typeof message?.params?.protocolVersion === 'string' ? message.params.protocolVersion : DEFAULT_PROTOCOL_VERSION
    return result(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        '这些工具把任务派给本机的 DSH（DeepSeek Harness）：dsh_dispatch_task 新建会话执行一段指令，dsh_task_status / dsh_list_tasks 回读进度与结论，dsh_deliver_files 把本机文件交给 DSH。Kimi Work 侧仍有 CLI 兜底（node scripts/dsh-bridge.mjs）。',
    })
  }

  if (method === 'ping') return result(id, {})

  if (method === 'tools/list') {
    if (TOOLS !== undefined) return result(id, { tools: TOOLS })
    const conn = resolveConnection(ARGS)
    try {
      const forwarded = await forward(message, conn)
      return forwarded ?? failure(id, -32603, 'tools/list 无响应')
    } catch (error) {
      return failure(id, -32000, unreachableHint(conn, error), { baseUrl: conn.baseUrl, source: conn.source })
    }
  }

  const conn = resolveConnection(ARGS)
  try {
    const forwarded = await forward(message, conn)
    if (forwarded === undefined) return undefined
    return forwarded
  } catch (error) {
    const hint = unreachableHint(conn, error)
    log(hint)
    if (method === 'tools/call') {
      // 工具调用失败优先用 isError 结果回，Kimi 侧能直接把这段话给用户看
      return result(id, {
        content: [{ type: 'text', text: hint }],
        isError: true,
      })
    }
    return failure(id, -32000, hint, { baseUrl: conn.baseUrl, source: conn.source })
  }
}

function handleNotification(message) {
  // initialized / cancelled / roots、progress 之类的通知本地吞掉即可
  void message
}

async function handleLine(line) {
  const text = line.trim()
  if (text === '') return
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    writeMessage(failure(null, -32700, `请求不是合法 JSON：${error?.message ?? error}`))
    return
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      writeMessage(failure(null, -32600, '空批量请求'))
      return
    }
    const responses = []
    for (const message of parsed) {
      const response = await dispatch(message)
      if (response !== undefined) responses.push(response)
    }
    if (responses.length > 0) writeMessage(responses)
    return
  }

  const response = await dispatch(parsed)
  if (response !== undefined) writeMessage(response)
}

async function dispatch(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return failure(null, -32600, '请求必须是 JSON-RPC 对象')
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
  if (!hasId) {
    handleNotification(message)
    return undefined
  }
  return handleRequest(message)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue = Promise.resolve()
rl.on('line', (line) => {
  queue = queue.then(() => handleLine(line)).catch((error) => {
    log(`内部错误：${error?.stack ?? error}`)
    writeMessage(failure(null, -32603, `桥接内部错误：${error?.message ?? error}`))
  })
})
rl.on('close', () => {
  queue.finally(() => process.exit(0))
})

log(`stdio MCP 就绪；${describeConnection(resolveConnection(ARGS))}${TOOLS === undefined ? '；tools.json 缺失，tools/list 走转发' : `；本地工具 ${TOOLS.length} 个`}`)
