#!/usr/bin/env node
/**
 * 把 kimi-plugin/ 同步到 Kimi 的「插件源」目录，并生成两个运行时文件：
 *
 *   scripts/tools.json    工具清单，直接从 dsh-plugin/lib/mcp.js 的 TOOLS 生成，
 *                         保证 Kimi 侧 stdio MCP 的 tools/list 与 DSH 侧同一份 schema
 *   scripts/node-path.txt 本机 node 绝对路径，给 dsh-bridge-mcp.cmd 兜底用
 *                         （Kimi 宿主进程的 PATH 里通常没有 node）
 *
 * 清单里不再烘任何令牌/端口：Kimi 侧通过 <DSH_HOME>/dsh-kimiwork-bridge/endpoint.json
 * 在每次调用时动态发现 DSH 真实基址。
 *
 *   node tools/deploy-kimi-plugin.mjs [--share-dir <Kimi daimon-share 目录>] [--no-copy]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS } from '../dsh-plugin/lib/mcp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const SRC = join(REPO, 'kimi-plugin')
const PLUGIN_NAME = 'dsh-bridge'

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]
  return fallback
}

const shareDir = resolve(
  argValue('--share-dir', join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'kimi-desktop', 'daimon-share')),
)
const dstDir = join(shareDir, 'plugin-sources', 'personal', PLUGIN_NAME)
const skipCopy = process.argv.includes('--no-copy')

function step(message) {
  process.stdout.write(`• ${message}\n`)
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
  return path
}

step(`插件源：${SRC}`)
step(`目标目录：${dstDir}`)

if (skipCopy) {
  step('跳过文件同步（--no-copy）')
} else {
  if (existsSync(dstDir)) rmSync(dstDir, { recursive: true, force: true })
  mkdirSync(dstDir, { recursive: true })
  cpSync(SRC, dstDir, {
    recursive: true,
    filter: (path) => {
      const name = path.split(/[\\/]/).pop() ?? ''
      return name !== '.state' && name !== 'node_modules' && name !== '.git' && name !== '.DS_Store' && name !== 'package-lock.json'
    },
  })
  step(`已同步 ${PLUGIN_NAME}/（已跳过 .state / node_modules）`)
}

// 1) 工具清单：与 DSH 侧共用一份 schema
const toolsPath = writeJson(join(dstDir, 'scripts', 'tools.json'), {
  generatedAt: new Date().toISOString(),
  source: 'dsh-plugin/lib/mcp.js',
  tools: TOOLS,
})
step(`tools.json：${TOOLS.length} 个工具（${TOOLS.map((tool) => tool.name).join(', ')}）-> ${toolsPath}`)

// 2) node 路径：Kimi 宿主 PATH 里没有 node，.cmd 启动器靠这个文件
const nodePath = process.execPath
writeFileSync(join(dstDir, 'scripts', 'node-path.txt'), `${nodePath}\n`, { encoding: 'utf8' })
step(`node-path.txt：${nodePath}`)

// 3) 清单自检：确认 mcpServers 已是 command 方式，且没有残留令牌
const manifestPath = join(dstDir, 'kimi.plugin.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const server = manifest.mcpServers?.[PLUGIN_NAME]
if (server === undefined) throw new Error(`${manifestPath} 缺少 mcpServers.${PLUGIN_NAME}`)
if (typeof server.url === 'string') {
  throw new Error('清单里仍是 url 方式：请改成 command 方式（见 kimi-plugin/kimi.plugin.json）')
}
if (server.headers !== undefined) throw new Error('清单里仍在烘 tokens/headers：应删除，改用 endpoint.json 发现')
step(`清单自检通过：version ${manifest.version}，command ${server.command} ${(server.args ?? []).join(' ')}`)

const pythonCandidates = [
  join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'kimi-desktop', 'daimon-bundle', 'runtime', 'python', 'cpython-3.12', 'python.exe'),
]
const python = pythonCandidates.find((path) => existsSync(path)) ?? 'python'
const registerScript = join(shareDir, 'daimon', 'skills', 'plugin-builder', 'scripts', 'register_personal.py')

process.stdout.write(
  [
    '',
    '下一步（注册 + 安装）：',
    `  1) 注册到 Kimi「个人」插件源：`,
    `     "${python}" "${registerScript}" "${dstDir}" --share-dir "${shareDir}" --market personal --node "${nodePath}" --json`,
    '  2) 打开 Kimi Work → 插件中心 → 「个人」页签 → DSH 桥接 → ＋ 安装（版本变了才会出现更新）',
    '  3) 装完发起任何一条消息，看是否出现 5 个 dsh_* 工具；没有就先把 Kimi 里旧的 dsh-bridge 卸载再装',
    '',
    '自检（不需要 Kimi 参与）：',
    `  "${process.execPath}" "${join(REPO, 'tools', 'probe-mcp.mjs')}" --stdio`,
    '',
  ].join('\n'),
)
