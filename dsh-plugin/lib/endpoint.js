/**
 * 端点发布：把桥接实际可达的基址（协议 + 主机 + 真实端口 + apiPath + 令牌）
 * 写进 <stateDir>/endpoint.json，供 Kimi 侧 / CLI / 探针动态发现。
 *
 * 背景：桥接现在挂在 DSH 自身的 webServer 上（ctx.webServer.register 的 prefix 路由
 * 不经过 dsh web 的 cookie 鉴权，见 dsh-host-webserver/lib/index.js:383-394），
 * 而 dsh web 的端口是运行时决定的（`dsh web --port`，默认会在 31113 之类随机端口上起，
 * listen 前 webServer.port / getOrigin() 都是 undefined 且会抛异常）。所以只能轮询。
 *
 * 只依赖 node: 内置模块。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso, writeJsonFile } from './util.js'

export const ENDPOINT_FILE = 'endpoint.json'

/** webServer.getOrigin() 在 listen 绑定前会 throw；这里统一吞掉换成 undefined。 */
function readOrigin(webServer) {
  try {
    const origin = webServer?.getOrigin?.()
    return typeof origin === 'string' && origin !== '' ? origin.replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

function readPort(webServer) {
  try {
    const port = webServer?.port
    return typeof port === 'number' && Number.isFinite(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * 开始发布端点。绑定时序不确定，所以先快轮询（250ms，最多 120 次≈30s），
 * 绑上之后转慢轮询（15s）兜住端口变化/热重载，只有内容变了才落盘。
 */
export function createEndpointPublisher({ webServer, stateDir, apiPath, token, logger, fastAttempts = 120, fastIntervalMs = 250, slowIntervalMs = 15000 }) {
  const file = join(stateDir, ENDPOINT_FILE)
  let lastText = ''
  let fastTimer
  let slowTimer
  let disposed = false
  let attempts = 0

  const describe = (origin, port) => {
    const base = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
    const info = {
      schemaVersion: 1,
      kind: 'dsh-kimiwork-bridge',
      origin,
      baseUrl: `${origin}${base}`,
      healthUrl: `${origin}${base}/health`,
      infoUrl: `${origin}${base}/info`,
      mcpUrl: `${origin}${base}/mcp`,
      apiPath: base,
      host: webServer?.host,
      port,
      protocol: webServer?.protocol,
      token: typeof token === 'string' && token !== '' ? token : null,
      pid: process.pid,
      node: process.version,
      updatedAt: nowIso(),
    }
    return info
  }

  const publish = (force = false) => {
    if (disposed) return true
    const origin = readOrigin(webServer)
    if (origin === undefined) return false
    const port = readPort(webServer)
    const info = describe(origin, port)
    // pid/updatedAt 会每轮变，比较时剔除，避免无意义的写入
    const key = JSON.stringify({ ...info, pid: 0, updatedAt: '' })
    if (force !== true && key === lastText && existsSync(file)) return true
    lastText = key
    writeJsonFile(file, info)
    logger?.info?.(`endpoint published: ${info.baseUrl} -> ${file}`)
    return true
  }

  const tick = () => {
    if (disposed) return
    attempts += 1
    if (!publish()) {
      if (attempts < fastAttempts) {
        fastTimer = setTimeout(tick, fastIntervalMs)
        fastTimer.unref?.()
      } else {
        logger?.warn?.(`endpoint not published: webServer 尚未 listen（已试 ${attempts} 次）`)
        slowTimer = setInterval(tick, slowIntervalMs)
        slowTimer.unref?.()
      }
      return
    }
    if (slowTimer === undefined) {
      slowTimer = setInterval(tick, slowIntervalMs)
      slowTimer.unref?.()
    }
  }

  tick()

  return {
    file,
    get published() {
      return existsSync(file)
    },
    refresh() {
      return publish(true)
    },
    dispose() {
      disposed = true
      if (fastTimer !== undefined) clearTimeout(fastTimer)
      if (slowTimer !== undefined) clearInterval(slowTimer)
      try {
        rmSync(file, { force: true })
      } catch {
        /* 清理失败不影响卸载 */
      }
    },
  }
}
