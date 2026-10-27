import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { resolveConfig, slimItem, trimItems } from '../lib/zotero-client.js'
import { noteToText } from '../lib/notes.js'
import { queryFromTitle, scorePassages, splitPassages, tokenize } from '../lib/retrieve.js'
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

test('apply registers fourteen zotero tools with valid JSON schemas', () => {
  const ctx = harness()
  apply(ctx, {})
  const names = ctx.all.map((t) => t.name)
  assert.deepEqual([...names].sort(), [
    'zotero_annotations',
    'zotero_attachment_path',
    'zotero_browse',
    'zotero_collections',
    'zotero_digest',
    'zotero_download',
    'zotero_export',
    'zotero_fulltext',
    'zotero_item',
    'zotero_note',
    'zotero_notes',
    'zotero_recent',
    'zotero_retrieve',
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
  assert.deepEqual(ctx.tool('zotero_export').parameters.required, ['keys'])
  assert.deepEqual(ctx.tool('zotero_annotations').parameters.required, ['itemKey'])
  assert.deepEqual(ctx.tool('zotero_retrieve').parameters.required, ['itemKey', 'query'])
  assert.deepEqual(ctx.tool('zotero_digest').parameters.required, ['itemKey'])
})

test('argument validation across tools', async () => {
  const ctx = harness()
  apply(ctx, {})
  await assert.rejects(() => ctx.tool('zotero_item').execute({ key: 'nope' }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_note').execute({ itemKey: 'ABCD1234', text: '  ' }), /text/)
  await assert.rejects(() => ctx.tool('zotero_note').execute({ action: 'update', noteKey: 'bad', text: 'x' }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_note').execute({ action: 'remove', itemKey: 'ABCD1234', text: 'x' }), /action/)
  await assert.rejects(() => ctx.tool('zotero_fulltext').execute({ itemKey: 'ABCD123' }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_export').execute({ keys: [] }), /keys/)
  await assert.rejects(() => ctx.tool('zotero_export').execute({ keys: ['bad'] }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_export').execute({ keys: Array.from({ length: 26 }, (_, i) => `K${String(i).padStart(7, '0')}`) }), /25/)
  await assert.rejects(() => ctx.tool('zotero_annotations').execute({ itemKey: 'ABCD123' }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_retrieve').execute({ itemKey: 'ABCD1234', query: '  ' }), /query/)
  await assert.rejects(() => ctx.tool('zotero_retrieve').execute({ itemKey: 'ABCD123' }), /8 位 key/)
  await assert.rejects(() => ctx.tool('zotero_digest').execute({ itemKey: 'ABCD123' }), /8 位 key/)
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

test('splitPassages splits long text at sentence boundaries with overlap', () => {
  const sentence = 'This is a test sentence about nanomedicine. '
  const long = sentence.repeat(60) // ~2640 chars → 2+ passages
  const parts = splitPassages(long, 1300, 160)
  assert.ok(parts.length >= 2, `expected >=2 passages, got ${parts.length}`)
  for (const part of parts) {
    assert.ok(part.length > 40, 'passages carry real content')
    assert.ok(part.length <= 1300 + 40, `passage too long: ${part.length}`)
  }
  // 短文本原样返回
  assert.deepEqual(splitPassages('short text'), ['short text'])
  assert.deepEqual(splitPassages(''), [])
  // CJK 句号也能切
  const cjk = '第一句话讲的是方法。'.repeat(200)
  const cjkParts = splitPassages(cjk, 1300, 160)
  assert.ok(cjkParts.length >= 2)
})

test('tokenize handles mixed Latin and CJK', () => {
  const terms = tokenize('Paclitaxel-loaded nanoparticles 纳米载体的副作用')
  assert.ok(terms.includes('paclitaxel-loaded'))
  assert.ok(terms.includes('nanoparticles'))
  assert.ok(terms.includes('纳米'), 'CJK bigrams present')
  assert.ok(terms.includes('米载'), 'CJK bigrams span boundaries')
  assert.ok(!terms.includes('的'), 'stopword dropped')
})

test('scorePassages ranks matching passages first', () => {
  const passages = [
    { source: 'fulltext', text: 'The manufacturing process of liposomes involves lipid hydration and extrusion steps.' },
    { source: 'fulltext', text: 'Paclitaxel-loaded nanoparticles showed significant tumor suppression in mice models.' },
    { source: 'notes', text: 'Random meeting notes about scheduling and budget planning for the lab.' },
  ]
  const ranked = scorePassages(passages, 'paclitaxel nanoparticle tumor suppression')
  assert.equal(ranked.length, 3)
  assert.match(ranked[0].text, /Paclitaxel/)
  assert.ok(ranked[0].score > 0)
  assert.equal(ranked[ranked.length - 1].text, passages[2].text, 'irrelevant passage ranks last')
  // 空查询不炸，保持原序兜底
  const fallback = scorePassages(passages, '')
  assert.equal(fallback.length, 3)
})

test('queryFromTitle derives fallback query', () => {
  const query = queryFromTitle('Engineering of Paclitaxel-Loaded Nanoparticles for Tumor Therapy')
  assert.ok(query.includes('paclitaxel-loaded'))
  assert.ok(!/\bthe\b/.test(query), 'stopwords dropped')
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

test('storage helpers resolve storage dir, ft-cache and attachment paths', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-zotero-data-'))
  try {
    mkdirSync(join(dataDir, 'Profiles', 'prof.default', 'zotero', 'storage', 'ATT00001'), { recursive: true })
    writeFileSync(
      join(dataDir, 'profiles.ini'),
      '[InstallX]\nDefault=prof.default\n\n[prof.default]\nIsRelative=1\nPath=Profiles/prof.default\n',
      'utf8',
    )
    writeFileSync(join(dataDir, 'Profiles', 'prof.default', 'zotero', 'storage', 'ATT00001', '.zotero-ft-cache'), '  full text cache  ')

    const storage = resolveStorageDir({ dataDir })
    assert.ok(storage && storage.endsWith(join('zotero', 'storage')), `resolved: ${storage}`)
    assert.equal(await readFulltextCache(storage, 'ATT00001'), 'full text cache')
    assert.equal(await readFulltextCache(storage, 'NOPE1234'), null)

    const p = attachmentStoragePath(storage, 'ATT00001', 'storage:paper.pdf')
    assert.equal(p, join(storage, 'ATT00001', 'paper.pdf'))
    assert.equal(attachmentStoragePath(storage, 'ATT00001', 'attachments:paper.pdf'), null)

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
