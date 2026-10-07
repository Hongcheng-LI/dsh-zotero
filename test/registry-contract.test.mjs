// 运行时契约测试：用「真实」的 @deepseek-ai/dsh-tools（DSH 运行时自带的工具注册表）
// 校验本插件注册的每个工具，并用 mock 的 Zotero 本地 API 跑通每条 execute 路径。
//
// 依赖说明：@deepseek-ai/dsh-tools 刻意不出现在 package.json（插件本身零 dsh 运行时依赖，
// 以便跨 DSH 版本通用）。想跑本契约测试时手动装一份与目标运行时一致的版本即可：
//
//   npm install --no-save @deepseek-ai/dsh-tools@0.2.0-rc.2
//
// 没装时本文件整体 skip，不影响离线单测（test/zotero.test.mjs）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let dshTools = null
try {
  dshTools = await import('@deepseek-ai/dsh-tools')
} catch {
  dshTools = null
}

const { apply } = await import('../lib/index.js')

/** 收集 apply() 注册的工具定义（与真实加载器同一入口）。 */
function collectTools(config) {
  const tools = []
  apply({ tools: { register: (definition) => tools.push(definition) }, logger: { info() {}, warn() {} } }, config)
  return tools
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 内置一条最小可解析的 PDF（仅用于让 zotero_fulltext 走 file 分支以外的路径时有真文件可指）。 */
function writeFakePdf(dir, name) {
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n')
  const path = join(dir, name)
  writeFileSync(path, pdf, 'latin1')
  return path
}

/** 极简 Zotero 本地 API mock：内存条目库 + 302 的 /file 端点 + 可写的笔记端点。 */
async function startZoteroMock() {
  const now = '2026-10-07T12:00:00Z'
  const items = new Map()
  const nextKey = (() => {
    let n = 0
    return (prefix) => `${prefix}${String(++n).padStart(5, '0')}`.slice(0, 8).toUpperCase().replace(/(.{4})(.*)/, (_, a, b) => (a + b).slice(0, 8))
  })()

  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-zotero-contract-'))
  const storage = join(dataDir, 'storage')
  // Zotero 的真实布局：每个附件一个 storage/<KEY>/ 目录，.zotero-ft-cache 与附件同目录
  mkdirSync(join(storage, 'ATT00001'), { recursive: true })
  mkdirSync(join(storage, 'ATT00002'), { recursive: true })
  const pdfPath = writeFakePdf(join(storage, 'ATT00001'), 'paper.pdf')
  writeFileSync(join(storage, 'ATT00001', '.zotero-ft-cache'), ' cached full text of the paper ', 'utf8')
  const txtPath = join(storage, 'ATT00002', 'notes.txt')
  writeFileSync(txtPath, 'plain attachment', 'utf8')

  items.set('ABCD1234', {
    key: 'ABCD1234', version: 11,
    data: {
      key: 'ABCD1234', itemType: 'journalArticle', title: 'Attention Is All You Need',
      creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }],
      date: '2017-06', publicationTitle: 'NeurIPS', DOI: '10.5555/x', abstractNote: 'Transformer abstract.',
      tags: [{ tag: 'transformer' }], collections: ['COLL0001'], dateAdded: now,
    },
    meta: {},
  })
  items.set('ATT00001', {
    key: 'ATT00001', version: 3,
    data: { key: 'ATT00001', itemType: 'attachment', parentItem: 'ABCD1234', title: 'Paper PDF', contentType: 'application/pdf', filename: 'paper.pdf', path: 'storage:paper.pdf' },
  })
  items.set('ATT00002', {
    key: 'ATT00002', version: 4,
    data: { key: 'ATT00002', itemType: 'attachment', parentItem: 'ABCD1234', title: 'Notes', contentType: 'text/plain', filename: 'notes.txt', path: 'storage:notes.txt' },
  })
  items.set('NOTE0001', {
    key: 'NOTE0001', version: 7,
    data: { key: 'NOTE0001', itemType: 'note', parentItem: 'ABCD1234', note: '<p>first note</p>', tags: [], dateAdded: now },
  })
  const collections = [
    { key: 'COLL0001', version: 2, data: { key: 'COLL0001', name: 'Root', parentCollection: false }, meta: { numItems: 1 } },
    { key: 'COLL0002', version: 2, data: { key: 'COLL0002', name: 'Child', parentCollection: 'COLL0001' }, meta: { numItems: 0 } },
  ]

  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock')
    const path = url.pathname
    if (process.env.ZOTERO_MOCK_DEBUG) console.log(`[mock] ${req.method} ${path} itemType=${JSON.stringify(url.searchParams.get('itemType'))}`)
    const mFile = /^\/api\/users\/0\/items\/([A-Z0-9]{8})\/file$/.exec(path)
    if (mFile) {
      const target = mFile[1] === 'ATT00001' ? pdfPath : txtPath
      res.writeHead(302, { Location: pathToFileURL(target).href })
      res.end()
      return
    }
    const mChildren = /^\/api\/users\/0\/items\/([A-Z0-9]{8})\/children$/.exec(path)
    if (mChildren) {
      const parent = mChildren[1]
      const kids = [...items.values()].filter((it) => it.data.parentItem === parent)
      json(res, 200, kids, { 'Total-Results': String(kids.length) })
      return
    }
    const mItem = /^\/api\/users\/0\/items\/([A-Z0-9]{8})$/.exec(path)
    if (mItem && req.method === 'GET') {
      const hit = items.get(mItem[1])
      if (!hit) return json(res, 404, { error: 'not found' })
      return json(res, 200, hit)
    }
    if (mItem && req.method === 'PATCH') {
      const hit = items.get(mItem[1])
      if (!hit) return json(res, 404, { error: 'not found' })
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const patch = JSON.parse(body || '{}')
        Object.assign(hit.data, patch)
        hit.version += 1
        res.writeHead(204); res.end()
      })
      return
    }
    if (mItem && req.method === 'DELETE') {
      items.delete(mItem[1])
      res.writeHead(204); res.end()
      return
    }
    if (path === '/api/users/0/items' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const batch = JSON.parse(body || '[]')
        const created = {}
        batch.forEach((row, i) => {
          const key = `NT${String(Object.keys(items).length + i + 1).padStart(6, '0')}`.slice(0, 8)
          items.set(key, { key, version: 1, data: { key, ...row } })
          created[String(i)] = key
        })
        json(res, 200, { success: created })
      })
      return
    }
    if (path === '/api/users/0/collections') return json(res, 200, collections, { 'Total-Results': String(collections.length) })
    if (path === '/api/users/0/items' || path === '/api/users/0/items/top') {
      const itemType = url.searchParams.get('itemType') ?? ''
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      // 支持 Zotero 的包含（"journalArticle"）与排除（"-attachment -note"）语法；
      // /top 只回顶层条目（无 parentItem），模拟真实 Zotero 的行为
      const include = itemType.split(/\s+/).filter((tok) => tok !== '' && !tok.startsWith('-'))
      const exclude = [...itemType.matchAll(/-(\w+)/g)].map((m) => m[1])
      const topOnly = path.endsWith('/top')
      const rows = [...items.values()].filter((it) => {
        const type = it.data.itemType
        if (exclude.includes(type)) return false
        if (include.length > 0 && !include.includes(type)) return false
        if (topOnly && it.data.parentItem) return false
        if (q !== '') {
          const haystack = `${it.data.title ?? ''} ${it.data.name ?? ''} ${JSON.stringify(it.data.creators ?? [])} ${it.data.date ?? ''}`.toLowerCase()
          if (!haystack.includes(q)) return false
        }
        return true
      })
      json(res, 200, rows, { 'Total-Results': String(rows.length) })
      return
    }
    json(res, 404, { error: `mock: no route for ${req.method} ${path}` })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return {
    baseUrl,
    items,
    // fetch(undici) 会保留 keep-alive 空闲连接，server.close() 会一直等它们，必须先掐掉
    close: () => new Promise((resolve) => {
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
    [Symbol.dispose]: () => server.close(),
  }
}

const canGate = dshTools !== null
const maybeTest = canGate ? test : test.skip

maybeTest('runtime contract: every tool registers through the real DSH registry', async (t) => {
  const { ToolRuntime } = dshTools
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools() {}, section() {} })
  const registry = new ToolRuntime(ctx, { mode: 'native' })
  const tools = collectTools({})
  assert.equal(tools.length, 9)
  for (const definition of tools) registry.register(definition)
  // 通过注册表把工具 schema 投影出来（模型可见面），确认无损且可反序列化
  const schemas = registry.schemas()
  assert.equal(schemas.filter((s) => s.name.startsWith('zotero_')).length, 9)
  for (const schema of schemas) {
    assert.ok(schema.description?.length > 20, `${schema.name} description present`)
    assert.equal(JSON.parse(JSON.stringify(schema.parameters)).type, 'object')
  }
})

