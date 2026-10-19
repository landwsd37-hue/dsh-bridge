/**
 * dsh-kimiwork-bridge —— Kimi Work ↔ DSH 桥接插件入口。
 *
 * 挂载一个本机 HTTP 前缀（默认 /api/kimiwork），同时提供：
 *   - POST /mcp      MCP JSON-RPC（Kimi Work 以原生工具方式调用）
 *   - POST /dispatch  纯 REST 派发任务（skill/脚本/curl 用）
 *   - POST /deliver   纯 REST 交付文件
 *   - GET  /health    健康检查与运行期信息
 *   - GET  /tasks     任务列表
 *
 * 启动后把实际可达基址（含 dsh web 运行时端口与令牌）发布到 <stateDir>/endpoint.json，
 * 供 Kimi 侧插件/CLI/探针动态发现，避免写死端口。
 *
 * 只 inject webServer：其余服务（sessionController / agentDefaultModel /
 * workspaceRegistry）全部按需 ctx.get()，宿主没装也不会拖住插件启动。
 */
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from './bridge.js'
import { createEndpointPublisher } from './endpoint.js'
import { ensureDir } from './util.js'

export const name = 'kimiwork-bridge'

export const inject = ['webServer']

export const Config = Schema.object({
  /** 状态目录；留空则用 $DSH_HOME/dsh-kimiwork-bridge。 */
  stateDir: Schema.string().default(''),
  /** 挂载前缀，必须与 Kimi 侧插件 manifest 里的 url 保持一致。 */
  apiPath: Schema.string().default('/api/kimiwork'),
  /**
   * 允许派发执行任务的根目录白名单（绝对路径）。
   * 留空 = 不限制（会在日志里提示）。强烈建议至少填一个。
   */
  allowedRoots: Schema.array(Schema.string()).default([]),
  /** 没有显式指定 cwd 时的默认工作目录。 */
  cwd: Schema.string().default(''),
  /** 新建 DSH 会话时使用的 agent preset。 */
  agentPreset: Schema.string().default('standard'),
  /** 把任务注入会话时的取消超时（毫秒）。sessionController.prompt 需要 AbortSignal。 */
  promptTimeoutMs: Schema.number().default(30_000),
  /** 强制指定模型；留空则沿用 DSH 的默认模型选择。 */
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  /** 单个文件超过这个大小就不另存快照，只记路径清单。 */
  maxSnapshotBytes: Schema.number().default(8 * 1024 * 1024),
  /** 目录展开时最多收多少个文件。 */
  maxFiles: Schema.number().default(300),
  /** 是否把关键文件复制进 inbox 快照。 */
  snapshotFiles: Schema.boolean().default(true),
  /** 是否要求 Authorization: Bearer <token>（本机回环以外一律拒绝，不受此开关影响）。 */
  requireToken: Schema.boolean().default(false),
  /** 固定 token；留空则首次启动自动生成并写入 <stateDir>/token。 */
  token: Schema.string().default(''),
})

export function apply(ctx, config) {
  ctx.effect(() => {
    const stateDir =
      config.stateDir.trim() !== ''
        ? config.stateDir.trim()
        : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-kimiwork-bridge')
    ensureDir(stateDir)
    ensureDir(join(stateDir, 'outbox'))

    const bridge = new Bridge(ctx, config, stateDir)
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: config.apiPath,
      handler: (req, res) => bridge.handle(req, res),
    })
    bridge.start()

    const logger = ctx.logger(name)
    logger.info(
      `[kimiwork-bridge] 已挂载 ${config.apiPath}（状态目录 ${stateDir}，白名单 ${(config.allowedRoots ?? []).join(' | ') || '未设置（不限制，建议尽快设置）'}）`,
    )

    // dsh web 的端口是运行时绑定的，这里把真实基址发布到 endpoint.json 供 Kimi 侧发现
    const endpoint = createEndpointPublisher({
      webServer: ctx.webServer,
      stateDir,
      apiPath: config.apiPath,
      token: bridge.token,
      logger: { info: (m) => logger.info(`[kimiwork-bridge] ${m}`), warn: (m) => logger.warn(`[kimiwork-bridge] ${m}`) },
    })

    return () => {
      try {
        endpoint.dispose()
        if (typeof dispose === 'function') dispose()
      } finally {
        bridge.stop()
        logger.info('[kimiwork-bridge] 已卸载')
      }
    }
  }, 'kimiwork-bridge.serve')
}
