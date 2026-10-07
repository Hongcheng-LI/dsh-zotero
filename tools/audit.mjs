// dsh-zotero 运行时审计：直接按「本机安装的 DSH 运行时」的真实规则体检本插件，
// 不再依赖任何第三方 checker（旧 audit-with-plugin-check.mjs 依赖 GitHub-only 的
// omdsh-dev/dsh-plugin-check，其规则停留在 0.1.x 时代）。
//
// 检查项：
//   1. 清单（package.json）：bundle 形态必需字段、files 完整性、生命周期脚本
//   2. 构建产物：lib/ 是否入库、是否比 src/ 旧（pnpm 10 默认拦截依赖构建脚本，必须自带 lib）
//   3. cordis.patch.yml：insert 行结构、id 唯一、name 指向本包、config 为对象
//   4. locale 元信息：插件管理器列表显示用的 title/description
//   5. 兼容门禁：peerDependencies 里的 @deepseek-ai/dsh(-*) 是否满足运行时版本
//      （与 dsh-app-boot 的 evaluatePluginCompatibility 同一语义）
//   6. 注册表门禁（可选增强）：本机装了 @deepseek-ai/dsh-tools 时，用「真实注册表」
//      注册全部工具并执行 output schema 硬校验（与运行时完全同一套代码）
//
// 用法：npm run audit [-- <插件目录>]；可选环境变量 DSH_RUNTIME_VERSION=x.y.z 覆盖目标版本。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const target = resolve(process.argv[2] ?? '.')
const require_ = createRequire(import.meta.url)

const issues = []
const notes = []
const ok = []
const fail = (code, detail) => issues.push({ code, detail })
const warn = (code, detail) => issues.push({ code, detail, warning: true })
const pass = (detail) => ok.push(detail)

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('manifest-parse', `${label} 无法解析：${error.message}`)
    return null
  }
}

// ---------- 1. 清单 ----------
const manifest = readJson(join(target, 'package.json'), 'package.json')
if (manifest) {
  const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
  if (typeof manifest.name === 'string' && PACKAGE_NAME.test(manifest.name)) pass(`包名 ${manifest.name}`)
  else fail('manifest-name', `name 缺失或非法：${JSON.stringify(manifest.name)}`)
  if (manifest.version) pass(`版本 ${manifest.version}`)
  else fail('manifest-version', 'version 缺失')
  if (manifest.description) pass('description 存在')
  else warn('manifest-description', 'description 缺失，插件管理器将显示空描述')

  const patchDecl = manifest.dsh?.bundle?.patch
  if (typeof patchDecl === 'string') {
    pass(`dsh.bundle.patch → ${patchDecl}`)
    const patchPath = join(target, patchDecl)
    if (!existsSync(patchPath)) fail('patch-missing', `声明的 patch 文件不存在：${patchPath}`)
  } else {
    fail('not-a-bundle', '未声明 dsh.bundle.patch —— 无法作为 Profile Bundle 安装')
  }

  const files = Array.isArray(manifest.files) ? manifest.files : []
  for (const required of ['lib', 'cordis.patch.yml']) {
    if (files.includes(required)) pass(`files 含 ${required}`)
    else warn('files-incomplete', `files 建议包含 ${required}`)
  }
  if (existsSync(join(target, 'locale')) && files.includes('locale')) pass('files 含 locale（插件管理器标题/描述）')
  else if (existsSync(join(target, 'locale'))) warn('files-incomplete', '存在 locale/ 但未列入 files，安装后不会带上')

  if (typeof manifest.engines?.node === 'string') pass(`engines.node ${manifest.engines.node}`)
  else warn('engines-node', 'engines.node 缺失')

  const scriptNames = Object.keys(manifest.scripts ?? {})
    .filter((name) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(name))
  if (scriptNames.length === 0) pass('无依赖侧生命周期脚本')
  else {
    // prepare 允许保留：lib 已入库时它只是本地开发便利；pnpm 会拦截但无影响
    if (scriptNames.every((name) => name === 'prepare') && existsSync(join(target, 'lib', 'index.js'))) {
      notes.push(`保留 ${scriptNames.join('/')} 脚本作为本地开发便利；lib/ 已入库，安装不受 pnpm 脚本拦截影响`)
    } else {
      warn('lifecycle-scripts', `依赖 ${scriptNames.join('/')} 生成产物 —— pnpm 10 默认拦截依赖构建脚本，安装会静默失败`)
    }
  }
}

// ---------- 2. 构建产物 ----------
const libEntry = join(target, 'lib', 'index.js')
if (existsSync(libEntry)) {
  pass('lib/index.js 已入库（即装即用）')
  const srcNewest = newestMtime(join(target, 'src'))
  if (srcNewest !== null && statSync(libEntry).mtimeMs < srcNewest) {
    warn('stale-build', 'lib/ 比 src/ 旧 —— 先 npm run build 再发布/提交')
  } else {
    pass('lib/ 不落后于 src/')
  }
} else {
  fail('lib-missing', 'lib/index.js 不存在：git 安装将无法加载（pnpm 不会替你跑 tsc）')
}

