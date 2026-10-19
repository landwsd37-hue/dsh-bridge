/**
 * 桥接自测：不启动 DSH，用一个假的 ctx / sessionController 把 HTTP + MCP +
 * 文件交付 + 任务派发全链路跑一遍。用来在装进 profile 之前先证明代码是活的。
 *
 * 用法： <node> tools/smoke-bridge.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../dsh-plugin/lib/bridge.js'
import { isInside, normalizePath, sessionIdFor } from '../dsh-plugin/lib/util.js'
import { ENDPOINT_FILE, createEndpointPublisher } from '../dsh-plugin/lib/endpoint.js'

/**
 * 这里刻意不 import dsh-plugin/lib/index.js：它要 @deepseek-ai/schemastery，
 * 而那个包只在 DSH profile 的 node_modules 里解析得到。Config 的默认值校验
 * 放到"装进 profile 之后"的 verify-install 里做，本文件只验证 bridge 本体。
 */
const Config = (input) => ({
  stateDir: '',
  apiPath: '/api/kimiwork',
  allowedRoots: [],
  cwd: '',
  agentPreset: 'standard',
  provider: '',
  model: '',
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxFiles: 300,
  snapshotFiles: true,
  requireToken: false,
  token: '',
  ...input,
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ── 场景目录 ────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), 'kwbridge-'))
const workdir = join(sandbox, 'kimi-work')
mkdirSync(join(workdir, 'out'), { recursive: true })
writeFileSync(join(workdir, 'out', 'report.pptx'), 'PPTX-CONTENT')
writeFileSync(join(workdir, 'out', 'data.xlsx'), 'XLSX-CONTENT')
writeFileSync(join(workdir, 'out', 'ignore.png'), 'PNG')
const stateDir = join(sandbox, 'state')

// ── 假宿主 ──────────────────────────────────────────────────
const handlers = new Map()
const calls = []
const sessions = new Map()
const services = {
  sessionController: {
    async create(request) {
      calls.push({ op: 'create', ...request })
      if (request.cwd !== undefined && !existsSync(request.cwd)) throw new Error(`cwd 不存在：${request.cwd}`)
      sessions.set(request.sessionId, { status: 'idle' })
      return { sessionId: request.sessionId }
    },
    async selectModel(request) {
      calls.push({ op: 'selectModel', ...request })
      return { selected: { provider: request.provider, model: request.model } }
    },
    async prompt(request) {
      calls.push({ op: 'prompt', ...request })
      sessions.set(request.sessionId, { status: 'running' })
      emit('agent/status', { agent: { id: request.sessionId }, status: 'running' })
      setTimeout(() => {
        sessions.set(request.sessionId, { status: 'idle' })
        emit('agent/status', { agent: { id: request.sessionId }, status: 'idle' })
      }, 30)
      return { accepted: true }
    },
    async inspect(sessionId) {
      return {
        meta: { id: sessionId },
        events: [
          { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'task' }] } } },
          { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '已完成：报告已生成' }] } } },
        ],
      }
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }) },
  workspaceRegistry: { list: () => [{ id: 'ws-1', name: 'deepseek', path: normalizePath(workdir) }] },
  agents: { get: (id) => sessions.get(id) },
}
const ctx = {
  get: (service) => services[service],
  on: (event, handler) => handlers.set(`${event}:${handlers.size}`, handler),
  off: () => {},
  logger: () => ({ info: (line) => console.log('   [log]', line), warn: () => {} }),
}
function emit(event, payload) {
  for (const [key, handler] of handlers) if (key.startsWith(`${event}:`)) handler(payload)
}

