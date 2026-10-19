#!/usr/bin/env node
/**
 * 把**已部署进 profile 的真实插件入口**拉起来跑一遍（不重启 DSH）：
 * 用真 http.Server 冒充 DSH 的 webServer，套上最小 ctx，然后验证
 * 路由挂载、endpoint.json 发布、/health、/mcp tools/list、卸载清理。
 *
 *   node tools/verify-plugin.mjs [--entry <绝对路径>]
 *
 * 默认入口：<profile>/node_modules/dsh-kimiwork-bridge/lib/builds/<最新哈希>/index.js
 * 退出码：0 通过 / 1 失败。
 */
import { createServer } from 'node:http'
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const PROFILE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')
const PACKAGE_DIR = join(PROFILE, 'node_modules', 'dsh-kimiwork-bridge')

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function latestBuildEntry() {
  const builds = join(PACKAGE_DIR, 'lib', 'builds')
  if (!existsSync(builds)) return undefined
  const dirs = readdirSync(builds)
    .map((name) => ({ name, path: join(builds, name), mtime: statSync(join(builds, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const dir of dirs) {
    const entry = join(dir.path, 'index.js')
    if (existsSync(entry)) return entry
  }
  return undefined
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const entryArg = argValue('--entry')
const entry = entryArg !== undefined ? resolve(entryArg) : latestBuildEntry()
if (entry === undefined || !existsSync(entry)) {
  console.error(`找不到插件入口：${entry ?? '(未指定，且 ${PACKAGE_DIR}/lib/builds 里没有构建)'}`)
  process.exit(1)
}
console.log(`插件入口：${entry}`)

// ── 冒充 DSH webServer：prefix 路由 + 真实 listen ─────────────
const routes = []
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const hit = routes.find((route) => path === route.path || path.startsWith(`${route.path}/`))
  if (hit !== undefined) {
    void hit.handler(req, res)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('no route')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port

const webServer = {
  get port() {
    return port
  },
  get host() {
    return '127.0.0.1'
  },
  get protocol() {
    return 'http:'
  },
  getOrigin() {
    return `http://127.0.0.1:${port}`
  },
  register(route) {
    routes.push({ path: route.path, handler: route.handler })
    return () => {
      const index = routes.findIndex((item) => item.path === route.path)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}

// ── 最小 ctx ────────────────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), 'kwbridge-verify-'))
const logs = []
const disposers = []
const services = { webServer }
const ctx = {
  get: (name) => services[name],
  on: () => () => {},
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  logger: () => ({
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  }),
}
Object.defineProperty(ctx, 'webServer', { get: () => webServer })

const mod = await import(pathToFileURL(entry).href)
check('导出 name = kimiwork-bridge', mod.name === 'kimiwork-bridge', String(mod.name))
check('inject 含 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'))
check('导出 Config 与 apply', typeof mod.Config === 'function' && typeof mod.apply === 'function')

const config = new mod.Config({ stateDir, apiPath: '/api/kimiwork', requireToken: false, allowedRoots: [] })
mod.apply(ctx, config)

// endpoint.json 等 listen（这里 server 早就 listen 了，应该在第一次 tick 就写）
const endpointPath = join(stateDir, 'endpoint.json')
let meta
for (let i = 0; i < 40; i += 1) {
  if (existsSync(endpointPath)) {
    meta = JSON.parse(readFileSync(endpointPath, 'utf8'))
    break
  }
  await sleep(50)
}
check('publisher 写出 endpoint.json', meta !== undefined)
if (meta !== undefined) {
  check('endpoint.json baseUrl 指向真实端口', meta.baseUrl === `http://127.0.0.1:${port}/api/kimiwork`, meta.baseUrl)
  check('endpoint.json 记录 pid/port/protocol', meta.pid === process.pid && meta.port === port && meta.protocol === 'http:')
  check('endpoint.json 带令牌', typeof meta.token === 'string' && meta.token.length > 0)
}

const health = await fetch(`http://127.0.0.1:${port}/api/kimiwork/health`)
const healthBody = await health.json()
check('GET /health 200', health.status === 200, `HTTP ${health.status}`)
check('health 报出 server 名', healthBody?.server === 'dsh-kimiwork-bridge', JSON.stringify(healthBody).slice(0, 160))

const rpc = await fetch(`http://127.0.0.1:${port}/api/kimiwork/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
})
const rpcBody = await rpc.json()
check('POST /mcp tools/list 200', rpc.status === 200, `HTTP ${rpc.status}`)
check('tools/list 返回 5 个工具', rpcBody?.result?.tools?.length === 5, `实际 ${rpcBody?.result?.tools?.length}`)

check('日志里出现 endpoint published', logs.some((line) => line.includes('endpoint published')))

// 卸载：应该撤掉路由并清掉 endpoint.json
for (const dispose of disposers.reverse()) dispose()
await sleep(120)
check('卸载后 endpoint.json 被清掉', !existsSync(endpointPath))
check('卸载后路由被摘除', routes.length === 0, `剩余 ${routes.length} 条`)

server.close()
rmSync(stateDir, { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败项：${failed.map((item) => item.name).join(' | ')}`)
  process.exit(1)
}
