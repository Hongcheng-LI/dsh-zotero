// 批量预索引：给 Zotero 的 PDF 附件生成 .zotero-ft-cache 全文缓存。
// 用途：让 zotero_fulltext 首次读取即命中缓存（秒回），无需现场解析。
//
// 用法：
//   node tools/batch-index-zotero.mjs [collectionKey] [limit]
//   - collectionKey: Zotero 分类 key（如 WX2X7JPG = 01-紫杉醇）；缺省 = 全库
//   - limit: 最多处理多少条（缺省无限）
//
// 行为：
//   - 只处理有本地 PDF 附件的条目
//   - 已有 .zotero-ft-cache 的跳过（增量）
//   - 每个 PDF 用 pdfjs-dist 解析，写 <storage>/<attachmentKey>/.zotero-ft-cache
//   - 进度 + 统计 + 失败列表
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import http from 'node:http'
import { extractPdfText } from '../lib/pdf.js'

const BASE = 'http://127.0.0.1:23119'
const COLLECTION = process.argv[2] || ''
const LIMIT = parseInt(process.argv[3] || '0', 10) || Infinity

function zf(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: 23119, path, method: 'GET',
      headers: { 'Zotero-Allowed-Request': 'true' }
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${buf.toString().substring(0, 200)}`))
        try { resolve(JSON.parse(buf.toString())) } catch { resolve(buf.toString()) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function getAllItems() {
  if (COLLECTION) {
    const all = []
    let start = 0
    while (true) {
      const items = await zf(`/api/users/0/collections/${COLLECTION}/items?limit=100&start=${start}&format=json`)
      all.push(...items)
      if (items.length < 100) break
      start += 100
    }
    return all
  }
  const all = []
  let start = 0
  while (true) {
    const items = await zf(`/api/users/0/items?limit=100&start=${start}&format=json&itemType=attachment`)
    all.push(...items)
    if (items.length < 100) break
    start += 100
  }
  return all
}

async function getAttachmentLocalPath(attachmentKey) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 23119, path: `/api/users/0/items/${attachmentKey}/file`, method: 'GET',
      headers: { 'Zotero-Allowed-Request': 'true' }
    }, (res) => {
      resolve(res.headers.location || null)
      res.resume()
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

function fileUrlToPath(url) {
  if (!url.startsWith('file:')) return null
  let p = decodeURIComponent(new URL(url).pathname)
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p
}

async function main() {
  const scope = COLLECTION ? `collection ${COLLECTION}` : '全部条目(附件)'
  console.log(`\n===== 批量预索引 Zotero PDF（${scope}）=====\n`)

  const items = await getAllItems()
  console.log(`条目数: ${items.length}`)

  // 收集附件（顶层 attachment 或父条目下的 attachment），按 key 去重
  const attachmentKeys = []
  const seenKeys = new Set()
  for (const it of items) {
    const d = it.data ?? {}
    if (d.itemType === 'attachment' && (d.contentType ?? '').includes('pdf')) {
      if (!seenKeys.has(it.key)) {
        seenKeys.add(it.key)
        attachmentKeys.push({ key: it.key, title: d.title ?? d.filename ?? '' })
      }
    } else if (d.itemType !== 'attachment') {
      // 父条目：查 children
      try {
        const children = await zf(`/api/users/0/items/${it.key}/children?format=json`)
        for (const c of children) {
          if (c.data?.itemType === 'attachment' && (c.data.contentType ?? '').includes('pdf')) {
            if (!seenKeys.has(c.key)) {
              seenKeys.add(c.key)
              attachmentKeys.push({ key: c.key, title: c.data.title ?? c.data.filename ?? '', parent: it.key })
            }
          }
        }
      } catch { /* 跳过无 children 的 */ }
    }
  }
  console.log(`PDF 附件数: ${attachmentKeys.length}（含子条目扫描）`)
  if (LIMIT < Infinity) console.log(`本次最多处理: ${LIMIT} 条`)

  let ok = 0, skipped = 0, failed = 0, failedList = []
  const startAll = Date.now()

  for (let i = 0; i < attachmentKeys.length; i++) {
    if (ok + skipped >= LIMIT) break
    const { key, title } = attachmentKeys[i]

    const location = await getAttachmentLocalPath(key)
    if (!location?.startsWith('file:')) {
      failed++; failedList.push({ key, reason: '非本地附件', title })
      continue
    }
    const pdfPath = fileUrlToPath(location)
    const cachePath = join(dirname(pdfPath), '.zotero-ft-cache')

    if (existsSync(cachePath)) {
      skipped++
      console.log(`[${i + 1}/${attachmentKeys.length}] SKIP 已有缓存 | ${key} | ${(title || '').substring(0, 50)}`)
      continue
    }
    if (!existsSync(pdfPath)) {
      failed++; failedList.push({ key, reason: 'PDF 文件缺失', title })
      console.log(`[${i + 1}/${attachmentKeys.length}] FAIL 文件缺失 | ${key}`)
      continue
    }

    try {
      const text = await extractPdfText(pdfPath)
      if (text.trim() === '') {
        failed++; failedList.push({ key, reason: '提取为空(可能是扫描件)', title })
        console.log(`[${i + 1}/${attachmentKeys.length}] FAIL 空文本 | ${key} | ${(title || '').substring(0, 50)}`)
        continue
      }
      await writeFile(cachePath, text, 'utf8')
      ok++
      console.log(`[${i + 1}/${attachmentKeys.length}] ✓ ${key} | ${text.length} chars | ${(title || '').substring(0, 50)}`)
    } catch (e) {
      failed++; failedList.push({ key, reason: e.message?.substring(0, 60) || '解析错误', title })
      console.log(`[${i + 1}/${attachmentKeys.length}] FAIL 解析 | ${key} | ${e.message?.substring(0, 80)}`)
    }
  }

  const secs = ((Date.now() - startAll) / 1000).toFixed(1)
  console.log(`\n===== 完成（${secs}s）=====`)
  console.log(`  成功: ${ok}`)
  console.log(`  跳过(已有缓存): ${skipped}`)
  console.log(`  失败: ${failed}`)
  if (failedList.length > 0) {
    console.log('\n失败明细:')
    for (const f of failedList) {
      console.log(`  ${f.key} | ${f.reason} | ${(f.title || '').substring(0, 60)}`)
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
