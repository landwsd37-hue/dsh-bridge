/**
 * MCP 层：把桥接能力暴露成 Kimi Work 能直接调用的原生工具。
 *
 * 只实现本地/无状态必需的几件事：initialize、tools/list、tools/call、ping。
 * 传输用 MCP 的 streamable-HTTP 最简形态：POST 一条（或一批）JSON-RPC，
 * 同一 HTTP 响应里回 JSON；通知类消息回 202 空体。
 */
export const PROTOCOL_VERSION = '2025-06-18'
export const SERVER_NAME = 'dsh-kimiwork-bridge'
export const SERVER_VERSION = '0.1.0'

export const TOOLS = [
  {
    name: 'dsh_dispatch_task',
    description:
      '把一个任务派发给 DSH（DeepSeek Harness）。会新建一个独立的 DSH 会话并立刻开跑，' +
      '会话可在 DSH 的 Web 界面里看到和继续对话。返回 task_id 和 session_id。' +
      '如果这次任务已经产出了文件，把它们作为绝对路径放进 files，桥接会把路径清单和关键文件快照一起收下。',
    inputSchema: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description: '要 DSH 做的事，写清楚目标、约束和验收标准；DSH 那边看到的就是这段文本。',
        },
        title: { type: 'string', description: '任务标题，用于列表展示。' },
        cwd: { type: 'string', description: 'DSH 会话的工作目录（绝对路径）。默认取 files 的公共父目录。' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '本次交付给 DSH 的文件/目录绝对路径；填目录会按递归展开。',
        },
        notes: { type: 'string', description: '给 DSH 的补充说明或上下文。' },
        workspace_id: { type: 'string', description: '可选：把会话挂到 DSH 里某个已注册工作区（用 dsh_bridge_info 查 id）。' },
      },
      required: ['instructions'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_deliver_files',
    description:
      '只交付文件，不派发任务。桥接会记录绝对路径清单（大小/mtime/sha256），' +
      '并把小于阈值的文件另存快照，之后 DSH 侧随时能按 delivery_id 或 task_id 取回。',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '文件或目录的绝对路径列表。' },
        task_id: { type: 'string', description: '可选：挂到已存在的 task_id 上。不填则新建一条独立交付。' },
        note: { type: 'string', description: '这次交付的说明。' },
        recursive: { type: 'boolean', description: '目录是否递归展开，默认 true。' },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: '只要这些扩展名，例如 [".pptx",".xlsx"]；不填表示不限。',
        },
        snapshot: { type: 'boolean', description: '是否另存文件快照，默认 true。' },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_task_status',
    description: '查询某个 task_id 的当前状态、DSH 会话 id、已收文件清单和最后一次回复摘要。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'dsh_dispatch_task 返回的 task_id。' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_tasks',
    description: '列出最近派发给 DSH 的任务及其状态。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 20。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_bridge_info',
    description:
      '读取桥接的当前配置：本机 DSH 工作区列表、允许执行的根目录白名单、默认工作目录和快照阈值。' +
      '在决定把文件放哪、或想挂到某个工作区之前先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

export function buildToolResult(payload, { isError = false, text } = {}) {
  const body = text ?? JSON.stringify(payload, null, 2)
  return {
    content: [{ type: 'text', text: body }],
    ...(payload === undefined ? {} : { structuredContent: payload }),
    isError,
  }
}

/** 一个 JSON-RPC 请求 -> 响应对象（或 undefined 表示这是通知，不该回）。 */
export async function handleMessage(message, handlers) {
  if (message === null || typeof message !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
  }
  const { id, method, params } = message
  const isNotification = id === undefined || id === null
  const reply = (body) => (isNotification ? undefined : { jsonrpc: '2.0', id, ...body })

  try {
    switch (method) {
      case 'initialize':
        return reply({
          result: {
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              '这是 Kimi Work 通往 DSH 的桥。派发任务用 dsh_dispatch_task；交付文件用 dsh_deliver_files。',
          },
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return undefined
      case 'ping':
        return reply({ result: {} })
      case 'tools/list':
        return reply({ result: { tools: TOOLS } })
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        const tool = TOOLS.find((item) => item.name === name)
        if (tool === undefined) {
          return reply({ error: { code: -32602, message: `未知工具：${String(name)}` } })
        }
        const result = await handlers.callTool(name, args)
        return reply({ result })
      }
      case 'resources/list':
        return reply({ result: { resources: [] } })
      case 'resources/templates/list':
        return reply({ result: { resourceTemplates: [] } })
      case 'prompts/list':
        return reply({ result: { prompts: [] } })
      default:
        return reply({ error: { code: -32601, message: `不支持的方法：${String(method)}` } })
    }
  } catch (error) {
    const message_ = error instanceof Error ? error.message : String(error)
    const code = error?.code === 'task/not-found' ? -32001 : error?.code === 'bridge/bad-request' ? -32602 : -32603
    return reply({ error: { code, message: message_ } })
  }
}