// ── 起 HTTP ─────────────────────────────────────────────────
const config = Config({
  stateDir,
  allowedRoots: [normalizePath(workdir)],
  provider: 'deepseek-account',
  model: 'deepseek-flash',
})
const bridge = new Bridge(ctx, config, stateDir)
bridge.start()
const server = createServer((req, res) => bridge.handle(req, res))
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}${config.apiPath}`

async function rpc(method, params, id = 1) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return { status: response.status, body: await response.json() }
}
async function callTool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args }, 99)
  if (body.error) throw new Error(`${name}: ${body.error.message}`)
  return body.result
}
async function post(path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ── 用例 ────────────────────────────────────────────────────
try {
  const health = await fetch(`${base}/health`).then((r) => r.json())
  check('GET /health', health.ok === true && health.server === 'dsh-kimiwork-bridge', `allowedRoots=${JSON.stringify(health.allowedRoots)}`)

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kimi-work', version: '0' } })
  check('MCP initialize', init.body.result?.serverInfo?.name === 'dsh-kimiwork-bridge' && init.body.result.protocolVersion === '2025-06-18')

  const list = await rpc('tools/list', {})
  const names = (list.body.result?.tools ?? []).map((tool) => tool.name)
  check('MCP tools/list', names.length === 5 && names.includes('dsh_dispatch_task') && names.includes('dsh_deliver_files'), names.join(','))

  const notified = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  check('MCP 通知返回 202 空体', notified.status === 202)

  const info = await callTool('dsh_bridge_info', {})
  check('tool dsh_bridge_info 报出工作区', info.structuredContent.workspaces[0]?.path === normalizePath(workdir))
  check('白名单已生效', isInside(workdir, join(workdir, 'out')))

  // 交付（目录展开 + 扩展名过滤 + 快照）
  const deliver = await callTool('dsh_deliver_files', {
    files: [join(workdir, 'out')],
    extensions: ['.pptx', '.xlsx'],
    note: '两个成品',
  })
  const d = deliver.structuredContent
  check('tool dsh_deliver_files 按扩展名过滤', d.received === 2, `received=${d.received} missing=${d.missing_files.length}`)
  const snapshotDir = d.snapshot_dir
  check('快照已落盘', existsSync(join(snapshotDir, 'report.pptx')) && existsSync(join(snapshotDir, 'data.xlsx')))
  check('未交付的文件没被收', !existsSync(join(snapshotDir, 'ignore.png')))

  // 派发任务
  const dispatch = await callTool('dsh_dispatch_task', {
    instructions: '把交付的 pptx 转成 pdf',
    title: '转 PDF',
    files: [join(workdir, 'out', 'report.pptx')],
    notes: '字体用默认的',
  })
  const t = dispatch.structuredContent
  check('tool dsh_dispatch_task 建了独立会话', t.session_id === sessionIdFor(t.task_id), t.session_id)
  const created = calls.find((call) => call.op === 'create')
  check('没给 cwd 时落到文件所在目录', normalizePath(created.cwd) === normalizePath(join(workdir, 'out')), created.cwd)
  const prompt = calls.find((call) => call.op === 'prompt')
  check('prompt 内容含任务与文件路径', prompt.content[0].text.includes('把交付的 pptx 转成 pdf') && prompt.content[0].text.includes('report.pptx'))
  const selected = calls.find((call) => call.op === 'selectModel')
  check('按宿主默认模型播种会话', selected?.provider === 'deepseek-account' && selected?.model === 'deepseek-flash')

  // 显式 cwd 优先
  calls.length = 0
  const explicit = await callTool('dsh_dispatch_task', { instructions: '显式目录', cwd: workdir })
  const createdExplicit = calls.find((call) => call.op === 'create')
  check('显式 cwd 优先于文件目录', normalizePath(createdExplicit.cwd) === normalizePath(workdir), createdExplicit.cwd)
  check('多任务各自独立会话', explicit.structuredContent.session_id !== t.session_id)

  await sleep(120)
  const status = await callTool('dsh_task_status', { task_id: t.task_id })
  const s = status.structuredContent
  check('任务终态 done', s.status === 'done', `status=${s.status} error=${s.error ?? '-'}`)
  check('抓到最后一次回复摘要', s.lastReply === '已完成：报告已生成', String(s.lastReply))
  check('任务文件清单已记', s.files.some((file) => file.path.endsWith('report.pptx')))

  const tasks = await callTool('dsh_list_tasks', { limit: 5 })
  check('tool dsh_list_tasks', tasks.structuredContent.tasks.length >= 1)

  // 白名单外必须被拒
  const outside = await callTool('dsh_dispatch_task', { instructions: '越界', cwd: join(tmpdir(), 'elsewhere') })
  check('白名单外 cwd 被拒', outside.isError === true && /白名单/.test(outside.content[0].text))

  // REST 通道
  const rest = await post('/dispatch', { instructions: 'REST 派发测试', source: 'rest' })
  check('REST /dispatch', rest.status === 200 && rest.body.ok === true && rest.body.task_id.startsWith('kw-'))
  const bad = await fetch(`${base}/nope`)
  check('未知路由 404', bad.status === 404)
  const badJson = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
  check('坏 JSON 400', badJson.status === 400)

  // 端点发布：getOrigin() 在 listen 前会抛，必须扛住并等它 listen 后再写文件
  const endpointPath = join(stateDir, ENDPOINT_FILE)
  let listening = false
  const fakeWebServer = {
    get host() {
      return '127.0.0.1'
    },
    get port() {
      return listening ? 34567 : undefined
    },
    get protocol() {
      return 'http:'
    },
    getOrigin() {
      if (!listening) throw new Error('webServer is not listening yet')
      return 'http://127.0.0.1:34567'
    },
  }
  const publisher = createEndpointPublisher({
    webServer: fakeWebServer,
    stateDir,
    apiPath: '/api/kimiwork',
    token: 'unit-test-token',
    logger: { info: () => {}, warn: () => {} },
    fastAttempts: 100,
    fastIntervalMs: 10,
    slowIntervalMs: 1000,
  })
  await sleep(40)
  check('未 listen 时不发布 endpoint.json', !existsSync(endpointPath))
  listening = true
  await sleep(150)
  let meta
  try {
    meta = JSON.parse(readFileSync(endpointPath, 'utf8'))
  } catch (error) {
    meta = undefined
    check('listen 后写 endpoint.json', false, String(error?.message ?? error))
  }
  if (meta !== undefined) {
    check('endpoint.json 带真实基址', meta.baseUrl === 'http://127.0.0.1:34567/api/kimiwork', meta.baseUrl)
    check('endpoint.json 带 mcpUrl/healthUrl', meta.mcpUrl === 'http://127.0.0.1:34567/api/kimiwork/mcp' && meta.healthUrl.endsWith('/health'))
    check('endpoint.json 带端口/pid/令牌', meta.port === 34567 && meta.pid === process.pid && meta.token === 'unit-test-token')
  }
  publisher.dispose()
  check('dispose 清掉 endpoint.json', !existsSync(endpointPath))
} catch (error) {
  check('全链路执行', false, String(error?.stack ?? error))
} finally {
  bridge.stop()
  await new Promise((done) => server.close(done))
  rmSync(sandbox, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：', failed.map((item) => item.name).join(' | '))
  process.exitCode = 1
}
