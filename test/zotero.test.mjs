import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { resolveConfig, slimItem, trimItems, ZoteroClient } from '../lib/zotero-client.js'
import { noteToText } from '../lib/notes.js'
import { attachmentStoragePath, profileDirFromIni, readFulltextCache, resolveStorageDir } from '../lib/storage.js'
import { writeAttachment } from '../lib/files.js'

function harness() {
  const tools = []
  return {
    tools: { register: (t) => tools.push(t) },
    tool(name) {
      const found = tools.find((t) => t.name === name)
      assert.ok(found, `tool ${name} registered`)
      return found
    },
    get all() {
      return tools
    },
  }
}

const ITEM = {
  key: 'ABCD1234',
  itemType: 'journalArticle',
  title: 'Attention Is All You Need',
  creators: 'Vaswani, Ashish',
  date: '2017-06',
  publicationTitle: 'NeurIPS',
  DOI: '10.5555/x',
  url: 'https://example.com',
  abstractNote: 'x'.repeat(600),
  tags: ['transformer'],
  dateAdded: '2026-01-01',
}

test('resolveConfig defaults, validation and new fields', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:23119')
  assert.equal(cfg.libraryPath, 'users/0')
  assert.equal(cfg.maxFulltextChars, 80000)
  assert.equal(cfg.storageDir, undefined)
  assert.equal(resolveConfig({ library: 'group:12345' }).libraryPath, 'groups/12345')
  assert.throws(() => resolveConfig({ library: 'bogus' }))
})

test('apply registers nine zotero tools with valid JSON schemas', () => {
  const ctx = harness()
  apply(ctx, {})
  const names = ctx.all.map((t) => t.name)
  assert.deepEqual([...names].sort(), [
    'zotero_attachment_path',
    'zotero_collections',
    'zotero_download',
    'zotero_fulltext',
    'zotero_item',
    'zotero_note',
    'zotero_notes',
    'zotero_recent',
    'zotero_search',
  ])
  for (const tool of ctx.all) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.description.length > 20)
  }
  const search = ctx.tool('zotero_search')
  for (const field of ['mode', 'beforeYear', 'sinceYear', 'sort', 'direction', 'offset']) {
    assert.ok(search.parameters.properties[field], `search.${field} present`)
  }
  const note = ctx.tool('zotero_note')
  assert.ok(note.parameters.properties.action)
  assert.deepEqual(ctx.tool('zotero_item').parameters.required, ['key'])
  assert.deepEqual(ctx.tool('zotero_fulltext').parameters.required, ['itemKey'])
})