function newestMtime(dir) {
  let newest = null
  const walk = (current) => {
    let entries
    try {
      entries = require_('node:fs').readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        const mtime = statSync(full).mtimeMs
        if (newest === null || mtime > newest) newest = mtime
      }
    }
  }
  walk(dir)
  return newest
}

// ---------- 3. cordis.patch.yml ----------
const CORE_ROW_IDS = new Set([
  'ui-settings', 'ui-settings-general', 'ui-settings-account', 'ui-chat', 'ui-layout',
  'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'agent-default-model', 'loader',
  'tools', 'bash', 'pwsh', 'compaction', 'session-persistence',
])
const patchPath = join(target, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8')
  const rows = parsePatchRows(text)
  if (rows === null) {
    fail('patch-parse', 'cordis.patch.yml 不是顶层 YAML 数组（应为 - insert: [...] 形式）')
  } else if (rows.length === 0) {
    warn('patch-empty', 'patch 未注入任何插件行')
  } else {
    const ids = new Set()
    for (const row of rows) {
      if (!row.id) fail('patch-row-id', 'insert 行缺少 id')
      else if (ids.has(row.id)) fail('patch-row-dup', `insert 行 id 重复：${row.id}`)
      else ids.add(row.id)
      if (manifest && row.name !== undefined && row.name !== manifest.name && !String(row.name).startsWith(`${manifest.name}/`)) {
        warn('patch-row-name', `insert 行 name=${JSON.stringify(row.name)} 不指向本包（${manifest.name}），跨仓库引用需自己保证可解析`)
      }
      if (row.config !== undefined && (typeof row.config !== 'object' || row.config === null || Array.isArray(row.config))) {
        fail('patch-row-config', `insert 行 ${row.id} 的 config 必须是对象`)
      }
      if (CORE_ROW_IDS.has(row.id)) fail('patch-row-collision', `insert 行 id=${row.id} 与 DSH 核心行冲突`)
    }
    pass(`patch 注入 ${rows.length} 行（${[...ids].join(', ')}）`)
  }
}

/** 解析顶层 `- insert: [...]` 行，返回扁平化的 entry 数组；结构不符返回 null。 */
function parsePatchRows(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let inInsert = false
  let current = null
  let currentIndent = 0
  let sawTopLevelItem = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ')
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const topItem = /^- /.exec(line)
    if (topItem) {
      sawTopLevelItem = true
      const rest = line.slice(2).trim()
      if (rest === 'insert:' || rest.startsWith('insert:')) {
        inInsert = true
        current = null
        continue
      }
      inInsert = false // 其他顶层段落（include/group 等）不解析
      continue
    }
    if (!inInsert) continue
    const indent = line.length - line.trimStart().length
    const entryStart = /^- (?:(\s*)([\w-]+):)?/.exec(line.slice(indent)) // "  - id: x" / "- id: x"
    const prop = /^([\w-]+):\s*(.*)$/.exec(line.trim())
    if (line.trimStart().startsWith('- ')) {
      if (current) entries.push(current)
      current = {}
      currentIndent = indent
      const inline = line.trimStart().slice(2)
      const kv = /^([\w-]+):\s*(.*)$/.exec(inline)
      if (kv) applyProp(current, kv[1], kv[2])
      continue
    }
    if (current && indent > currentIndent && prop) applyProp(current, prop[1], prop[2])
  }
  if (current) entries.push(current)
  if (!sawTopLevelItem) return null
  return entries.filter((entry) => Object.keys(entry).length > 0)
}

function applyProp(entry, key, rawValue) {
  const value = rawValue.trim()
  if (value === '') entry[key] = entry[key] ?? undefined
  else if (value === '{}') entry[key] = {}
  else if (value === '[]') entry[key] = []
  else entry[key] = unquote(value)
}

function unquote(value) {
  return /^'.*'$/.test(value) || /^".*"$/.test(value) ? value.slice(1, -1) : value
}

// ---------- 4. locale 元信息 ----------
for (const locale of ['en', 'zh-CN']) {
  const localePath = join(target, 'locale', `${locale}.json`)
  if (!existsSync(localePath)) {
    if (locale === 'en') warn('locale-missing', 'locale/en.json 缺失：插件管理器标题将退化为包名')
    continue
  }
  const dict = readJson(localePath, `locale/${locale}.json`)
  if (dict) {
    if (dict.title && dict.description) pass(`locale/${locale}.json title/description 齐全`)
    else warn('locale-incomplete', `locale/${locale}.json 缺少 title 或 description`)
  }
}

