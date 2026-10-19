/**
 * 任务台账：每条派发/交付落一个 JSON 文件，同时维护一份内存索引。
 * 之所以落盘而不是只放内存：DSH 重启后 Kimi 仍能按 taskId 追问结果。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appendLine, ensureDir, nowIso, readJsonFile, summarizePath, writeJsonFile } from './util.js'

export const TASK_STATUS = {
  accepted: 'accepted',
  running: 'running',
  done: 'done',
  failed: 'failed',
  delivered: 'delivered',
}

export class TaskStore {
  constructor(stateDir) {
    this.stateDir = stateDir
    this.tasksDir = ensureDir(join(stateDir, 'tasks'))
    this.deliveriesDir = ensureDir(join(stateDir, 'deliveries'))
    this.inboxDir = ensureDir(join(stateDir, 'inbox'))
    this.logPath = join(stateDir, 'log.ndjson')
    this.cache = new Map()
    this.#load()
  }

  #load() {
    let names = []
    try {
      names = readdirSync(this.tasksDir).filter((name) => name.endsWith('.json'))
    } catch {
      names = []
    }
    for (const name of names) {
      const record = readJsonFile(join(this.tasksDir, name))
      if (record?.id) this.cache.set(record.id, record)
    }
  }

  log(event, data = {}) {
    try {
      appendLine(this.logPath, JSON.stringify({ time: nowIso(), event, ...data }))
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  pathFor(id) {
    return join(this.tasksDir, `${id}.json`)
  }

  get(id) {
    if (this.cache.has(id)) return this.cache.get(id)
    const record = readJsonFile(this.pathFor(id))
    if (record?.id) this.cache.set(record.id, record)
    return record
  }

  require(id) {
    const record = this.get(id)
    if (record === undefined) {
      const error = new Error(`未知任务 id：${id}`)
      error.code = 'task/not-found'
      throw error
    }
    return record
  }

  save(record) {
    const next = { ...record, updatedAt: nowIso() }
    this.cache.set(next.id, next)
    writeJsonFile(this.pathFor(next.id), next)
    return next
  }

  create(fields) {
    const record = {
      status: TASK_STATUS.accepted,
      createdAt: nowIso(),
      files: [],
      ...fields,
    }
    record.updatedAt = record.createdAt
    this.cache.set(record.id, record)
    writeJsonFile(this.pathFor(record.id), record)
    this.log('task/created', { id: record.id, sessionId: record.sessionId, source: record.source })
    return record
  }

  patch(id, fields) {
    const current = this.require(id)
    return this.save({ ...current, ...fields })
  }

  list(limit = 50) {
    return [...this.cache.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(500, limit)))
  }

  /** 记录一次文件交付；文件清单进任务，快照目录由调用方准备。 */
  recordFiles(id, files, note) {
    const current = this.require(id)
    const known = new Map((current.files ?? []).map((item) => [item.path, item]))
    for (const file of files) {
      const previous = known.get(file.path)
      known.set(file.path, previous === undefined ? file : { ...previous, ...file })
    }
    const merged = [...known.values()]
    const record = this.save({
      ...current,
      files: merged,
      lastDeliveryAt: nowIso(),
      ...(note === undefined ? {} : { lastDeliveryNote: note }),
      ...(current.status === TASK_STATUS.accepted ? { status: TASK_STATUS.delivered } : {}),
    })
    this.log('task/files', { id, count: files.length })
    return record
  }

  /** 交付但不想建任务时，单独存一条 delivery。 */
  createDelivery(fields) {
    const record = { createdAt: nowIso(), ...fields }
    writeJsonFile(join(this.deliveriesDir, `${record.id}.json`), record)
    this.log('delivery/created', { id: record.id, count: (record.files ?? []).length })
    return record
  }

  deliveryPath(id) {
    return join(this.deliveriesDir, `${id}.json`)
  }

  getDelivery(id) {
    const path = this.deliveryPath(id)
    return existsSync(path) ? readJsonFile(path) : undefined
  }

  describe(id) {
    const record = this.require(id)
    return {
      taskId: record.id,
      status: record.status,
      title: record.title,
      sessionId: record.sessionId,
      cwd: record.cwd,
      source: record.source,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
      fileCount: (record.files ?? []).length,
      files: (record.files ?? []).map((file) => ({
        path: file.path,
        size: file.size,
        mtime: file.mtime,
        snapshot: file.snapshot,
        existed: file.existed,
      })),
      lastReply: record.lastReply,
      error: record.error,
    }
  }

  statFiles(paths) {
    return paths.map((path) => summarizePath(path))
  }
}
