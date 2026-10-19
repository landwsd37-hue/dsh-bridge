/**
 * 端点发现（Kimi 侧共用）：cli / stop hook / stdio MCP shim 全部走这里，
 * 保证「DSH 在哪个端口起，Kimi 就打到哪个端口」。
 *
 * 解析顺序（从高到低）：
 *   1. 显式参数 --endpoint
 *   2. 环境变量 DSH_KIMMIWORK_ENDPOINT
 *   3. 状态目录下的 endpoint.json（DSH 侧插件启动时发布，权威来源）
 *   4. 静态兜底 DEFAULT_BASE_URL（只防全挂，正常不该命中）
 *
 * 令牌同理：显式 > $DSH_KIMMIWORK_TOKEN > endpoint.json.token > <stateDir>/token。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 兜底基址：DSH 桌面版曾经写死的端口，只在 endpoint.json 不存在时使用。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:19387/api/kimiwork'

export function dshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

export function stateDir() {
  return join(dshHome(), 'dsh-kimiwork-bridge')
}

export function endpointFile() {
  return join(stateDir(), 'endpoint.json')
}

export function tokenFile() {
  return join(stateDir(), 'token')
}

function readJson(path) {
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    if (text.trim() === '') return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** endpoint.json 可能被写坏或半截，读失败就当没有，交给兜底。 */
export function readEndpointMeta() {
  const value = readJson(endpointFile())
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.baseUrl !== 'string' || value.baseUrl.trim() === '') return undefined
  return value
}

export function readTokenFile() {
  const value = readJson(tokenFile())
  if (value !== null && typeof value === 'object' && typeof value.token === 'string' && value.token !== '') return value.token
  // 兼容纯文本令牌文件
  try {
    if (!existsSync(tokenFile())) return undefined
    const text = readFileSync(tokenFile(), 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

function trimUrl(url) {
  return String(url).trim().replace(/\/+$/, '')
}

/**
 * 解析出本次调用要用的基址与令牌。返回 source 便于 CLI 报「这个地址是哪来的」。
 * @param {{ endpoint?: string, token?: string, allowEnv?: boolean }} [options]
 */
export function resolveConnection(options = {}) {
  const explicitEndpoint = (options.endpoint ?? '').trim()
  const envEndpoint = options.allowEnv === false ? '' : (process.env.DSH_KIMIWORK_ENDPOINT ?? '').trim()
  const meta = readEndpointMeta()

  let baseUrl
  let source
  if (explicitEndpoint !== '') {
    baseUrl = explicitEndpoint
    source = 'arg'
  } else if (envEndpoint !== '') {
    baseUrl = envEndpoint
    source = 'env'
  } else if (meta !== undefined) {
    baseUrl = meta.baseUrl
    source = 'endpoint.json'
  } else {
    baseUrl = DEFAULT_BASE_URL
    source = 'fallback'
  }

  const explicitToken = (options.token ?? '').trim()
  const envToken = (process.env.DSH_KIMIWORK_TOKEN ?? '').trim()
  let token
  let tokenSource
  if (explicitToken !== '') {
    token = explicitToken
    tokenSource = 'arg'
  } else if (envToken !== '') {
    token = envToken
    tokenSource = 'env'
  } else if (meta !== undefined && typeof meta.token === 'string' && meta.token !== '') {
    token = meta.token
    tokenSource = 'endpoint.json'
  } else {
    const fromFile = readTokenFile()
    token = fromFile
    tokenSource = fromFile === undefined ? 'none' : 'token-file'
  }

  return {
    baseUrl: trimUrl(baseUrl),
    token,
    tokenSource,
    source,
    endpointFile: endpointFile(),
    /** endpoint.json 里的补充信息（pid/port/updatedAt），诊断用。 */
    meta,
  }
}

/** 人读的一行摘要，CLI/hook 报错时拼给用户看。 */
export function describeConnection(conn) {
  const where =
    conn.source === 'endpoint.json'
      ? `endpoint.json（pid ${conn.meta?.pid ?? '?'}，${conn.meta?.updatedAt ?? '未知时间'}）`
      : conn.source === 'arg'
        ? '--endpoint 参数'
        : conn.source === 'env'
          ? '环境变量 DSH_KIMIWORK_ENDPOINT'
          : `静态兜底（未找到 ${conn.endpointFile}，DSH 侧插件可能没启用）`
  const auth = conn.token === undefined ? '无令牌' : `令牌来自 ${conn.tokenSource}`
  return `${conn.baseUrl} ← ${where}；${auth}`
}