// ---------- 5. 兼容门禁（与 dsh-app-boot evaluatePluginCompatibility 同一语义） ----------
if (manifest) {
  const peers = manifest.peerDependencies ?? {}
  const dshPeers = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  if (dshPeers.length === 0) {
    pass('未声明 @deepseek-ai/dsh(-*) peer：与任何 DSH 版本都通过兼容门禁')
  } else {
    const runtime = process.env.DSH_RUNTIME_VERSION ?? detectRuntimeVersion()
    if (runtime === null) {
      notes.push(`声明了 dsh peer ${JSON.stringify(Object.fromEntries(dshPeers))}，但未探测到运行时版本（可用 DSH_RUNTIME_VERSION 指定），跳过兼容检查`)
    } else {
      const { satisfies } = require_('semver')
      for (const [name, range] of dshPeers) {
        if (satisfies(runtime, range, { includePrerelease: true })) pass(`peer ${name}@${range} 满足运行时 ${runtime}`)
        else fail('incompatible-peer', `peer ${name}@${range} 不满足运行时 ${runtime} —— 安装会被 dsh plugin 拒绝（除非 allow-version 豁免）`)
      }
    }
  }
}

function detectRuntimeVersion() {
  // dsh 运行时版本 = dsh 根包（app-boot 的上级 package.json）的版本；
  // 桌面版里 dsh-desktop-host 与运行时同版本发布，作为可读的代理。
  const candidates = [
    process.env.DSH_HOME && join(process.env.DSH_HOME, '..'),
  ].filter(Boolean)
  try {
    const host = require_.resolve('@deepseek-ai/dsh-app-boot/package.json')
    return JSON.parse(readFileSync(join(require_('node:path').dirname(host), '..', 'package.json'), 'utf8')).version ?? null
  } catch { /* 未安装 app-boot，继续探测 */ }
  try {
    const host = require_.resolve('@deepseek-ai/dsh-desktop-host/package.json')
    return JSON.parse(readFileSync(host, 'utf8')).version ?? null
  } catch { /* 未安装 desktop-host */ }
  void candidates
  return null
}

// ---------- 6. 真实注册表门禁（可选增强） ----------
let dshTools = null
try {
  dshTools = await import('@deepseek-ai/dsh-tools')
} catch { /* 未安装（npm i --no-save @deepseek-ai/dsh-tools@<运行时版本>） */ }

if (manifest && existsSync(libEntry)) {
  if (dshTools) {
    try {
      const { assertSupportedJsonSchema } = dshTools
      const plugin = await import(pathToFileURL(libEntry).href)
      if (typeof plugin.apply !== 'function') fail('entry-apply', '入口未导出 apply()')
      if (!plugin.name) fail('entry-name', '入口未导出 name（loader 注入行 id 的来源）')
      if (!Array.isArray(plugin.inject)) warn('entry-inject', '入口未导出 inject 数组')
      if (plugin.Config !== undefined && typeof plugin.Config !== 'function') fail('entry-config', 'Config 必须是 schemastery schema（函数形态）')
      const tools = []
      plugin.apply({ tools: { register: (definition) => tools.push(definition) }, logger: { info() {}, warn() {} } }, {})
      for (const definition of tools) {
        assertSupportedJsonSchema(definition.output.schema) // 与 register() 同一硬校验
        if (typeof definition.output.render !== 'function') fail('tool-render', `${definition.name} 缺 output.render`)
        JSON.parse(JSON.stringify(definition.parameters))
      }
      if (plugin.Config) {
        plugin.Config({}) // 出厂空配置必须能过 schema
        const full = {
          baseUrl: 'http://127.0.0.1:23119', library: 'group:1', downloadDir: 'D:/papers',
          dataDir: 'D:/ZoteroData', storageDir: 'D:/s', maxAttachmentBytes: 1, maxLimit: 1,
          timeoutMs: 1, maxFulltextChars: 1,
        }
        plugin.Config(full) // 文档化的全部键也必须能过
      }
      pass(`真实 dsh-tools 门禁：${tools.length} 个工具全部通过注册校验${plugin.Config ? '，Config schema 接受空配置与全键配置' : ''}`)
    } catch (error) {
      fail('registry-gate', `真实注册表校验失败：${error.message}`)
    }
  } else {
    notes.push('未检测到 @deepseek-ai/dsh-tools，跳过真实注册表门禁（npm i --no-save @deepseek-ai/dsh-tools@<运行时版本> 后重跑可启用）')
  }
}

// ---------- 报告 ----------
const errors = issues.filter((issue) => !issue.warning)
const warnings = issues.filter((issue) => issue.warning)
console.log(`\n===== dsh-zotero 运行时审计：${target} =====`)
for (const item of ok) console.log(`  ✔ ${item}`)
for (const item of notes) console.log(`  ℹ ${item}`)
for (const item of warnings) console.log(`  ⚠ [${item.code}] ${item.detail}`)
for (const item of errors) console.log(`  ✘ [${item.code}] ${item.detail}`)
console.log(`-----`)
console.log(`通过 ${ok.length} · 警告 ${warnings.length} · 失败 ${errors.length}`)
if (notes.length > 0) console.log(`备注：\n  - ${notes.join('\n  - ')}`)
process.exitCode = errors.length > 0 ? 1 : 0
