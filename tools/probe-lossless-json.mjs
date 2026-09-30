#!/usr/bin/env node
/**
 * probe-lossless-json.mjs — dsh-zotero 插件「工具返回值不可无损 JSON 化」缺陷的复现探针
 *
 * 背景
 * ----
 * DSH 在把插件工具（plugin tool）的结构化返回值送上进程间 Remote 通道前，会用
 * `isRemoteJsonValue()`（实现体 `visitJsonValue()`，位于 DSH 的 typert/remote 层）
 * 做一次「无损 JSON」校验。被拒绝时，调用方看到的是：
 *     Error: tool "zotero_xxx" returned invalid output: value is not lossless JSON
 *
 * 该校验拒绝以下情况（节选自 DSH 实现）：
 *   - typeof value === 'undefined'（含嵌套 undefined；顶层 undefined 仅在 uplink 允许）
 *   - number 非有限值（NaN / ±Infinity）或为 -0
 *   - 对象原型不是 Object.prototype / null（类实例、Map、Set…）
 *   - 数组带额外自有键，或键不是 string（Symbol 键）
 *   - 不可枚举属性
 *   - 循环引用
 *
 * dsh-zotero 0.1.1 的问题：`toItem()` 用 `str()`/`num()` 映射字段，字段为空时返回
 * `undefined`，但仍作为自有属性写进对象；`trimItems(items, 'full')` 原样返回未裁剪对象；
 * `zotero_item` 直接返回未裁剪的 item；`zotero_collections` 对顶层分类写入
 * `parentCollection: str(false) === undefined`。于是这些返回值含嵌套 undefined，
 * 被校验拒绝 => 三个工具恒定失败。
 *
 * 本脚本直接加载插件的编译产物，按各工具真实的返回结构构造 payload，
 * 用同一套规则的复刻实现定位"具体是哪条路径上的什么值"导致失败。
 *
 * 用法
 * ----
 *   node probe-lossless-json.mjs                 # 依赖 Zotero 正在运行
 *   node probe-lossless-json.mjs --plugin <dir>  # 指定插件根目录
 *   node probe-lossless-json.mjs --json out.json # 额外写出机器可读结果
 */

import { pathToFileURL } from 'node:url'
import { writeFileSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'

const argv = process.argv.slice(2)
function argValue(flag, fallback) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const DEFAULT_PLUGIN =
  'C:/Users/admin1/Documents/deepseek-harness/coding-workspace/my-plugin/dsh-zotero'
const pluginDir = resolve(argValue('--plugin', DEFAULT_PLUGIN))
const clientPath = resolve(pluginDir, 'lib/zotero-client.js')
if (!existsSync(clientPath)) {
  console.error(`找不到插件编译产物: ${clientPath}`)
  process.exit(2)
}

const { ZoteroClient, resolveConfig, trimItems } = await import(pathToFileURL(clientPath).href)

/* ------------------------------------------------------------------ *
 * DSH 侧 isRemoteJsonValue 的复刻（仅用于诊断，语义对齐）
 * ------------------------------------------------------------------ */
function findOffenses(value) {
  const offenses = []
  const ancestors = new Set()

  function visit(v, path) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) offenses.push({ path, reason: `非有限数 ${v}` })
      else if (Object.is(v, -0)) offenses.push({ path, reason: '-0（JSON 传输会变成 0）' })
      return
    }
    if (typeof v === 'undefined') {
      offenses.push({ path, reason: 'undefined（JSON.stringify 会丢弃该键）' })
      return
    }
    if (typeof v !== 'object') {
      offenses.push({ path, reason: `typeof ${typeof v}` })
      return
    }
    if (ancestors.has(v)) {
      offenses.push({ path, reason: '循环引用' })
      return
    }
    ancestors.add(v)
    try {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype) {
          offenses.push({ path, reason: '数组原型被改写' })
        }
        const own = Reflect.ownKeys(v)
        if (own.length !== v.length + 1) {
          offenses.push({ path, reason: `数组含额外自有键: ${own.filter((k) => k !== 'length').join(',')}` })
        }
        for (let i = 0; i < v.length; i++) {
          if (!Object.hasOwn(v, i)) offenses.push({ path: `${path}[${i}]`, reason: '数组空洞' })
          else visit(v[i], `${path}[${i}]`)
        }
        return
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        offenses.push({ path, reason: `原型为 ${proto?.constructor?.name ?? 'null'}（非纯对象）` })
      }
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== 'string') {
          offenses.push({ path: `${path}<symbol>`, reason: 'Symbol 键' })
          continue
        }
        const desc = Object.getOwnPropertyDescriptor(v, key)
        if (desc?.enumerable !== true) {
          offenses.push({ path: `${path}.${key}`, reason: '不可枚举属性' })
          continue
        }
        visit(desc.value, `${path}.${key}`)
      }
    } finally {
      ancestors.delete(v)
    }
  }

  visit(value, '$')
  return offenses
}

