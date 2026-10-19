#!/usr/bin/env node
/**
 * 可选的「兜底交付」Stop hook —— 目前**没有**写进 kimi.plugin.json。
 *
 * 为什么单独放着：按 Kimi 插件规范，声明了 hooks 的插件在注册前必须由用户
 * 本人过目（它是会自动执行的代码）。等老大看完这份文件、点头之后，再往
 * kimi.plugin.json 里加：
 *
 *   "hooks": [
 *     { "event": "Stop", "command": "node ./scripts/kimiwork-stop-hook.mjs", "timeout": 30 }
 *   ]
 *
 * 它做什么：Kimi 自己会把每一轮改过的文件记在 file-edit-journal.json 里
 * （key 是 conversation uuid，值里是 turns[].entries[]）。这个 hook 在 Kimi
 * 结束一轮时读那份日志，把「这一轮新建或改动过、且现在还存在的文件」交付给
 * DSH，作为 Kimi 忘记主动调 dsh_deliver_files 时的保险。
 *
 * 设计约束：
 *   - 永远退出码 0。hook 失败绝不能拖累 Kimi 的正常回合。
 *   - 幂等：按 (conversation, turnId) 记账，同一轮只交付一次；桥接侧按路径去重。
 *   - 只读 + 一个 POST，不改任何用户文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeConnection, resolveConnection } from './endpoint.mjs'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CONN = resolveConnection()
const JOURNAL =
  process.env.KIMI_FILE_EDIT_JOURNAL ??
  join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'kimi-desktop', 'kimi-agent', 'file-edit-journal.json')
const STATE = join(PLUGIN_ROOT, '.state', 'stop-hook.json')
const MAX_FILES = 50

const log = (message) => process.stderr.write(`[kimiwork-stop-hook] ${message}\n`)

/** DSH 侧开了 requireToken 就必须带令牌，否则 /deliver 一律 401。 */
function resolveToken() {
  const fromEnv = process.env.DSH_KIMIWORK_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    if (!existsSync(TOKEN_FILE)) return ''
    const text = readFileSync(TOKEN_FILE, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    return typeof parsed?.token === 'string' ? parsed.token.trim() : ''
  } catch {
    return ''
  }
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return text.trim() === '' ? fallback : JSON.parse(text)
  } catch {
    return fallback
  }
}

function latestTurn(turns) {
  let best
  let bestId = -1
  for (const turn of turns ?? []) {
    const id = Number.parseInt(String(turn?.turnId ?? ''), 10)
    if (Number.isFinite(id) && id > bestId) {
      bestId = id
      best = turn
    }
  }
  return best === undefined ? undefined : { turnId: String(best.turnId), entries: best.entries ?? [] }
}

function changedFiles(turn) {
  const paths = new Set()
  for (const entry of turn?.entries ?? []) {
    const path = entry?.path
    if (typeof path !== 'string' || path === '') continue
    if (entry.afterDeleted === true) continue
    const created = entry.existedBefore === false
    const modified = entry.existedBefore === true && entry.before !== entry.after
    if (!created && !modified) continue
    if (!existsSync(path)) continue
    paths.add(path)
    if (paths.size >= MAX_FILES) break
  }
  return [...paths]
}

async function main() {
  const journal = readJson(JOURNAL, undefined)
  if (journal === undefined || typeof journal !== 'object') {
    log(`读不到改动日志（${JOURNAL}），跳过`)
    return
  }
  const state = readJson(STATE, { delivered: {} })
  if (state.delivered === undefined || typeof state.delivered !== 'object') state.delivered = {}

  const queue = []
  for (const [conversation, raw] of Object.entries(journal)) {
    const record = typeof raw === 'string' ? safeParse(raw) : raw
    const turn = latestTurn(record?.turns)
    if (turn === undefined) continue
    const key = `${conversation}#${turn.turnId}`
    if (state.delivered[key] === true) continue
    const files = changedFiles(turn)
    state.delivered[key] = true // 先记账：哪怕没文件也算处理过这一轮
    if (files.length > 0) queue.push({ key, files })
  }

  // 只保留最近记账的 500 条，防止状态文件无限膨胀
  const keys = Object.keys(state.delivered)
  if (keys.length > 500) {
    for (const key of keys.slice(0, keys.length - 500)) delete state.delivered[key]
  }
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(state, null, 2), { encoding: 'utf8' })

  if (queue.length === 0) {
    log('这一轮没有新写入的文件，跳过')
    return
  }
  const files = [...new Set(queue.flatMap((item) => item.files))].slice(0, MAX_FILES)
  const token = CONN.token ?? ''
  const response = await fetch(`${CONN.baseUrl}/deliver`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ files, source: 'kimi-stop-hook', note: 'Kimi 回合结束自动兜底交付' }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => ({}))
  if (response.ok && body?.ok !== false) {
    log(`已兜底交付 ${body.received ?? files.length} 个文件 → delivery ${body.delivery_id ?? '-'}`)
  } else {
    log(`交付被拒（HTTP ${response.status}）：${body?.error ?? '未知原因'}`)
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

try {
  await main()
} catch (error) {
  log(`兜底交付失败（已忽略）：${error?.message ?? error}（端点 ${describeConnection(CONN)}）`)
}
process.exit(0)