test('argument validation across tools', async () => {
  const ctx = harness()
  apply(ctx, {})
  await assert.rejects(() => ctx.tool('zotero_item').execute({ key: 'nope' }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_note').execute({ itemKey: 'ABCD1234', text: '  ' }), /text/)
  await assert.rejects(() => ctx.tool('zotero_note').execute({ action: 'update', noteKey: 'bad', text: 'x' }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_note').execute({ action: 'remove', itemKey: 'ABCD1234', text: 'x' }), /action/)
  await assert.rejects(() => ctx.tool('zotero_fulltext').execute({ itemKey: 'ABCD123' }), /8 位 key/)
})

test('trimItems controls result verbosity', () => {
  const minimal = trimItems([ITEM], 'minimal')[0]
  assert.equal(minimal.abstractNote, undefined)
  assert.equal(minimal.url, undefined)
  assert.equal(minimal.title, ITEM.title)

  const preview = trimItems([ITEM], 'preview')[0]
  assert.ok(preview.abstractNote.length <= 401)
  assert.ok(preview.abstractNote.endsWith('…'))
  assert.deepEqual(preview.tags, ITEM.tags)

  const full = trimItems([ITEM], 'full')[0]
  assert.equal(full.abstractNote, ITEM.abstractNote)
})

test('noteToText converts note HTML', () => {
  assert.equal(noteToText('<p>hello<br>world</p>'), 'hello\nworld')
  assert.equal(noteToText('<div>a &amp; b &lt;c&gt; &quot;d&quot; &#65;</div>'), 'a & b <c> "d" A')
})

test('profileDirFromIni prefers the Install default and honors absolute paths', () => {
  const ini = [
    '[InstallABC]',
    'Default=xyz.default',
    '',
    '[abc.default]',
    'IsRelative=1',
    'Path=Profiles/abc.default',
    '',
    '[xyz.default]',
    'IsRelative=1',
    'Path=Profiles/xyz.default',
    '',
  ].join('\n')
  assert.equal(profileDirFromIni(ini, 'D:/data'), join('D:/data', 'Profiles/xyz.default'))

  const abs = '[p]\nIsRelative=0\nPath=C:/custom/profile\n'
  assert.equal(profileDirFromIni(abs, 'D:/data'), 'C:/custom/profile')
})

test('storage helpers resolve Zotero 7+ storage dir, ft-cache and legacy fallback', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-zotero-data-'))
  const profile = join(dataDir, 'Profiles', 'prof.default')
  try {
    mkdirSync(join(profile, 'storage', 'ATT00001'), { recursive: true })
    writeFileSync(
      join(dataDir, 'profiles.ini'),
      '[InstallX]\nDefault=Profiles/prof.default\n\n[Profile0]\nIsRelative=1\nPath=Profiles/prof.default\n',
      'utf8',
    )
    writeFileSync(join(profile, 'storage', 'ATT00001', '.zotero-ft-cache'), '  full text cache  ')

    const storage = resolveStorageDir({ dataDir })
    assert.equal(storage, join(profile, 'storage'))
    assert.equal(await readFulltextCache(storage, 'ATT00001'), 'full text cache')
    assert.equal(await readFulltextCache(storage, 'NOPE1234'), null)

    const filePath = attachmentStoragePath(storage, 'ATT00001', 'storage:paper.pdf')
    assert.equal(filePath, join(storage, 'ATT00001', 'paper.pdf'))
    assert.equal(attachmentStoragePath(storage, 'ATT00001', 'attachments:paper.pdf'), null)

    rmSync(join(profile, 'storage'), { recursive: true, force: true })
    mkdirSync(join(profile, 'zotero', 'storage'), { recursive: true })
    assert.equal(resolveStorageDir({ dataDir }), join(profile, 'zotero', 'storage'))
    assert.equal(resolveStorageDir({ dataDir, storageDir: 'D:/custom-storage' }), 'D:/custom-storage')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('fileUrlToPath converts file:// URLs to filesystem paths', async () => {
  const { fileUrlToPath } = await import('../lib/files.js')
  assert.equal(
    fileUrlToPath('file:///C:/Software/Data/02-Zotero/storage/M6TDVS2M/paper%20title.pdf'),
    'C:/Software/Data/02-Zotero/storage/M6TDVS2M/paper title.pdf',
  )
  assert.equal(fileUrlToPath('file:///home/user/papers/x.pdf'), '/home/user/papers/x.pdf')
  assert.equal(fileUrlToPath('https://example.com/paper.pdf'), 'https://example.com/paper.pdf')
})

test('slimItem compresses raw Zotero rows', () => {
  const slim = slimItem({
    key: 'ABCD1234',
    data: {
      itemType: 'journalArticle',
      title: '  Attention Is All You Need ',
      date: '2017-06',
      DOI: '10.5555/x',
      creators: [
        { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
        { name: 'Group Author' },
      ],
      tags: [{ tag: 'transformer' }, {}],
    },
    meta: {},
  })
  assert.equal(slim.title, 'Attention Is All You Need')
  assert.equal(slim.creators, 'Vaswani, Ashish; Group Author')
  assert.deepEqual(slim.tags, ['transformer'])
  assert.equal(Object.hasOwn(slim, 'ISBN'), false)
  assert.equal(Object.hasOwn(slim, 'url'), false)
  assert.doesNotThrow(() => assertLosslessJson(slim))
})

test('writeAttachment writes into cwd and deconflicts names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-zotero-'))
  try {
    const p1 = await writeAttachment('paper.pdf', new Uint8Array([1, 2, 3]), undefined, dir)
    const p2 = await writeAttachment('paper.pdf', new Uint8Array([4]), undefined, dir)
    assert.notEqual(p1, p2)
    assert.deepEqual([...readFileSync(p1)], [1, 2, 3])
    assert.deepEqual([...readFileSync(p2)], [4])
    assert.ok(existsSync(p1))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


function assertLosslessJson(value, path = '$') {
  if (value === undefined) assert.fail(`${path} contains undefined`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} must be finite`)
    assert.ok(!Object.is(value, -0), `${path} must not be -0`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertLosslessJson(entry, `${path}[${index}]`))
    return
  }
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} must be a plain object`)
  for (const [key, entry] of Object.entries(value)) assertLosslessJson(entry, `${path}.${key}`)
}

function rawItem(key, date, itemType = 'journalArticle') {
  return { key, data: { itemType, title: `Title ${key}`, date } }
}

test('collections paginates all rows and preserves top-level parentCollection=false', async () => {
  const originalFetch = globalThis.fetch
  const starts = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/api/users/0/collections')
    const start = Number(url.searchParams.get('start') ?? '0')
    starts.push(start)
    const rows = Array.from({ length: Math.min(100, 204 - start) }, (_, i) => ({
      key: `C${String(start + i).padStart(7, '0')}`.slice(-8),
      data: { name: `Collection ${start + i}`, parentCollection: start + i === 0 ? false : 'PARENT01' },
      meta: { numItems: start + i },
    }))
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Total-Results': '204', 'Content-Type': 'application/json' } })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const collections = await client.collections()
    assert.equal(collections.length, 204)
    assert.deepEqual(starts, [0, 100, 200])
    assert.equal(collections[0].parentCollection, false)
    assert.doesNotThrow(() => assertLosslessJson({ collections }))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search validates collection key before querying collection items', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    seen.push(url.pathname)
    if (url.pathname.endsWith('/collections/BOGUSKEY')) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Total-Results': '0', 'Content-Type': 'application/json' } })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    await assert.rejects(
      () => client.search({ collection: 'BOGUSKEY', limit: 2 }),
      /分类 BOGUSKEY 不存在或无法访问/,
    )
    assert.deepEqual(seen, ['/api/users/0/collections/BOGUSKEY'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search uses one supported negative itemType and client-filters subitems while paginating year results', async () => {
  const originalFetch = globalThis.fetch
  const starts = []
  const itemTypes = []
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => rawItem(`N${String(i).padStart(7, '0')}`.slice(-8), '2024', 'note')),
    ...Array.from({ length: 90 }, (_, i) => rawItem(`O${String(i).padStart(7, '0')}`.slice(-8), '2020')),
    ...Array.from({ length: 5 }, (_, i) => rawItem(`A${String(i).padStart(7, '0')}`.slice(-8), '2024', 'attachment')),
    ...Array.from({ length: 45 }, (_, i) => rawItem(`B${String(i).padStart(7, '0')}`.slice(-8), '2024')),
  ]
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/api/users/0/items')
    const start = Number(url.searchParams.get('start') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '100')
    starts.push(start)
    itemTypes.push(url.searchParams.get('itemType'))
    return new Response(JSON.stringify(rows.slice(start, start + limit)), {
      status: 200,
      headers: { 'Total-Results': String(rows.length), 'Content-Type': 'application/json' },
    })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const result = await client.search({ sinceYear: 2024, limit: 3 })
    assert.equal(result.items.length, 3)
    assert.deepEqual(starts, [0, 100])
    assert.ok(itemTypes.every((value) => value === '-attachment'))
    assert.ok(result.items.every((item) => item.date === '2024'))
    assert.ok(result.items.every((item) => !['attachment', 'note'].includes(item.itemType)))
    assert.equal(result.totalResults, 150)
    assert.doesNotThrow(() => assertLosslessJson(result))
  } finally {
    globalThis.fetch = originalFetch
  }
})

 test('default search and recent fill the requested limit after filtering attachment/note rows', async () => {
  const originalFetch = globalThis.fetch
  const starts = []
  const rows = [
    ...Array.from({ length: 100 }, (_, i) => rawItem(`N${String(i).padStart(7, '0')}`.slice(-8), '2026', i % 2 ? 'note' : 'attachment')),
    ...Array.from({ length: 6 }, (_, i) => ({ ...rawItem(`J${String(i).padStart(7, '0')}`.slice(-8), '2026'), data: { ...rawItem(`J${String(i).padStart(7, '0')}`.slice(-8), '2026').data, dateAdded: `2026-09-${String(30-i).padStart(2, '0')}` } })),
  ]
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const start = Number(url.searchParams.get('start') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '100')
    if (limit === 1) {
      // 计数请求（visible 口径），不属于分页
      return new Response('[]', { status: 200, headers: { 'Total-Results': String(rows.length) } })
    }
    starts.push(start)
    assert.equal(url.searchParams.get('itemType'), '-attachment')
    return new Response(JSON.stringify(rows.slice(start, start + limit)), {
      status: 200,
      headers: { 'Total-Results': String(rows.length), 'Content-Type': 'application/json' },
    })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const searched = await client.search({ limit: 3 })
    assert.equal(searched.items.length, 3)
    assert.ok(searched.items.every((item) => !['attachment', 'note', 'annotation'].includes(item.itemType)))
    const recent = await client.recent(3)
    assert.equal(recent.items.length, 3)
    assert.ok(recent.items.every((item) => !['attachment', 'note', 'annotation'].includes(item.itemType)))
    assert.ok(starts.includes(100), 'client filtering must continue to the next page')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('year-filtered search applies offset after filtering', async () => {
  const originalFetch = globalThis.fetch
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => rawItem(`O${String(i).padStart(7, '0')}`.slice(-8), '2020')),
    ...Array.from({ length: 6 }, (_, i) => rawItem(`N${String(i).padStart(7, '0')}`.slice(-8), '2025')),
  ]
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const start = Number(url.searchParams.get('start') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '100')
    return new Response(JSON.stringify(rows.slice(start, start + limit)), {
      status: 200,
      headers: { 'Total-Results': String(rows.length), 'Content-Type': 'application/json' },
    })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const result = await client.search({ sinceYear: 2024, start: 2, limit: 2 })
    assert.deepEqual(result.items.map((item) => item.key), ['N0000002', 'N0000003'])
  } finally {
    globalThis.fetch = originalFetch
  }
})


test('item output is lossless JSON and children paginate beyond 100 rows', async () => {
  const originalFetch = globalThis.fetch
  const children = [
    ...Array.from({ length: 100 }, (_, i) => ({
      key: `P${String(i).padStart(7, '0')}`.slice(-8),
      data: { itemType: 'attachment', path: `storage:file-${i}.pdf` },
    })),
    {
      key: 'NOTE0001',
      data: { itemType: 'note', note: '<p>hello</p>', parentItem: 'ITEM0001' },
    },
  ]
  const starts = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/users/0/items/ITEM0001') {
      return new Response(JSON.stringify(rawItem('ITEM0001', '2026')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.pathname === '/api/users/0/items/ITEM0001/children') {
      const start = Number(url.searchParams.get('start') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '100')
      starts.push(start)
      return new Response(JSON.stringify(children.slice(start, start + limit)), {
        status: 200,
        headers: { 'Total-Results': String(children.length), 'Content-Type': 'application/json' },
      })
    }
    return new Response('Not Found', { status: 404, statusText: 'Not Found' })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const result = await client.item('ITEM0001')
    assert.equal(result.attachments.length, 100)
    assert.equal(result.childNotes, 1)
    assert.deepEqual(starts, [0, 100])
    assert.equal(Object.hasOwn(result.attachments[0], 'title'), false)
    assert.doesNotThrow(() => assertLosslessJson(result))
  } finally {
    globalThis.fetch = originalFetch
  }
})


test('write endpoints map Zotero 10 HTTP 428 to a friendly write-blocked error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Zotero-Server-ID not provided', { status: 428, statusText: '' })
  try {
    const client = new ZoteroClient(resolveConfig({ writeEnabled: true }))
    await assert.rejects(
      () => client.addNote('ITEM0001', 'hello'),
      (error) => {
        assert.match(error.message, /不支持该写操作/)
        assert.match(error.message, /手动操作/)
        assert.match(error.message, /Server-ID/)
        assert.doesNotMatch(error.message, /undefined/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('writeEnabled defaults to false: write tools reject before any request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const expected = (error) => {
      assert.match(error.message, /writeEnabled/)
      assert.match(error.message, /不支持该写操作/)
      assert.match(error.message, /apiKey/)
      return true
    }
    await assert.rejects(() => client.addNote('ITEM0001', 'hello'), expected)
    await assert.rejects(() => client.deleteNote('NOTE0001'), expected)
    assert.equal(calls, 0, 'writeEnabled=false 时不发任何 HTTP 请求')
    // 工具层同样在读取条目之前就拒绝
    const ctx = harness()
    apply(ctx, {})
    await assert.rejects(() => ctx.tool('zotero_note').execute({ action: 'delete', noteKey: 'NOTE0001' }), /writeEnabled/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('writeEnabled=true sends Zotero-Server-ID and maps 401 to the authorization guidance', async () => {
  const originalFetch = globalThis.fetch
  const writes = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/') {
      return new Response('{}', {
        status: 200,
        headers: { 'Zotero-Server-ID': '0FBXuwBFJfiK', 'Content-Type': 'application/json' },
      })
    }
    writes.push({ path: url.pathname, headers: { ...(init?.headers ?? {}) } })
    return new Response('API key required -- POST /api/local/authorize to obtain one', { status: 401, statusText: '' })
  }
  try {
    const client = new ZoteroClient(resolveConfig({ writeEnabled: true }))
    await assert.rejects(
      () => client.addNote('ITEM0001', 'hello'),
      (error) => {
        assert.match(error.message, /api\/local\/authorize/)
        assert.match(error.message, /apiKey/)
        assert.match(error.message, /不支持该写操作/)
        assert.doesNotMatch(error.message, /只读/)
        return true
      },
    )
    assert.equal(writes.length, 1, '只发起一次写请求')
    assert.equal(writes[0].headers['Zotero-Server-ID'], '0FBXuwBFJfiK')
    assert.equal(writes[0].headers['Zotero-API-Key'], undefined, '未配置 apiKey 时不带该头')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('writeEnabled=true with apiKey attaches Zotero-API-Key and returns the created note key', async () => {
  const originalFetch = globalThis.fetch
  const writes = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/') {
      return new Response('{}', {
        status: 200,
        headers: { 'Zotero-Server-ID': '0FBXuwBFJfiK', 'Content-Type': 'application/json' },
      })
    }
    writes.push({ headers: { ...(init?.headers ?? {}) } })
    return new Response(JSON.stringify({ success: { 0: 'NOTE0001' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const client = new ZoteroClient(resolveConfig({ writeEnabled: true, apiKey: ' secret-key ' }))
    assert.equal(await client.addNote('ITEM0001', 'hello'), 'NOTE0001')
    assert.equal(writes[0].headers['Zotero-API-Key'], 'secret-key')
    assert.equal(writes[0].headers['Zotero-Server-ID'], '0FBXuwBFJfiK')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search reports the exact visible total: server rows minus notes (annotations already excluded)', async () => {
  const originalFetch = globalThis.fetch
  const countRequests = []
  const rows = Array.from({ length: 100 }, (_, i) => rawItem(`J${String(i).padStart(7, '0')}`, '2024'))
  // 实测形态：全部 13169 = 顶层 4938 + 笔记 1541 + 附件 4662 + 标注 2028；-attachment 返回 6479 = 顶层 + 笔记
  const totals = { all: 13169, attachment: 4662, annotation: 2028, note: 1541, negative: 6479 }
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const itemType = url.searchParams.get('itemType')
    const limit = Number(url.searchParams.get('limit') ?? '100')
    if (limit === 1) {
      countRequests.push(itemType)
      const total =
        itemType === 'attachment'
          ? totals.attachment
          : itemType === 'annotation'
            ? totals.annotation
            : itemType === 'note'
              ? totals.note
              : totals.all
      return new Response('[]', { status: 200, headers: { 'Total-Results': String(total) } })
    }
    const start = Number(url.searchParams.get('start') ?? '0')
    return new Response(JSON.stringify(rows.slice(start, start + limit)), {
      status: 200,
      headers: { 'Total-Results': String(totals.negative), 'Content-Type': 'application/json' },
    })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const result = await client.search({ limit: 3 })
    assert.equal(result.totalResults, totals.negative - totals.note, '服务器计数要减去结果里的笔记')
    assert.equal(result.totalResults, 4938)
    assert.equal(result.totalResultsKind, 'visible')
    assert.equal(countRequests.length, 4, '四次计数请求（全部/附件/标注/笔记）')
    assert.deepEqual([...new Set(countRequests.map((v) => v ?? 'all'))].sort(), [
      'all',
      'annotation',
      'attachment',
      'note',
    ])
    assert.equal(result.items.length, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search subtracts attachments and annotations too when the server ignores the negative itemType', async () => {
  const originalFetch = globalThis.fetch
  const notes = Array.from({ length: 10 }, (_, i) => rawItem(`N${String(i).padStart(7, '0')}`, '2024', 'note'))
  const annotations = Array.from({ length: 5 }, (_, i) => rawItem(`A${String(i).padStart(7, '0')}`, '2024', 'annotation'))
  const attachments = Array.from({ length: 5 }, (_, i) => rawItem(`B${String(i).padStart(7, '0')}`, '2024', 'attachment'))
  const top = Array.from({ length: 20 }, (_, i) => rawItem(`T${String(i).padStart(7, '0')}`, '2024'))
  const rows = [...notes, ...annotations, ...attachments, ...top]
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const itemType = url.searchParams.get('itemType')
    const limit = Number(url.searchParams.get('limit') ?? '100')
    if (limit === 1) {
      const counts = {
        attachment: attachments.length,
        annotation: annotations.length,
        note: notes.length,
      }
      return new Response('[]', { status: 200, headers: { 'Total-Results': String(counts[itemType] ?? rows.length) } })
    }
    // 服务器忽略 -attachment：返回全部行，Total-Results 也是全部
    const start = Number(url.searchParams.get('start') ?? '0')
    return new Response(JSON.stringify(rows.slice(start, start + limit)), {
      status: 200,
      headers: { 'Total-Results': String(rows.length), 'Content-Type': 'application/json' },
    })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const result = await client.search({ limit: 50 })
    assert.equal(result.totalResults, top.length, '全部行减去附件/标注/笔记')
    assert.equal(result.totalResultsKind, 'visible')
    assert.equal(result.items.length, top.length)
    assert.ok(result.items.every((item) => !['attachment', 'note', 'annotation'].includes(item.itemType)))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('year-filtered search marks the server total as approximate and says so in the render', async () => {
  const originalFetch = globalThis.fetch
  let countRequests = 0
  const rows = Array.from({ length: 5 }, (_, i) => rawItem(`K${String(i).padStart(7, '0')}`, '2024'))
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (Number(url.searchParams.get('limit') ?? '100') === 1) countRequests += 1
    const start = Number(url.searchParams.get('start') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '100')
    return new Response(JSON.stringify(rows.slice(start, start + limit)), {
      status: 200,
      headers: { 'Total-Results': '6467', 'Content-Type': 'application/json' },
    })
  }
  try {
    const client = new ZoteroClient(resolveConfig({}))
    const result = await client.search({ sinceYear: 2024, limit: 2 })
    assert.equal(result.totalResultsKind, 'server-approximate')
    assert.equal(result.totalResults, 6467)
    assert.equal(countRequests, 0, '年份过滤时不做额外计数请求')
    const ctx = harness()
    apply(ctx, {})
    const [block] = ctx.tool('zotero_search').output.render({}, { ...result, count: result.items.length })
    assert.match(block.text, /含已过滤/)
    assert.match(block.text, /少于该数/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('apply registers the bundled paper-reading skill when a skill registry is present', async () => {
  const providers = []
  const ctx = harness()
  ctx.logger = { info() {}, warn() {} }
  ctx.skills = { registerProvider: (create) => providers.push(create({ signal: undefined, invalidate() {} })) }
  apply(ctx, {})
  assert.equal(providers.length, 1, '注册了一个技能提供方')

  const provider = providers[0]
  assert.equal(provider.name, 'dsh-zotero')
  const [candidate] = await provider.list()
  assert.equal(candidate.name, 'paper-reading')
  assert.equal(candidate.provider, 'dsh-zotero')
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, 600)
  assert.ok(candidate.description.includes('文献'), 'frontmatter description 被解析')
  assert.equal(candidate.invocation.modelInvocable, true)
  assert.ok(candidate.resourceBase.path.endsWith(join('skills', 'paper-reading')))

  const loaded = await provider.get(candidate, {})
  assert.ok(loaded.content.includes('结构化文献精读'), '正文不含 frontmatter')
  assert.ok(!loaded.content.startsWith('---'))
  assert.equal(loaded.description, candidate.description)
  assert.doesNotThrow(() => assertLosslessJson(loaded))
})

test('a registry rejecting duplicate providers must not break plugin load', async () => {
  const ctx = harness()
  ctx.logger = { info() {}, warn() {} }
  ctx.skills = {
    registerProvider: () => {
      throw new Error('duplicate provider "dsh-zotero"')
    },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.all.length, 9, '九个工具照常注册')
})

test('plugin load without any skill registry keeps working', async () => {
  const ctx = harness() // 无 ctx.skills、无 ctx.get
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.all.length, 9)
})