maybeTest('runtime contract: every output schema passes assertSupportedJsonSchema', () => {
  const { assertSupportedJsonSchema } = dshTools
  for (const tool of collectTools({})) {
    assertSupportedJsonSchema(tool.output.schema) // register() 的硬校验，抛错即失败
    assert.equal(typeof tool.output.render, 'function')
  }
})

maybeTest('runtime contract: parameters are lossless JSON and schema-subset clean', () => {
  const { assertSupportedJsonSchema } = dshTools
  for (const tool of collectTools({})) {
    const roundTrip = JSON.parse(JSON.stringify(tool.parameters))
    assert.deepEqual(roundTrip, tool.parameters, `${tool.name} parameters must be lossless JSON`)
    assertSupportedJsonSchema(tool.parameters)
  }
})

maybeTest('runtime contract: execute every tool against a mock Zotero and validate results', async (t) => {
  const { validateJsonSchemaValue } = dshTools
  const mock = await startZoteroMock()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-zotero-cwd-'))
  t.after(async () => { await mock.close(); rmSync(cwd, { recursive: true, force: true }) })
  const exec = { agent: { session: { header: { cwd } } } }
  const config = { baseUrl: mock.baseUrl, storageDir: join(cwd, 'unused-storage') }
  const byName = new Map(collectTools(config).map((tool) => [tool.name, tool]))

  /** 走一遍完整管线：execute → snapshot → output schema 校验 → render 快照。 */
  async function run(name, args) {
    const tool = byName.get(name)
    assert.ok(tool, `${name} registered`)
    const value = await tool.execute(args, exec)
    const detached = snapshot(value)
    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
    assert.deepEqual(violations, [], `${name} output must match its declared schema`)
    const rendered = tool.output.render(args, detached)
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} render returns content blocks`)
    for (const block of rendered) {
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
      assert.equal(JSON.parse(JSON.stringify(block)).text, block.text)
    }
    return detached
  }

  const collections = await run('zotero_collections', {})
  assert.equal(collections.collections.length, 2)

  const search = await run('zotero_search', { query: 'attention', mode: 'preview' })
  assert.equal(search.count, 1)
  assert.equal(search.totalResults, 1)

  const recent = await run('zotero_recent', { limit: 5 })
  assert.equal(recent.count, 1)

  const item = await run('zotero_item', { key: 'ABCD1234' })
  assert.equal(item.item.title, 'Attention Is All You Need')
  assert.equal(item.attachments.length, 2)

  const fulltext = await run('zotero_fulltext', { itemKey: 'ABCD1234' })
  assert.equal(fulltext.mode, 'text')
  assert.match(fulltext.text, /cached full text/)

  const plainFile = await run('zotero_fulltext', { itemKey: 'ABCD1234', attachmentKey: 'ATT00002' })
  assert.equal(plainFile.mode, 'file')
  assert.match(plainFile.path, /notes\.txt$/)

  const download = await run('zotero_download', { itemKey: 'ABCD1234', attachmentKey: 'ATT00002' })
  assert.match(download.path, new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

  const attachmentPath = await run('zotero_attachment_path', { itemKey: 'ABCD1234', attachmentKey: 'ATT00001' })
  assert.equal(attachmentPath.exists, true)
  assert.match(attachmentPath.path, /paper\.pdf$/)

  const notes = await run('zotero_notes', { itemKey: 'ABCD1234' })
  assert.equal(notes.count, 1)

  const created = await run('zotero_note', { action: 'create', itemKey: 'ABCD1234', text: '<p>hello</p>' })
  assert.ok(created.noteKey)
  const appended = await run('zotero_note', { action: 'append', noteKey: created.noteKey, text: 'more' })
  assert.equal(appended.action, 'append')
  const updated = await run('zotero_note', { action: 'update', noteKey: created.noteKey, text: 'replaced' })
  assert.equal(updated.action, 'update')
  const deleted = await run('zotero_note', { action: 'delete', noteKey: created.noteKey })
  assert.equal(deleted.action, 'delete')
})
