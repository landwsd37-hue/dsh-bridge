/**
 * 通用小工具：本地循环地址判定、JSON 读写、哈希、ID 生成、路径规范化。
 * 全部只依赖 node: 内置模块，避免给宿主增加依赖。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** 判断请求是否来自本机回环地址（桥接只服务本机）。 */
export function isLoopback(address) {
  if (typeof address !== 'string' || address === '') return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  return value === '127.0.0.1' || value === '::1' || value === 'localhost' || value === '0:0:0:0:0:0:0:1'
}

/** 定时安全比较，长度不同直接判否。 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

export function readJsonFile(path, fallback = undefined) {
  try {
    if (!existsSync(path)) return fallback
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    if (text.trim() === '') return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 先写临时文件再 rename，避免半截 JSON 被读到。 */
export function writeJsonFile(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8' })
  renameSync(tmp, path)
  return path
}

export function appendLine(path, line) {
  ensureDir(dirname(path))
  writeFileSync(path, `${line}\n`, { encoding: 'utf8', flag: 'a' })
}

export function sha256File(path) {
  try {
    const hash = createHash('sha256')
    hash.update(readFileSync(path))
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex')
}

/** 任务 ID：kw-<UTC 紧凑时间>-<6 位随机>，可排序且不撞。 */
export function newTaskId(now = new Date()) {
  const compact = now.toISOString().replace(/[-:TZ.]/g, '')
  const stamp = `${compact.slice(0, 8)}-${compact.slice(8, 14)}`
  return `kw-${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * 任务 ID -> DSH 会话 ID。沿用 im-connect 的 `<前缀>:` 约定，
 * 但不重复任务 ID 自带的 `kw-`，所以得到 `kw:20261016-090038-5ee91e`。
 */
export function sessionIdFor(taskId) {
  const bare = String(taskId ?? '').trim().replace(/^kw[-:]/, '')
  return `kw:${bare}`
}

export function nowIso() {
  return new Date().toISOString()
}

/** 统一成绝对路径 + 正斜杠，便于跨平台比较与展示。 */
export function normalizePath(input) {
  if (typeof input !== 'string' || input.trim() === '') return ''
  const raw = input.trim().replace(/^"|"$/g, '')
  const absolute = isAbsolute(raw) ? raw : resolve(raw)
  const normal = normalize(absolute)
  return normal.length > 3 && normal.endsWith(sep) ? normal.slice(0, -1) : normal
}

/** target 是否位于 root 之内（含 root 自身）。 */
export function isInside(root, target) {
  if (root === '' || target === '') return false
  const a = normalizePath(root)
  const b = normalizePath(target)
  if (a === '' || b === '') return false
  const left = process.platform === 'win32' ? a.toLowerCase() : a
  const right = process.platform === 'win32' ? b.toLowerCase() : b
  if (left === right) return true
  const prefix = left.endsWith(sep) ? left : left + sep
  return right.startsWith(prefix)
}

/** 在候选根目录里找出包含 target 的那个（用于反查归档/工作区）。 */
export function firstRootContaining(roots, target) {
  for (const root of roots ?? []) {
    if (isInside(root, target)) return root
  }
  return undefined
}

export function summarizePath(path) {
  try {
    const info = statSync(path)
    return { path, exists: true, directory: info.isDirectory(), size: info.size, mtime: info.mtime.toISOString() }
  } catch {
    return { path, exists: false, directory: false, size: 0, mtime: undefined }
  }
}

export function joinSafe(...parts) {
  return join(...parts)
}
