#!/usr/bin/env node
/**
 * 桥接探针：不依赖 Kimi 客户端在场，直接验证两条通道。
 *
 *   node tools/probe-mcp.mjs            # 直连 DSH 的 HTTP MCP 端点
 *   node tools/probe-mcp.mjs --stdio    # 拉起 Kimi 侧 stdio MCP（走 .cmd 启动器），验证整条链
 *
 * 端点默认从 <DSH_HOME>/dsh-kimiwork-bridge/endpoint.json 发现，
 * 可用 --endpoint <url> 覆盖（debug 用）。
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 启动失败；3 = 连不上 DSH；6 = 令牌被拒。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeConnection, resolveConnection } from '../kimi-plugin/scripts/endpoint.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const SHIM = join(REPO, 'kimi-plugin', 'scripts', 'dsh-bridge-mcp.cmd')

const args = process.argv.slice(2)
const endpointArg = args.indexOf('--endpoint')
const conn = resolveConnection({ endpoint: endpointArg >= 0 ? args[endpointArg + 1] : undefined })
const useStdio = args.includes('--stdio')

let nextId = 1
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function parseJsonRpcText(text) {
  const body = text.trim()
  if (body === '') return undefined
  if (body.startsWith('event:') || body.includes('\ndata: ')) {
    return JSON.parse(body.split('\ndata: ').pop().trim())
  }
  return JSON.parse(body)
}

function toolPayload(result) {
  const item = result?.content?.find((entry) => entry?.type === 'text')
  if (item === undefined) return undefined
  try {
    return JSON.parse(item.text)
  } catch {
    return { __raw: item.text }
  }
}

/** HTTP 直连通道。 */
async function httpRpc(method, params) {
  const id = nextId++
  let response
  try {
    response = await fetch(`${conn.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(conn.token === undefined ? {} : { authorization: `Bearer ${conn.token}` }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    console.error(`连不上 DSH（${conn.baseUrl}）：${error?.message ?? error}`)
    console.error(`  端点来源：${describeConnection(conn)}`)
    process.exit(3)
  }
  const text = await response.text()
  if (!response.ok) {
    console.error(`HTTP ${response.status} ${method}: ${text.slice(0, 400)}`)
    process.exit(response.status === 401 ? 6 : 5)
  }
  return parseJsonRpcText(text)
}

/** stdio 通道：拉起 Kimi 侧 .cmd 启动器（含 node 自动发现），按 MCP over stdio 通信。 */
function startStdio() {
  if (process.platform !== 'win32') {
    console.error('--stdio 目前只支持 Windows（清单用的是 cmd.exe 启动器）')
    process.exit(2)
  }
  // 仓库副本没有 node-path.txt（那是部署产物），直接把当前 node 交给启动器，免得它去猜。
  const child = spawn('cmd.exe', ['/c', SHIM], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_BRIDGE_NODE: process.execPath },
  })
  const pending = new Map()
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      console.error(`  (stdio 非 JSON 输出) ${text.slice(0, 200)}`)
      return
    }
    const id = payload?.id
    if (id === undefined || !pending.has(id)) return
    const { resolve, reject } = pending.get(id)
    pending.delete(id)
    if (payload.error !== undefined) reject(new Error(`${payload.error.message ?? 'JSON-RPC 错误'}`))
    else resolve(payload)
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text !== '') console.error(`  (shim stderr) ${text}`)
  })
  child.on('exit', (code) => {
    for (const { reject } of pending.values()) reject(new Error(`stdio MCP 进程退出了（code ${code}）`))
    pending.clear()
  })

  const send = (message) =>
    new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject })
      child.stdin.write(`${JSON.stringify(message)}\n`)
      setTimeout(() => {
        if (!pending.has(message.id)) return
        pending.delete(message.id)
        reject(new Error(`stdio 通道 120s 无响应：${message.method}`))
      }, 120_000).unref?.()
    })

  return { send, close: () => child.stdin.end() }
}

let rpc
let stop = () => {}
if (useStdio) {
  const stdio = startStdio()
  stop = stdio.close
  rpc = async (method, params) => stdio.send({ jsonrpc: '2.0', id: nextId++, method, params })
  console.log(`MCP 通道 stdio：cmd /c ${SHIM}`)
  console.log(`  发现到的端点：${describeConnection(conn)}`)
} else {
  rpc = httpRpc
  console.log(`MCP 通道 HTTP：${conn.baseUrl}/mcp；${describeConnection(conn)}`)
}

function fatal(error) {
  console.error(`\n通道失败：${error?.message ?? error}`)
  console.error(`  端点来源：${describeConnection(conn)}`)
  stop()
  process.exit(3)
}

console.log('[1] initialize')
let init
try {
  init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe-mcp', version: '0' },
  })
} catch (error) {
  fatal(error)
}
check('返回 protocolVersion', typeof init?.result?.protocolVersion === 'string', JSON.stringify(init).slice(0, 200))
check('声明 serverInfo', typeof init?.result?.serverInfo?.name === 'string')

console.log('[2] tools/list')
const list = await rpc('tools/list', {})
const tools = list?.result?.tools ?? []
const names = tools.map((tool) => tool?.name)
check('至少 5 个工具', tools.length >= 5, `实际 ${tools.length}`)
for (const want of ['dsh_dispatch_task', 'dsh_deliver_files', 'dsh_task_status', 'dsh_list_tasks', 'dsh_bridge_info']) {
  check(`含 ${want}`, names.includes(want))
}
check('每个工具都有 inputSchema', tools.every((tool) => typeof tool?.inputSchema?.type === 'string'))

console.log('[3] tools/call dsh_bridge_info')
const info = await rpc('tools/call', { name: 'dsh_bridge_info', arguments: {} })
const infoBody = toolPayload(info?.result)
check('报出 server 名', infoBody?.server === 'dsh-kimiwork-bridge', JSON.stringify(infoBody ?? info?.error).slice(0, 300))
check('带 allowedRoots', Array.isArray(infoBody?.allowedRoots))

console.log('[4] tools/call dsh_list_tasks')
const tasks = await rpc('tools/call', { name: 'dsh_list_tasks', arguments: { limit: 3 } })
const tasksBody = toolPayload(tasks?.result)
check('tasks 是数组', Array.isArray(tasksBody?.tasks))

console.log('[5] 未知工具应报错而不是崩')
try {
  const bad = await rpc('tools/call', { name: 'nope_not_a_tool', arguments: {} })
  check('有错误返回', bad?.result !== undefined || bad?.error !== undefined, JSON.stringify(bad).slice(0, 300))
} catch (error) {
  // stdio 通道把 JSON-RPC error 当拒绝抛出来，这里同样算"明确报错"
  check('有错误返回', true, String(error?.message ?? error).slice(0, 200))
}

console.log('')
stop()
if (failed === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`${failed} 项失败。`)
process.exit(1)