/* ------------------------------------------------------------------ *
 * 构造各工具真实的返回值（与 src/index.ts 的 execute() 一致）
 * ------------------------------------------------------------------ */
const client = new ZoteroClient(resolveConfig({}))

const PROBE_ITEM = argValue('--item', 'EPXGAXND') // 一个有 PDF 附件的条目
const PROBE_QUERY = argValue('--query', 'mmWave')

const cases = []
async function build() {
  const collections = await client.collections()
  const item = await client.item(PROBE_ITEM)
  const searched = await client.search({ query: PROBE_QUERY, limit: 5 })
  const recent = await client.recent(3)

  cases.push({ tool: 'zotero_collections', payload: { collections } })
  cases.push({ tool: 'zotero_item', payload: item })
  for (const mode of ['minimal', 'preview', 'full']) {
    cases.push({
      tool: `zotero_search (mode=${mode})`,
      payload: { count: searched.items.length, totalResults: searched.totalResults, items: trimItems(searched.items, mode) },
    })
  }
  for (const mode of ['minimal', 'preview', 'full']) {
    cases.push({
      tool: `zotero_recent (mode=${mode})`,
      payload: { count: recent.items.length, items: trimItems(recent.items, mode) },
    })
  }
}

try {
  await build()
} catch (error) {
  console.error('无法从 Zotero 本地 API 取数（请确认 Zotero 已启动且已开启「允许本机上的其他应用程序与 Zotero 通信」）：')
  console.error('  ' + (error?.message ?? String(error)))
  process.exit(3)
}

/* ------------------------------------------------------------------ *
 * 逐例判定
 * ------------------------------------------------------------------ */
const report = { pluginDir, clientPath, probeItem: PROBE_ITEM, probeQuery: PROBE_QUERY, checkedAt: new Date().toISOString(), cases: [] }
let failCount = 0

console.log(`插件: ${pluginDir}`)
console.log(`探针: item=${PROBE_ITEM}  query=${PROBE_QUERY}\n`)
console.log('工具返回值无损 JSON 校验（复刻 DSH isRemoteJsonValue）')
console.log('-'.repeat(78))

for (const { tool, payload } of cases) {
  const offenses = findOffenses(payload)
  const ok = offenses.length === 0
  if (!ok) failCount++
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${tool}`)
  if (!ok) {
    const uniq = new Map()
    for (const o of offenses) {
      const key = o.reason
      if (!uniq.has(key)) uniq.set(key, { count: 0, sample: o.path })
      uniq.get(key).count++
    }
    for (const [reason, info] of [...uniq.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`        ${reason}  ×${info.count}   例: ${info.sample}`)
    }
  }
  report.cases.push({
    tool,
    pass: ok,
    offenseCount: offenses.length,
    offensePaths: offenses.slice(0, 40),
  })
}

console.log('-'.repeat(78))
console.log(`合计: ${cases.length - failCount}/${cases.length} 通过，${failCount} 个工具返回值会被 DSH 判为 invalid output`)

const jsonOut = argValue('--json', null)
if (jsonOut) {
  const target = isAbsolute(jsonOut) ? jsonOut : resolve(process.cwd(), jsonOut)
  writeFileSync(target, JSON.stringify(report, null, 2), 'utf8')
  console.log(`机器可读结果: ${target}`)
}

process.exit(failCount > 0 ? 1 : 0)
