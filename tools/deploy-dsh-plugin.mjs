#!/usr/bin/env node
/**
 * 把 dsh-plugin/ 部署进 DSH desktop profile 的 node_modules，并让改动立刻生效。
 *
 * 为什么需要「内容哈希构建目录」这套机制：
 *   DSH 的 ESM 模块缓存按 **绝对路径 URL** 生效。首次加载后，即使把
 *   lib/index.js 原地覆盖，再触发 profile reload（plugin_manager set_bundle），
 *   reconcileProfilePatches 只会重建 loader 条目，import 仍命中旧缓存 ——
 *   改动一直不生效，除非重启 DSH。
 *   （dsh-hmr 本来能替我们换掉模块缓存，但 base bundle 把它配成 root: []，
 *    只监听 profile 配置、不监听模块源码；README 也写明要在启动前配 root。）
 *
 * 因此这里将整套 lib/*.js 复制到 lib/builds/<内容哈希>/ 这个从未加载过的
 * 新 URL 下，并把 bundle patch 的 insert.name 指过去。改一次代码 = 换一个
 * URL = 一次干净的新模块加载，无需重启 DSH。
 *
 * 用法：node tools/deploy-dsh-plugin.mjs
 * 之后：plugin_manager action=set_bundle target=dsh-kimiwork-bridge enabled=true
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(here, '..', 'dsh-plugin')
const targetDir = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-kimiwork-bridge')
const KEEP_BUILDS = 3

function writeDirect(path, content) {
  writeFileSync(path, content)
}

function readSourceFiles() {
  const files = new Map()
  for (const name of readdirSync(join(srcDir, 'lib')).sort()) {
    if (!name.endsWith('.js')) continue
    files.set(name, readFileSync(join(srcDir, 'lib', name)))
  }
  if (!files.has('index.js')) throw new Error(`找不到入口 ${join(srcDir, 'lib', 'index.js')}`)
  return files
}

function contentHash(files) {
  const hash = createHash('sha256')
  for (const [name, bytes] of files) {
    hash.update(name)
    hash.update('\u0000')
    hash.update(bytes)
    hash.update('\u0000')
  }
  return hash.digest('hex').slice(0, 8)
}

function pruneBuilds(buildsDir, keep) {
  if (!existsSync(buildsDir)) return []
  const rows = readdirSync(buildsDir)
    .map((name) => ({ name, path: join(buildsDir, name) }))
    .filter((row) => statSync(row.path).isDirectory())
    .map((row) => ({ ...row, mtime: statSync(row.path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const removed = []
  for (const row of rows.slice(keep)) {
    rmSync(row.path, { recursive: true, force: true })
    removed.push(row.name)
  }
  return removed
}

const files = readSourceFiles()
const hash = contentHash(files)
const buildRel = join('lib', 'builds', hash)
const buildDir = join(targetDir, buildRel)

mkdirSync(buildDir, { recursive: true })
for (const [name, bytes] of files) writeDirect(join(buildDir, name), bytes)
console.log(`build  ${buildRel}  (${files.size} files)`)

// 规范位置的同一份代码：package.json 的 main 指着这里，保持部署包自洽。
mkdirSync(join(targetDir, 'lib'), { recursive: true })
for (const [name, bytes] of files) writeDirect(join(targetDir, 'lib', name), bytes)

writeDirect(join(targetDir, 'package.json'), readFileSync(join(srcDir, 'package.json')))

// patch 的 insert.name 指向带哈希的构建目录（相对 patch 文件解析）。
const patch = `# 由 tools/deploy-dsh-plugin.mjs 生成，请勿手改。
# 入口指向 lib/builds/<内容哈希>/index.js：换代码就换 URL，绕开 DSH 的 ESM 模块缓存，
# 部署后无需重启 DSH 即生效。运行时配置请写在 profile 的 cordis.patch.yml 里
# （- id: kimiwork-bridge / config: {...}）。
- insert:
    - id: kimiwork-bridge
      name: './${buildRel.replace(/\\/g, '/')}/index.js'
`
writeDirect(join(targetDir, 'cordis.patch.yml'), patch)

const removed = pruneBuilds(join(targetDir, 'lib', 'builds'), KEEP_BUILDS)
if (removed.length > 0) console.log(`pruned ${removed.join(', ')}`)
console.log(`target ${targetDir}`)
console.log(`entry  ./${buildRel.replace(/\\/g, '/')}/index.js`)
