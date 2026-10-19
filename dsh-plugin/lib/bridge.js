/**
 * 桥接主体：HTTP 路由 + MCP 工具实现 + DSH 会话派发 + 文件交付台账。
 *
 * 设计要点（对应老大拍板的六条）：
 *   - 口令/技能为主、hook 兜底：这里提供 MCP 工具与 REST 两条同源通道，hook 走 /deliver。
 *   - 路径清单 + 关键文件快照：见 files.js。
 *   - 每次派发新建独立会话：sessionId = `kw:<taskId>`。
 *   - 白名单：cwd 必须落在 allowedRoots 内。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { TaskStore, TASK_STATUS } from './store.js'
import { buildManifest, describeSnapshotIndex, expandEntries, snapshotFiles } from './files.js'
import { buildToolResult, handleMessage } from './mcp.js'
import {
  ensureDir,
  firstRootContaining,
  isInside,
  isLoopback,
  newTaskId,
  normalizePath,
  nowIso,
  randomToken,
  readJsonFile,
  safeEqual,
  sessionIdFor,
  writeJsonFile,
} from './util.js'

const MAX_BODY_BYTES = 16 * 1024 * 1024

export class Bridge {
  constructor(ctx, config, stateDir) {
    this.ctx = ctx
    this.config = config
    this.stateDir = stateDir
    this.store = new TaskStore(stateDir)
    this.tasksDir = ensureDir(join(stateDir, 'tasks'))
    this.inboxDir = ensureDir(join(stateDir, 'inbox'))
    this.pending = new Map()
    this.disposers = []
    this.token = this.#loadOrCreateToken()
  }

  #loadOrCreateToken() {
    if (typeof this.config.token === 'string' && this.config.token.trim() !== '') return this.config.token.trim()
    const path = join(this.stateDir, 'token')
    const existing = readJsonFile(path)
    if (typeof existing?.token === 'string' && existing.token !== '') return existing.token
    const token = randomToken(24)
    writeJsonFile(path, { token, createdAt: nowIso() })
    return token
  }

  start() {
    const onStatus = ({ agent, status }) => {
      const sessionId = agent?.id
      if (sessionId === undefined) return
      const taskId = this.pending.get(sessionId)
      if (taskId === undefined) return
      if (status === 'running') {
        this.store.patch(taskId, { status: TASK_STATUS.running })
        return
      }
      void this.#finalize(taskId, sessionId)
    }
    const onError = ({ agent, error }) => {
      const taskId = this.pending.get(agent?.id)
      if (taskId === undefined) return
      this.pending.delete(agent.id)
      this.store.patch(taskId, {
        status: TASK_STATUS.failed,
        error: typeof error === 'string' ? error : (error?.message ?? String(error)),
        finishedAt: nowIso(),
      })
    }
    this.ctx.on('agent/status', onStatus)
    this.ctx.on('agent/error', onError)
    this.disposers.push(() => {
      this.ctx.off('agent/status', onStatus)
      this.ctx.off('agent/error', onError)
    })
  }

  stop() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 卸载阶段的异常不往外抛 */
      }
    }
  }

  // ───────────────────────── HTTP 层 ─────────────────────────

  #send(res, status, payload, contentType = 'application/json; charset=utf-8') {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  #authorize(req, url) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      return { ok: false, status: 403, message: 'bridge 只接受本机回环地址的请求' }
    }
    if (this.config.requireToken !== true) return { ok: true }
    const header = req.headers?.authorization
    const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
    const provided = bearer ?? req.headers?.['x-dsh-kimiwork-token'] ?? url.searchParams.get('token') ?? ''
    if (!safeEqual(provided, this.token)) {
      return { ok: false, status: 401, message: '缺少或错误的 Authorization: Bearer <token>' }
    }
    return { ok: true }
  }

  async #readBody(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        const error = new Error('请求体过大')
        error.code = 'bridge/bad-request'
        throw error
      }
      chunks.push(chunk)
    }
    if (total === 0) return undefined
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
    if (text.trim() === '') return undefined
    try {
      return JSON.parse(text)
    } catch (error) {
      const wrapped = new Error(`请求体不是合法 JSON：${String(error)}`)
      wrapped.code = 'bridge/bad-request'
      throw wrapped
    }
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const base = this.config.apiPath
    const suffix = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : ''
    const route = suffix === '' || suffix === '/' ? '/info' : suffix.replace(/\/+$/, '')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        allow: 'GET,POST,OPTIONS',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,authorization,x-dsh-kimiwork-token',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      })
      res.end()
      return
    }

    const auth = this.#authorize(req, url)
    if (!auth.ok) {
      this.#send(res, auth.status, { ok: false, error: auth.message })
      return
    }

    try {
      if (route === '/outbox') {
        await this.#handleOutbox(req, res)
        return
      }
      if (req.method === 'POST') {
        const body = await this.#readBody(req)
        if (route === '/mcp') {
          await this.#handleMcp(res, body)
          return
        }
        if (route === '/dispatch') {
          this.#send(res, 200, { ok: true, ...(await this.dispatch(body ?? {})) })
          return
        }
        if (route === '/deliver') {
          this.#send(res, 200, { ok: true, ...(await this.deliver(body ?? {})) })
          return
        }
        this.#send(res, 404, { ok: false, error: `未知路由：POST ${url.pathname}` })
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === '/health' || route === '/info') {
          this.#send(res, 200, { ok: true, ...this.info() })
          return
        }
        if (route === '/tasks') {
          const limit = Number(url.searchParams.get('limit') ?? 20)
          this.#send(res, 200, { ok: true, tasks: this.listTasks({ limit }).tasks })
          return
        }
        if (route.startsWith('/tasks/')) {
          const id = decodeURIComponent(route.slice('/tasks/'.length))
          this.#send(res, 200, { ok: true, task: this.status({ task_id: id }).task })
          return
        }
        if (route === '/mcp') {
          this.#send(res, 405, { ok: false, error: 'MCP 通道请用 POST' })
          return
        }
      }

      this.#send(res, 404, { ok: false, error: `未知路由：${req.method} ${url.pathname}` })
    } catch (error) {
      const status = error?.code === 'task/not-found' ? 404 : error?.code === 'bridge/bad-request' ? 400 : 500
      this.store.log('http/error', { route, message: String(error?.message ?? error), stack: String(error?.stack ?? '') })
      this.#send(res, status, { ok: false, error: String(error?.message ?? error) })
    }
  }

  async #handleMcp(res, body) {
    if (body === undefined) {
      this.#send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: 空请求体' } })
      return
    }
    const batch = Array.isArray(body)
    const messages = batch ? body : [body]
    const responses = []
    for (const message of messages) {
      const response = await handleMessage(message, {
        callTool: (name, args) => this.callTool(name, args),
      })
      if (response !== undefined) responses.push(response)
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'content-length': 0 })
      res.end()
      return
    }
    this.#send(res, 200, batch ? responses : responses[0])
  }

  /**
   * 回传通道：DSH 侧要主动把东西交给 Kimi 时用（目前是写文件到 outbox，
   * Kimi 用 SessionStart hook 或 skill 里的脚本取走）。
   */
  async #handleOutbox(req, res) {
    if (req.method === 'GET') {
      const file = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('file')
      this.#send(res, 200, { ok: true, outbox: join(this.stateDir, 'outbox'), file })
      return
    }
    this.#send(res, 405, { ok: false, error: 'outbox 目前只读' })
  }

  // ───────────────────────── 工具实现 ─────────────────────────

  async callTool(name, args) {
    try {
      switch (name) {
        // 回包形状与 bridge-api.md 逐字一致：MCP 工具直接给领域对象，
        // 失败靠 MCP 的 isError 表达（这是 MCP 的惯用法）；REST 路由才加 ok 字段。
        case 'dsh_dispatch_task':
          return buildToolResult(await this.dispatch(args))
        case 'dsh_deliver_files':
          return buildToolResult(await this.deliver(args))
        case 'dsh_task_status':
          return buildToolResult(this.status(args).task)
        case 'dsh_list_tasks':
          return buildToolResult(this.listTasks(args))
        case 'dsh_bridge_info':
          return buildToolResult(this.info())
        default:
          return buildToolResult({ error: `未知工具：${name}` }, { isError: true })
      }
    } catch (error) {
      return buildToolResult({ error: String(error?.message ?? error) }, { isError: true })
    }
  }

  /** 读取 DSH 侧运行时信息：工作区、白名单、默认目录。 */
  info() {
    let workspaces = []
    try {
      workspaces = (this.ctx.get?.('workspaceRegistry')?.list?.() ?? []).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
      }))
    } catch {
      workspaces = []
    }
    return {
      server: 'dsh-kimiwork-bridge',
      version: '0.1.0',
      stateDir: this.stateDir,
      apiPath: this.config.apiPath,
      allowedRoots: this.config.allowedRoots ?? [],
      defaultCwd: this.defaultCwd(),
      snapshotMaxBytes: this.config.maxSnapshotBytes,
      requireToken: this.config.requireToken === true,
      workspaces,
      pending: [...this.pending.entries()].map(([sessionId, taskId]) => ({ sessionId, taskId })),
    }
  }

  defaultCwd() {
    if (this.config.cwd.trim() !== '') return normalizePath(this.config.cwd)
    const roots = this.config.allowedRoots ?? []
    if (roots.length > 0) return normalizePath(roots[0])
    return normalizePath(process.cwd())
  }

  #assertAllowed(cwd) {
    const roots = (this.config.allowedRoots ?? []).map((root) => normalizePath(root)).filter((root) => root !== '')
    if (roots.length === 0) return
    if (!firstRootContaining(roots, cwd)) {
      const error = new Error(
        `工作目录 "${cwd}" 不在允许执行的根目录白名单内。允许的根：${roots.join(' | ')}（改白名单请编辑 profile 的 cordis.patch.yml 里 kimiwork-bridge 的 config.allowedRoots）`,
      )
      error.code = 'bridge/bad-request'
      throw error
    }
  }

  /** 目录：显式 cwd > 交付目录本身 > 文件公共父目录 > 配置默认。 */
  #resolveCwd(args, files) {
    if (typeof args.cwd === 'string' && args.cwd.trim() !== '') return normalizePath(args.cwd)
    if (this.config.cwd.trim() !== '') return normalizePath(this.config.cwd)
    const ancestors = new Set()
    for (const file of files) {
      try {
        const info = statSync(file)
        ancestors.add(info.isDirectory() ? file : dirname(file))
      } catch {
        ancestors.add(dirname(file))
      }
    }
    if (ancestors.size === 1) return normalizePath([...ancestors][0])
    return this.defaultCwd()
  }

  /** 收集文件：展开目录 + 建清单 + 快照。 */
  #collect(args, { inbox, enforceRoot } = {}) {
    const entries = Array.isArray(args.files) ? args.files : []
    const expanded = expandEntries(entries, {
      recursive: args.recursive !== false,
      extensions: Array.isArray(args.extensions) ? args.extensions : [],
      maxFiles: this.config.maxFiles,
    })
    const manifest = buildManifest(expanded.files, { hashes: true })
    const roots = (this.config.allowedRoots ?? []).map((root) => normalizePath(root)).filter((root) => root !== '')
    for (const entry of manifest) {
      if (roots.length > 0 && !firstRootContaining(roots, entry.path)) entry.outsideRoots = true
      if (enforceRoot === true && entry.outsideRoots === true) {
        const error = new Error(`文件 "${entry.path}" 不在允许的根目录白名单内`)
        error.code = 'bridge/bad-request'
        throw error
      }
    }
    let snapshots = new Map()
    if (args.snapshot !== false && this.config.snapshotFiles !== false && inbox !== undefined) {
      snapshots = snapshotFiles(manifest.filter((entry) => entry.existed && entry.directory === false).map((entry) => entry.path), {
        inboxDir: inbox,
        root: this.config.cwd.trim() === '' ? '' : this.config.cwd,
        maxBytes: this.config.maxSnapshotBytes,
      })
    }
    const index = describeSnapshotIndex(snapshots)
    for (const entry of manifest) {
      if (index[entry.path] !== undefined) entry.snapshot = index[entry.path]
    }
    return { manifest, missing: expanded.missing, truncated: expanded.truncated, snapshots: index }
  }

  /** 派发任务：新建独立会话 + 注入任务文本。 */
  async dispatch(args) {
    const controller = this.ctx.get?.('sessionController')
    if (controller === undefined) {
      const error = new Error('宿主没有 sessionController 服务，无法派发任务')
      error.code = 'bridge/bad-request'
      throw error
    }
    const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : ''
    if (instructions === '') {
      const error = new Error('instructions 不能为空')
      error.code = 'bridge/bad-request'
      throw error
    }
    const taskId = typeof args.task_id === 'string' && args.task_id.trim() !== '' ? args.task_id.trim() : newTaskId()
    const sessionId = sessionIdFor(taskId)
    const collected = this.#collect(args, { inbox: join(this.inboxDir, taskId, 'files') })
    const cwd = this.#resolveCwd(args, collected.manifest.map((entry) => entry.path))
    this.#assertAllowed(cwd)

    const record = this.store.create({
      id: taskId,
      sessionId,
      title: typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : instructions.slice(0, 60),
      source: args.source ?? 'mcp',
      cwd,
      instructions,
      notes: typeof args.notes === 'string' ? args.notes : undefined,
      files: collected.manifest,
      missingFiles: collected.missing,
      truncated: collected.truncated === true,
      status: TASK_STATUS.accepted,
    })

    const workspaceId = typeof args.workspace_id === 'string' && args.workspace_id.trim() !== '' ? args.workspace_id.trim() : undefined
    let created
    try {
      created = await controller.create({
        sessionId,
        ...(workspaceId === undefined ? { cwd } : { workspaceId }),
        ...(this.config.agentPreset.trim() === '' ? {} : { agentPreset: this.config.agentPreset.trim() }),
      })
    } catch (error) {
      this.store.patch(taskId, { status: TASK_STATUS.failed, error: String(error?.message ?? error), finishedAt: nowIso() })
      throw error
    }
    const resolvedSessionId = created?.sessionId ?? sessionId

    await this.#selectDefaultModel(controller, resolvedSessionId)

    this.pending.set(resolvedSessionId, taskId)
    const prompt = this.#composePrompt(record)
    try {
      // sessionController.prompt(request, signal)：第二个参数是必需的
      // AbortSignal（remote 实现在开头就 signal.throwIfAborted()），不传会 500。
      await controller.prompt(
        {
          sessionId: resolvedSessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
        AbortSignal.timeout(typeof this.config.promptTimeoutMs === 'number' && this.config.promptTimeoutMs > 0 ? this.config.promptTimeoutMs : 30_000),
      )
    } catch (error) {
      this.pending.delete(resolvedSessionId)
      this.store.patch(taskId, { status: TASK_STATUS.failed, error: String(error?.message ?? error), finishedAt: nowIso() })
      throw error
    }

    const saved = this.store.patch(taskId, { status: TASK_STATUS.running, sessionId: resolvedSessionId, startedAt: nowIso() })
    return {
      task_id: taskId,
      session_id: resolvedSessionId,
      status: saved.status,
      cwd,
      file_count: (saved.files ?? []).length,
      missing_files: saved.missingFiles ?? [],
      snapshot_dir: join(this.inboxDir, taskId, 'files'),
      hint: 'DSH 已在独立会话里开跑；用 dsh_task_status 追问进度，或在 DSH Web 界面按 session id 打开。',
    }
  }

  async #selectDefaultModel(controller, sessionId) {
    try {
      const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
      const provider = this.config.provider?.trim() || selection?.provider
      const model = this.config.model?.trim() || selection?.model
      if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
      await controller.selectModel({
        sessionId,
        provider,
        model,
        ...(typeof selection?.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      })
    } catch (error) {
      this.store.log('model/select-failed', { sessionId, message: String(error?.message ?? error) })
    }
  }

  #composePrompt(record) {
    const files = record.files ?? []
    const lines = []
    lines.push(`【来自 Kimi Work 的任务派发 · task_id: ${record.id}】`)
    if (record.title) lines.push(`标题：${record.title}`)
    lines.push('', '## 任务', record.instructions)
    if (files.length > 0) {
      lines.push('', `## 这次一并交付给你的文件（本机绝对路径，可直接读取；共 ${files.length} 个）`)
      for (const file of files.slice(0, 200)) {
        const size = typeof file.size === 'number' ? `${file.size} B` : '未知大小'
        const extra = file.snapshot === undefined ? '' : `\n    ↳ 快照副本：${file.snapshot}`
        const flag = file.outsideRoots === true ? '（白名单外，仅作交付参考）' : ''
        lines.push(`- ${file.path}${flag} — ${size}${file.mtime ? `, mtime=${file.mtime}` : ''}${extra}`)
      }
      if (files.length > 200) lines.push(`- …另有 ${files.length - 200} 个文件，完整清单见 ${this.store.pathFor(record.id)}`)
    }
    if (record.missingFiles?.length > 0) {
      lines.push('', '## 注意：以下路径 Kimi 给了但本机不存在', ...record.missingFiles.map((path) => `- ${path}`))
    }
    if (record.notes) lines.push('', '## Kimi 的补充说明', record.notes)
    lines.push(
      '',
      '## 执行要求',
      `- 工作目录：${record.cwd}`,
      '- 直接动手做，不要反问"要不要我做"；只有真的缺关键信息或需要不可逆的高风险操作时才停下来问。',
      '- 完成后在回复里给出：做了什么、产出文件的绝对路径、以及需要老大或 Kimi 确认的点。',
    )
    return lines.join('\n')
  }

  /** 只交付文件，不派任务。 */
  async deliver(args) {
    const entries = Array.isArray(args.files) ? args.files : []
    if (entries.length === 0) {
      const error = new Error('files 不能为空')
      error.code = 'bridge/bad-request'
      throw error
    }
    const taskId = typeof args.task_id === 'string' && args.task_id.trim() !== '' ? args.task_id.trim() : undefined
    const key = taskId ?? newTaskId()
    const collected = this.#collect(args, { inbox: join(this.inboxDir, key, 'files') })

    if (taskId !== undefined) {
      const record = this.store.recordFiles(taskId, collected.manifest, typeof args.note === 'string' ? args.note : undefined)
      return {
        delivery_id: taskId,
        task_id: taskId,
        status: record.status,
        file_count: (record.files ?? []).length,
        received: collected.manifest.length,
        missing_files: collected.missing,
        snapshot_dir: join(this.inboxDir, key, 'files'),
      }
    }

    const delivery = this.store.createDelivery({
      id: key,
      source: args.source ?? 'mcp',
      note: typeof args.note === 'string' ? args.note : undefined,
      files: collected.manifest,
      missingFiles: collected.missing,
      truncated: collected.truncated === true,
    })
    return {
      delivery_id: delivery.id,
      status: 'delivered',
      received: collected.manifest.length,
      missing_files: collected.missing,
      snapshot_dir: join(this.inboxDir, key, 'files'),
    }
  }

  status(args) {
    const id = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    if (id === '') {
      const error = new Error('task_id 不能为空')
      error.code = 'bridge/bad-request'
      throw error
    }
    this.#refreshFromAgent(id)
    return { task: this.store.describe(id) }
  }

  /** 会话已经停了但状态没落终态时补一次（例如插件是中途加载的）。 */
  #refreshFromAgent(taskId) {
    const record = this.store.get(taskId)
    if (record === undefined || record.sessionId === undefined) return
    if (record.status === TASK_STATUS.done || record.status === TASK_STATUS.failed) return
    const agent = this.ctx.get?.('agents')?.get?.(record.sessionId)
    if (agent === undefined) return
    if (agent.status === 'running') {
      if (record.status !== TASK_STATUS.running) this.store.patch(taskId, { status: TASK_STATUS.running })
      return
    }
    void this.#finalize(taskId, record.sessionId)
  }

  listTasks(args = {}) {
    const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 20
    return { tasks: this.store.list(limit).map((record) => this.store.describe(record.id)) }
  }

  /** 会话停下来了：抓最后一次回复摘要，落终态。 */
  async #finalize(taskId, sessionId) {
    if (!this.pending.has(sessionId)) return
    this.pending.delete(sessionId)
    const record = this.store.get(taskId)
    if (record === undefined) return
    let lastReply
    try {
      const controller = this.ctx.get?.('sessionController')
      const state = await controller?.inspect?.(sessionId)
      lastReply = extractLastAssistantText(state?.events)
    } catch (error) {
      this.store.log('finalize/inspect-failed', { taskId, message: String(error?.message ?? error) })
    }
    // 会话跑完后 Kimi 或 DSH 自己可能又写了新文件，做一次轻量重扫。
    let files = record.files ?? []
    try {
      const existing = files.map((file) => file.path).filter((path) => existsSync(path))
      if (existing.length > 0) {
        const refreshed = buildManifest(existing, { hashes: true })
        const index = new Map(files.map((file) => [file.path, file]))
        files = refreshed.map((entry) => ({ ...index.get(entry.path), ...entry }))
      }
    } catch {
      /* 重扫失败就用原清单 */
    }
    this.store.patch(taskId, {
      status: TASK_STATUS.done,
      finishedAt: nowIso(),
      files,
      ...(lastReply === undefined ? {} : { lastReply }),
    })
  }
}

/** 从会话事件里尽力捞最后一段助手文本（事件结构随版本变化，取不到就返回 undefined）。 */
export function extractLastAssistantText(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0 && index >= events.length - 40; index -= 1) {
    const event = events[index]
    const role = event?.data?.message?.role ?? event?.data?.role
    if (role !== undefined && role !== 'assistant') {
      if (role === 'user') return undefined
      continue
    }
    const content = event?.data?.message?.content ?? event?.data?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text !== '') return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  }
  return undefined
}
