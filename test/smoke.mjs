/**
 * 真实环境冒烟测试：对本机 Zotero（7 及以上，含 9.x）本地 API 完整跑一遍工具链。
 *
 * 运行方式（需要 Zotero 7+（含 9.x）已启动并开启「允许其他应用程序通信」）：
 *   npm run test:smoke
 * 或指定 API 地址：
 *   ZOTERO_SMOKE=1 ZOTERO_BASE_URL=http://127.0.0.1:23119 node --test test/smoke.mjs
 *
 * 覆盖链路：zotero_recent → zotero_item（找带附件的条目）→ zotero_search
 * → zotero_fulltext（ft-cache 或下载兜底）→ zotero_export / zotero_annotations
 * → zotero_browse → zotero_retrieve / zotero_digest
 * → 笔记生命周期 create/append/update/delete。
 * 笔记测试自带清理：结束时删除创建的笔记，不影响真实文献库。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const ENABLED =
  process.env.ZOTERO_SMOKE === '1' || process.env.npm_lifecycle_event === 'test:smoke'
const BASE_URL = (process.env.ZOTERO_BASE_URL ?? 'http://127.0.0.1:23119').replace(/\/+$/, '')
const SKIP_REASON = '真实环境冒烟测试：用 npm run test:smoke 运行（需要本机 Zotero 7+ 在线）'

function harness(config) {
  const tools = []
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    tool(name) {
      const found = tools.find((t) => t.name === name)
      if (!found) throw new Error(`tool ${name} 未注册`)
      return found
    },
  }
  apply(ctx, config)
  return ctx
}

async function reachable() {
  try {
    const res = await fetch(`${BASE_URL}/api/users/0/items?limit=1`, {
      headers: { 'Zotero-Allowed-Request': 'true' },
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

function unsupported(error) {
  return (
    error instanceof Error &&
    (error.message.includes('不支持该写操作') || error.message.includes('Zotero-Server-ID'))
  )
}

const state = { ctx: null, tempDir: '', recent: [], withAttachment: null }

test('zotero: 本地 API 在线', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!(await reachable())) {
    return t.skip(`Zotero 本地 API 不可达（${BASE_URL}）。请启动 Zotero（7 及以上，含 9.x），并在 设置 → 高级 → 通用 勾选「允许本机上的其他应用程序与 Zotero 通信」。`)
  }
  state.tempDir = mkdtempSync(join(tmpdir(), 'dsh-zotero-smoke-'))
  // downloadDir 指向临时目录，冒烟测试不在用户工作区留文件
  state.ctx = harness({ baseUrl: BASE_URL, downloadDir: state.tempDir })
  t.diagnostic(`已连接 ${BASE_URL}，附件下载目录 ${state.tempDir}`)
})

test('zotero_recent: 最近添加的条目', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx) return t.skip('前置条件未满足：本地 API 不可达')
  const result = await state.ctx.tool('zotero_recent').execute({ limit: 10 })
  assert.ok(Array.isArray(result.items), 'items 是数组')
  assert.equal(result.count, result.items.length)
  for (const item of result.items) {
    assert.match(item.key, /^[A-Z0-9]{8}$/i)
    assert.ok(typeof item.title === 'string' && item.title.length > 0)
  }
  state.recent = result.items
  t.diagnostic(`最近条目 ${result.count} 条`)
})

test('zotero_item: 找一个带附件的条目', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || state.recent.length === 0) return t.skip('文献库为空，跳过附件相关断言')
  for (const item of state.recent) {
    const detail = await state.ctx.tool('zotero_item').execute({ key: item.key })
    assert.ok(detail.item.key === item.key)
    assert.ok(Array.isArray(detail.attachments))
    if (detail.attachments.length > 0) {
      state.withAttachment = { itemKey: item.key, attachments: detail.attachments }
      t.diagnostic(`条目 ${item.key}（${item.title}）有 ${detail.attachments.length} 个附件`)
      return
    }
  }
  t.diagnostic('最近 10 条均无附件，zotero_fulltext / zotero_download 将跳过')
})

test('zotero_search: 按标题片段检索', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || state.recent.length === 0) return t.skip('文献库为空，无法构造检索词')
  const words = state.recent[0].title.split(/\s+/).slice(0, 3).join(' ')
  const result = await state.ctx.tool('zotero_search').execute({ query: words, limit: 5, mode: 'minimal' })
  assert.ok(Array.isArray(result.items))
  assert.equal(result.count, result.items.length)
  for (const item of result.items) {
    assert.equal(item.abstractNote, undefined, 'minimal 模式不应返回摘要')
  }
  t.diagnostic(`检索 "${words}" 命中 ${result.count} 条`)
})

test('zotero_fulltext: 读全文（缓存优先，下载兜底）', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || !state.withAttachment) return t.skip('没有带附件的条目')
  const { itemKey } = state.withAttachment
  const result = await state.ctx.tool('zotero_fulltext').execute({ itemKey })
  assert.equal(result.itemKey, itemKey)
  if (result.mode === 'text') {
    assert.ok(typeof result.text === 'string' && result.text.length > 0)
    t.diagnostic(`命中全文缓存，${result.text.length} 字符${result.truncated ? '（已截断）' : ''}`)
  } else {
    assert.ok(result.mode === 'file')
    assert.ok(existsSync(result.path), `下载文件存在: ${result.path}`)
    assert.ok(result.size > 0)
    t.diagnostic(`无缓存，已下载 ${result.filename}（${result.size} 字节）`)
  }
})

test('zotero_attachment_path: 解析附件原始路径', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || !state.withAttachment) return t.skip('没有带附件的条目')
  const { itemKey, attachments } = state.withAttachment
  const target = attachments.find((a) => (a.contentType ?? '').includes('pdf')) ?? attachments[0]
  const result = await state.ctx.tool('zotero_attachment_path').execute({ itemKey, attachmentKey: target.key })
  assert.equal(result.attachmentKey, target.key)
  assert.ok(typeof result.path === 'string')
  t.diagnostic(
    result.exists
      ? `storage 路径可用: ${result.path}`
      : `路径未落地（exists=false${result.linked ? '，链接型附件' : ''}）: ${result.path}`,
  )
})

test('zotero_export: 单条 BibTeX 导出', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || state.recent.length === 0) return t.skip('文献库为空')
  const key = state.withAttachment?.itemKey ?? state.recent[0].key
  const result = await state.ctx.tool('zotero_export').execute({ keys: [key], format: 'bibtex' })
  assert.equal(result.format, 'bibtex')
  assert.equal(result.count, 1)
  assert.match(result.text, /@/, 'BibTeX 条目以 @ 开头')
  t.diagnostic(`导出 ${result.count} 条，${result.text.length} 字符`)
})

test('zotero_annotations: 读取 PDF 批注', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || !state.withAttachment) return t.skip('没有带附件的条目')
  const { itemKey } = state.withAttachment
  const result = await state.ctx.tool('zotero_annotations').execute({ itemKey })
  assert.ok(Array.isArray(result.annotations))
  assert.equal(result.count, result.annotations.length)
  for (const a of result.annotations) {
    assert.match(a.key, /^[A-Z0-9]{8}$/i)
    assert.ok(a.annotationType === undefined || typeof a.annotationType === 'string')
    assert.ok(a.page === undefined || (Number.isInteger(a.page) && a.page >= 1))
  }
  t.diagnostic(`批注 ${result.count} 条`)
})

test('zotero_browse: 标签与保存的搜索', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx) return t.skip('前置条件未满足')
  const tags = await state.ctx.tool('zotero_browse').execute({ type: 'tags', limit: 20 })
  assert.equal(tags.type, 'tags')
  assert.ok(Array.isArray(tags.tags))
  assert.equal(tags.count, tags.tags.length)
  const searches = await state.ctx.tool('zotero_browse').execute({ type: 'searches' })
  assert.equal(searches.type, 'searches')
  assert.ok(Array.isArray(searches.searches))
  t.diagnostic(`标签 ${tags.count} 个，保存的搜索 ${searches.count} 个`)
})

test('zotero_retrieve: 段落级检索', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || !state.withAttachment) return t.skip('没有带附件的条目')
  const { itemKey } = state.withAttachment
  const title = state.recent.find((i) => i.key === itemKey)?.title ?? ''
  const query = title.split(/\s+/).slice(0, 4).join(' ') || 'study'
  const result = await state.ctx.tool('zotero_retrieve').execute({ itemKey, query, topK: 5 })
  assert.equal(result.itemKey, itemKey)
  assert.ok(Array.isArray(result.passages))
  assert.ok(Array.isArray(result.sourcesUsed))
  assert.ok(result.passages.length <= 5)
  for (const p of result.passages) {
    assert.ok(['fulltext', 'notes', 'annotations'].includes(p.source), `来源合法: ${p.source}`)
    assert.ok(typeof p.score === 'number' && Number.isFinite(p.score))
  }
  if (result.passages.length > 0) {
    t.diagnostic(`query="${query}" 返回 ${result.count} 段（来源 ${result.sourcesUsed.join('、')}），首段相关度 ${result.passages[0].score}`)
  } else {
    t.diagnostic(`query="${query}" 无命中（该条目没有可检索的全文/笔记/批注）`)
  }
})

test('zotero_digest: 元数据+引用+段落一次打包', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || state.recent.length === 0) return t.skip('文献库为空')
  const key = state.withAttachment?.itemKey ?? state.recent[0].key
  const result = await state.ctx.tool('zotero_digest').execute({ itemKey: key, topK: 3 })
  assert.equal(result.item.key, key)
  assert.equal(result.citationFormat, 'bibtex')
  assert.ok(typeof result.citation === 'string')
  if (result.citation !== '') assert.match(result.citation, /@/, 'BibTeX 引用含 @')
  assert.ok(Array.isArray(result.attachments))
  assert.ok(Array.isArray(result.passages))
  assert.ok(result.passages.length <= 3)
  assert.ok(typeof result.query === 'string' && result.query.length > 0, 'query 缺省时从标题推导')
  t.diagnostic(`digest: ${result.passages.length} 段，附件 ${result.attachments.length} 个，citation ${result.citation.length} 字符`)
})

test('zotero_note: 笔记生命周期 create → notes → append → update → delete', { skip: ENABLED ? false : SKIP_REASON }, async (t) => {
  if (!state.ctx || state.recent.length === 0) return t.skip('文献库为空，无法测试笔记')
  const itemKey = state.withAttachment?.itemKey ?? state.recent[0].key
  const marker = `dsh-zotero-smoke-${Date.now()}`
  const noteTool = state.ctx.tool('zotero_note')
  const notesTool = state.ctx.tool('zotero_notes')
  const findNote = async () => {
    const listed = await notesTool.execute({ itemKey, limit: 50 })
    return listed.notes.find((n) => n.text.includes(marker))
  }

  let noteKey
  try {
    const created = await noteTool.execute({ action: 'create', itemKey, text: `${marker} 初稿` })
    noteKey = created.noteKey
    assert.match(noteKey, /^[A-Z0-9]{8}$/i)
    assert.equal(created.parentKey, itemKey)

    const listed = await findNote()
    assert.ok(listed, 'zotero_notes 能看到新笔记')
    assert.ok(listed.text.includes('初稿'), `笔记正文可读: ${listed.text.slice(0, 50)}`)

    await noteTool.execute({ action: 'append', noteKey, text: `${marker} 追加内容` })
    assert.ok((await findNote()).text.includes('追加内容'), 'append 后正文包含追加内容')
  } catch (error) {
    if (unsupported(error)) return t.skip(`本地 API 拒绝笔记写操作: ${error.message}`)
    throw error
  }

  try {
    await noteTool.execute({ action: 'update', noteKey, text: `${marker} 整体替换` })
    const updated = await findNote()
    assert.ok(updated.text.includes('整体替换'), 'update 后正文被整体替换')
    assert.ok(!updated.text.includes('追加内容'), '旧内容不复存在')
  } catch (error) {
    if (unsupported(error)) {
      t.diagnostic(`当前 Zotero 不支持 PATCH 更新笔记（delete 仍会尝试）: ${error.message}`)
    } else {
      throw error
    }
  } finally {
    try {
      await noteTool.execute({ action: 'delete', noteKey })
      const after = await findNote()
      assert.ok(!after, '笔记已删除，文献库无残留')
    } catch (error) {
      if (unsupported(error)) t.diagnostic(`当前 Zotero 不支持 DELETE 笔记，测试笔记 ${noteKey} 留在了条目 ${itemKey} 下，请手动删除`)
      else throw error
    }
  }
})

test('清理冒烟测试临时目录', { skip: ENABLED ? false : SKIP_REASON }, () => {
  if (state.tempDir) rmSync(state.tempDir, { recursive: true, force: true })
})
