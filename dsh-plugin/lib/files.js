/**
 * 文件交付：把 Kimi 给的路径清单变成"可核验的交付".
 *
 * 两级策略（老大拍板）：
 *   1. 路径清单必存 —— 绝对路径 + 是否存在 + 类型 + 大小 + mtime + sha256。
 *   2. 关键文件另存快照 —— 小于阈值（默认 8MB）的文件复制进 inbox，防止 Kimi 事后改动/清理。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { ensureDir, isInside, normalizePath, sha256File, summarizePath } from './util.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.cache'])
const DEFAULT_MAX_FILES = 300
const DEFAULT_MAX_DEPTH = 6

/**
 * 把输入条目展开成文件清单。
 * 条目可以是文件，也可以是目录（目录默认递归，带深度/数量上限）。
 */
export function expandEntries(entries, options = {}) {
  const {
    recursive = true,
    maxFiles = DEFAULT_MAX_FILES,
    maxDepth = DEFAULT_MAX_DEPTH,
    extensions = [],
    base = '',
  } = options
  const wanted = new Set(extensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)))
  const found = []
  const missing = []

  const accept = (path) => {
    if (wanted.size === 0) return true
    const name = basename(path).toLowerCase()
    if (name.startsWith('.')) return false
    const dot = name.lastIndexOf('.')
    return dot !== -1 && wanted.has(name.slice(dot))
  }

  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxFiles) return
    let items = []
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (found.length >= maxFiles) return
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        if (!recursive) continue
        if (SKIP_DIRS.has(item.name)) continue
        walk(full, depth + 1)
      } else if (item.isFile() && accept(full)) {
        found.push(full)
      }
    }
  }

  for (const entry of entries ?? []) {
    const path = normalizePath(entry)
    if (path === '') continue
    if (!existsSync(path)) {
      missing.push(path)
      continue
    }
    let info
    try {
      info = statSync(path)
    } catch {
      missing.push(path)
      continue
    }
    if (info.isDirectory()) {
      walk(path, 1)
    } else if (accept(path)) {
      found.push(path)
    }
  }

  const unique = [...new Set(found)].slice(0, maxFiles)
  return {
    files: unique,
    missing,
    truncated: found.length > maxFiles,
    ...(base === '' ? {} : {}),
  }
}

/** 路径清单：绝对路径 + 存在性 + 大小 + mtime + sha256（可选）。 */
export function buildManifest(paths, options = {}) {
  const { hashes = true, maxHashBytes = 64 * 1024 * 1024 } = options
  return paths.map((path) => {
    const summary = summarizePath(path)
    const entry = {
      path: summary.path,
      existed: summary.exists,
      directory: summary.directory,
      size: summary.size,
      mtime: summary.mtime,
    }
    if (summary.exists && !summary.directory && hashes && summary.size <= maxHashBytes) {
      entry.sha256 = sha256File(path)
    }
    return entry
  })
}

/**
 * 关键文件快照：复制进 <inbox>/<taskId>/files/，保留相对 root 的目录结构。
 * 返回 path -> 快照绝对路径 的映射。
 */
export function snapshotFiles(paths, options = {}) {
  const { inboxDir, root = '', maxBytes = 8 * 1024 * 1024, maxTotalBytes = 128 * 1024 * 1024 } = options
  const mapping = new Map()
  if (inboxDir === undefined || inboxDir === '') return mapping
  ensureDir(inboxDir)
  let total = 0
  for (const path of paths) {
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > maxBytes || total + info.size > maxTotalBytes) continue
    const rel = root !== '' && isInside(root, path) ? relative(normalizePath(root), normalizePath(path)) : basename(path)
    const safeRel = rel.replace(/[:*?"<>|]/g, '_').replace(/^[/\\]+/, '')
    const target = join(inboxDir, safeRel === '' ? basename(path) : safeRel)
    try {
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(path, target)
      mapping.set(path, target)
      total += info.size
    } catch {
      /* 单个文件复制失败不影响其余交付 */
    }
  }
  return mapping
}

export function describeSnapshotIndex(mapping) {
  return mapping instanceof Map ? Object.fromEntries(mapping) : {}
}
