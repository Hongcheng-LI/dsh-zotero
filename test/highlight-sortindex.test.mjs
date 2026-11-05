import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { ZoteroClient, resolveConfig } from '../lib/zotero-client.js'

const SERVER_ID = 'TESTSERV01'

/**
 * 回归测试：PDF 附件的 annotationSortIndex 必须匹配 /^\d{5}\|\d{6}\|\d{5}$/。
 * 依据 Zotero chrome/content/zotero/xpcom/data/item.js:4547 的 PDF 分支校验；
 * 早期写成 5|5|5 时被真实 Zotero 10.0.7 以
 * "Invalid sortIndex '00000|00000|00000'" 拒绝。
 */
test('addHighlight builds a PDF-legal annotationSortIndex (5|6|5)', async (t) => {
  let posted = null
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock')
    if (req.method === 'GET' && url.pathname === '/api/users/0/items') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Total-Results': '1',
        'Zotero-Server-ID': SERVER_ID,
      })
      res.end('[]')
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/users/0/items') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        posted = { headers: req.headers, body: JSON.parse(body || '[]') }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Zotero-Server-ID': SERVER_ID,
        })
        res.end(JSON.stringify({ success: { '0': 'NEWHL001' } }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const client = new ZoteroClient(resolveConfig({
    baseUrl: `http://127.0.0.1:${port}`,
    localApiKey: 'MOCKKEY',
  }))
  const key = await client.addHighlight({
    attachmentKey: 'ATT00001',
    text: 'Prenyltransferase fusion proteins improve terpene production',
    page: 1,
    pageLabel: '4',
    color: '#ffd400',
    comment: '',
  })

  assert.equal(key, 'NEWHL001')
  assert.ok(posted, 'POST /items reached mock')
  assert.equal(posted.headers['zotero-server-id'], SERVER_ID)
  assert.equal(posted.headers['zotero-api-key'], 'MOCKKEY')
  const item = posted.body[0]
  assert.equal(item.itemType, 'annotation')
  assert.equal(item.parentItem, 'ATT00001')
  assert.equal(item.annotationType, 'highlight')
  assert.equal(item.annotationText, 'Prenyltransferase fusion proteins improve terpene production')
  assert.match(
    item.annotationSortIndex,
    /^\d{5}\|\d{6}\|\d{5}$/,
    'PDF annotation sortIndex must be 5|6|5 (item.js:4547)',
  )
  assert.equal(item.annotationPageLabel, '4')
  const pos = JSON.parse(item.annotationPosition)
  assert.equal(pos.pageIndex, 0)
  assert.ok(Array.isArray(pos.rects) && pos.rects.length > 0)
})

test('addHighlight derives sortIndex from supplied rects and stays in range', async (t) => {
  let posted = null
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock')
    if (req.method === 'GET' && url.pathname === '/api/users/0/items') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Zotero-Server-ID': SERVER_ID })
      res.end('[]')
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/users/0/items') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        posted = JSON.parse(body || '[]')
        res.writeHead(200, { 'Content-Type': 'application/json', 'Zotero-Server-ID': SERVER_ID })
        res.end(JSON.stringify({ success: { '0': 'NEWHL002' } }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const client = new ZoteroClient(resolveConfig({
    baseUrl: `http://127.0.0.1:${port}`,
    localApiKey: 'MOCKKEY',
  }))
  await client.addHighlight({
    attachmentKey: 'ATT00001',
    text: 'x',
    page: 4,
    rects: [[461.867, 88.408, 538.591, 97.316]],
  })
  const item = posted[0]
  // pageIndex = 3, top = 88.408 -> 884, left = 461.867 -> 4619
  assert.equal(item.annotationSortIndex, '00003|000884|04619')
  const pos = JSON.parse(item.annotationPosition)
  assert.equal(pos.pageIndex, 3)
  assert.deepEqual(pos.rects, [[461.867, 88.408, 538.591, 97.316]])
})
