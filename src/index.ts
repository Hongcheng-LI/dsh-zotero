import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveConfig, trimItems, ZoteroClient, ZoteroError } from './zotero-client.js'
import { attachmentStoragePath, readFulltextCache, readFulltextFile, resolveStorageDir } from './storage.js'
import { fileUrlToPath, writeAttachment } from './files.js'
import type {
  ResultMode,
  ZoteroAttachmentPathResult,
  ZoteroCollectionsResult,
  ZoteroConfig,
  ZoteroDownloadResult,
  ZoteroFulltextResult,
  ZoteroItemResult,
  ZoteroNoteAction,
  ZoteroNoteResult,
  ZoteroNotesResult,
  ZoteroRecentArgs,
  ZoteroSearchArgs,
  ZoteroSearchResult,
} from './types.js'

export const name = 'tool-zotero'
export const inject = ['tools']
export type Config = ZoteroConfig

const MAX_LIMIT = 100
const KEY_PATTERN = /^[A-Z0-9]{8}$/i
const SORT_HINT = 'dateAdded | dateModified | date | title | creator'
const MODE_HINT = 'minimal（只留定位字段）| preview（附 400 字摘要，默认）| full（含完整摘要）'

type TextBlock = { type: 'text'; text: string }
function oneText(text: string): TextBlock[] {
  return [{ type: 'text', text }]
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function requireKey(value: string | undefined, label: string): string {
  const key = (value ?? '').trim()
  if (!KEY_PATTERN.test(key)) throw new Error(`${label} 必须是 Zotero 的 8 位 key（用 zotero_search / zotero_notes 获取）`)
  return key
}

function parseMode(value: unknown): ResultMode {
  return value === 'minimal' || value === 'full' ? value : 'preview'
}

function describeItem(item: ZoteroItemResult['item'], index?: number): string {
  const parts = [item.itemType, item.date, item.publicationTitle].filter(Boolean).join(' | ')
  const prefix = index === undefined ? '' : `#${index} `
  return `${prefix}${item.title} [key=${item.key}${parts ? ' | ' + parts : ''}]`
}

function renderSearch(value: ZoteroSearchResult): TextBlock[] {
  if (value.items.length === 0) {
    return oneText(`检索完成，没有匹配的条目${value.totalResults !== undefined ? `（服务器匹配 ${value.totalResults} 条，均已按条件过滤）` : ''}。`)
  }
  const lines = value.items.map((item, i) => describeItem(item, i + 1))
  const total = value.totalResults !== undefined ? `，共匹配 ${value.totalResults} 条` : ''
  return oneText(
    `Zotero 检索结果（展示 ${value.items.length} 条${total}）：\n\n${lines.join('\n')}\n\n用 zotero_item 配合 key 查看条目详情和附件。`,
  )
}

function renderItem(value: ZoteroItemResult): TextBlock[] {
  const { item, attachments, childNotes } = value
  const fields = [
    ['类型', item.itemType],
    ['作者', item.creators],
    ['日期', item.date],
    ['出版物', item.publicationTitle],
    ['卷期页', [item.volume, item.issue, item.pages].filter(Boolean).join('/') || undefined],
    ['出版商', item.publisher],
    ['DOI', item.DOI],
    ['ISBN', item.ISBN],
    ['链接', item.url],
    ['标签', item.tags?.join(', ')],
    ['加入时间', item.dateAdded],
  ] as const
  const lines = fields.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
  let text = `条目 ${item.key}: ${item.title}\n${lines.join('\n')}`
  if (item.abstractNote) text += `\n\n摘要:\n${item.abstractNote}`
  if (attachments.length > 0) {
    text += '\n\n附件:\n' + attachments
      .map((a, i) => `#${i} [attachmentKey=${a.key}] ${a.title ?? a.filename ?? '(未命名)'} (${a.contentType ?? '未知类型'})`)
      .join('\n')
    text += '\n可用 zotero_fulltext 直接读全文，或 zotero_download 下载副本。'
  } else {
    text += '\n\n该条目没有附件。'
  }
  if (childNotes > 0) text += `\n另有 ${childNotes} 条子笔记（用 zotero_notes 查看）。`
  return oneText(text)
}

function renderCollections(value: ZoteroCollectionsResult): TextBlock[] {
  if (value.collections.length === 0) return oneText('文献库中没有任何分类。')
  const lines = value.collections.map(
    (c, i) => `#${i + 1} ${c.name} [collectionKey=${c.key}，${c.numberOfItems} 条]${c.parentCollection ? '（子分类）' : ''}`,
  )
  return oneText(`Zotero 分类（${value.collections.length} 个）：\n\n${lines.join('\n')}\n\n把 collectionKey 填进 zotero_search 的 collection 参数即可限定检索范围。`)
}

function renderDownload(value: ZoteroDownloadResult): TextBlock[] {
  return oneText(`已下载附件 "${value.filename}"（${value.contentType}，${value.size} 字节）到：\n${value.path}\n可用 read 工具读取该文件。`)
}

function renderNotes(value: ZoteroNotesResult): TextBlock[] {
  if (value.notes.length === 0) {
    return oneText('没有匹配的笔记。')
  }
  const lines = value.notes.map((n, i) => {
    const preview = n.text.length > 200 ? n.text.slice(0, 200) + '…' : n.text
    const parent = n.parentKey ? `，属于条目 ${n.parentKey}` : ''
    return `#${i + 1} [noteKey=${n.key}${parent}]\n${preview || '(空笔记)'}`
  })
  return oneText(`Zotero 笔记（${value.notes.length} 条）：\n\n${lines.join('\n\n')}\n\n用 zotero_note 配合 noteKey 可追加、更新或删除笔记。`)
}

function renderNote(value: ZoteroNoteResult): TextBlock[] {
  switch (value.action) {
    case 'create':
      return oneText(`已为条目 ${value.parentKey} 添加笔记（noteKey=${value.noteKey}）。`)
    case 'append':
      return oneText(`已把内容追加到笔记 ${value.noteKey} 末尾。`)
    case 'update':
      return oneText(`已更新笔记 ${value.noteKey} 的内容。`)
    case 'delete':
      return oneText(`已删除笔记 ${value.noteKey}。`)
  }
}

function renderFulltext(value: ZoteroFulltextResult): TextBlock[] {
  if (value.mode === 'file') {
    return oneText(`未命中 Zotero 全文缓存，附件本地文件路径：\n${value.path}\n（${value.filename}，${value.size} 字节）可用 read 工具直接读取。`)
  }
  const truncated = value.truncated ? `\n\n（正文超过上限已截断；需要完整内容可对附件用 zotero_attachment_path 拿路径后分段读取）` : ''
  return oneText(`条目 ${value.itemKey} 附件 ${value.attachmentKey}（${value.filename}）的全文：\n\n${value.text}${truncated}`)
}

function renderAttachmentPath(value: ZoteroAttachmentPathResult): TextBlock[] {
  if (value.exists) {
    return oneText(`附件 ${value.attachmentKey} 的本地原始路径：\n${value.path}\n可直接用 read 工具读取，无需下载副本。`)
  }
  if (value.linked) {
    return oneText(`附件 ${value.attachmentKey} 不在本机（记录的路径/URL 为 ${value.path}）。远程链接附件无法直接读取；存储在本机的附件请检查该路径是否可访问。`)
  }
  return oneText(`无法解析附件 ${value.attachmentKey} 的本地路径（storage 目录未找到或文件不在预期位置）。可在 cordis.patch.yml 配置 storageDir / dataDir，或改用 zotero_download。`)
}

export function apply(ctx: any, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const client = new ZoteroClient(resolved)
  const storageDir = resolveStorageDir({ dataDir: resolved.dataDir, storageDir: resolved.storageDir })

  // Load-time nudge only: never break boot, tools report the details instead.
  void client.ping().catch((error: unknown) => {
    ctx.logger?.warn?.('[dsh-zotero] ' + messageOf(error, 'Zotero 本地 API 不可用'))
  })
  if (storageDir === null) {
    ctx.logger?.info?.('[dsh-zotero] 未找到 Zotero storage 目录，zotero_fulltext 将退化为下载附件；可在 cordis.patch.yml 配置 storageDir/dataDir')
  }

  ctx.tools.register({
    name: 'zotero_collections',
    description:
      'List the collections (folders) of the Zotero library, with their keys and item counts. Use a returned collectionKey as the collection argument of zotero_search to scope a search. Requires Zotero 7+ (tested on 9.x) running locally with "Allow other applications on this computer" enabled.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: { type: 'object', properties: { collections: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      render: (_args: unknown, value: unknown) => renderCollections(value as ZoteroCollectionsResult),
    },
    async execute() {
      return { collections: await client.collections() }
    },
  })

  ctx.tools.register({
    name: 'zotero_search',
    description:
      'Search the local Zotero library by keyword (title/creator/year, Zotero quick-search), with filters for item type, collection, tag and publication year range, plus sorting and pagination. Control payload size with mode. Returns compact rows with item keys; use zotero_item with a key for full metadata and attachments.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Quick-search keyword (title, creator, year...); omit to list items (with filters applied)' },
        itemType: { type: 'string', description: 'Zotero item type filter, e.g. "journalArticle", "book"' },
        collection: { type: 'string', description: 'collectionKey from zotero_collections to restrict the search' },
        tag: { type: 'string', description: 'Only items carrying this tag' },
        sinceYear: { type: 'integer', description: 'Only items published in this year or later' },
        beforeYear: { type: 'integer', description: 'Only items published in this year or earlier' },
        sort: { type: 'string', description: `Sort field: ${SORT_HINT}. Defaults to relevance when query is given` },
        direction: { type: 'string', description: 'Sort direction: asc | desc' },
        offset: { type: 'integer', description: 'Skip this many results first, default 0' },
        limit: { type: 'integer', description: 'Max rows to return, 1-100, default 20' },
        mode: { type: 'string', description: `Result verbosity: ${MODE_HINT}` },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          totalResults: { type: 'integer' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args: unknown, value: unknown) => renderSearch(value as ZoteroSearchResult),
    },
    async execute(rawArgs: unknown) {
      const args = rawArgs as ZoteroSearchArgs
      const limit = clampInt(args.limit, 20, 1, Math.min(resolved.maxLimit, MAX_LIMIT))
      const offset = clampInt(args.offset, 0, 0, 10000)
      const { items, totalResults } = await client.search({
        query: args.query,
        itemType: args.itemType,
        collection: args.collection,
        tag: args.tag,
        sinceYear: args.sinceYear,
        beforeYear: args.beforeYear,
        sort: args.sort,
        direction: args.direction,
        start: offset,
        limit,
      })
      return { count: items.length, totalResults, items: trimItems(items, parseMode(args.mode)) }
    },
  })

  ctx.tools.register({
    name: 'zotero_recent',
    description:
      'List the most recently ADDED items of the Zotero library (newest first, attachments and notes excluded). Use it for "what did I just import" questions; use zotero_item with a key for details.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max rows to return, 1-100, default 10' },
        mode: { type: 'string', description: `Result verbosity: ${MODE_HINT}` },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const result = value as { count: number; items: ZoteroItemResult['item'][] }
        if (result.items.length === 0) return oneText('文献库是空的。')
        const lines = result.items.map((item, i) => describeItem(item, i + 1))
        return oneText(`最近添加的条目（${result.items.length} 条）：\n\n${lines.join('\n')}\n\n用 zotero_item 配合 key 查看详情。`)
      },
    },
    async execute(rawArgs: unknown) {
      const args = rawArgs as ZoteroRecentArgs
      const limit = clampInt(args.limit, 10, 1, Math.min(resolved.maxLimit, MAX_LIMIT))
      const { items } = await client.recent(limit)
      const trimmed = trimItems(items, parseMode(args.mode))
      return { count: trimmed.length, items: trimmed }
    },
  })

  ctx.tools.register({
    name: 'zotero_item',
    description:
      'Read one Zotero item in full by its key (from zotero_search): authors, publication venue, DOI, abstract and tags, plus its child attachments (PDF keys) and note count.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Item key, 8 chars, from zotero_search or zotero_recent' },
      },
      required: ['key'],
    },
    output: {
      schema: { type: 'object', properties: { item: { type: 'object', additionalProperties: true } } },
      render: (_args: unknown, value: unknown) => renderItem(value as ZoteroItemResult),
    },
    async execute(rawArgs: unknown) {
      const args = rawArgs as { key?: string }
      const key = requireKey(args.key, 'key')
      return await client.item(key)
    },
  })

  ctx.tools.register({
    name: 'zotero_fulltext',
    description:
      'Read the full text of a Zotero item (its PDF or other main attachment) as plain text — from Zotero\'s own fulltext cache when available, otherwise the attachment is downloaded into the session workspace and its path returned. Prefer this over zotero_download when you only need the text.',
    parameters: {
      type: 'object',
      properties: {
        itemKey: { type: 'string', description: 'Item key (from zotero_search)' },
        attachmentKey: { type: 'string', description: 'Specific attachment key (from zotero_item); default picks the first PDF' },
      },
      required: ['itemKey'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          itemKey: { type: 'string' },
          attachmentKey: { type: 'string' },
          filename: { type: 'string' },
          mode: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          path: { type: 'string' },
          size: { type: 'integer' },
        },
      },
      render: (_args: unknown, value: unknown) => renderFulltext(value as ZoteroFulltextResult),
    },
    async execute(rawArgs: unknown, exec: any) {
      const args = rawArgs as { itemKey?: string; attachmentKey?: string }
      const itemKey = requireKey(args.itemKey, 'itemKey')
      const { attachments } = await client.item(itemKey)
      if (attachments.length === 0) throw new Error(`条目 ${itemKey} 没有附件，无法读取全文。`)
      const target = args.attachmentKey
        ? attachments.find((a) => a.key === args.attachmentKey!.trim())
        : attachments.find((a) => (a.contentType ?? '').includes('pdf')) ??
          attachments.find((a) => a.path?.startsWith('storage:')) ??
          attachments[0]
      if (!target) throw new Error(`附件 ${args.attachmentKey} 不属于条目 ${itemKey}。请用 zotero_item 查看附件列表。`)

      const cacheHit = async (cache: string | null): Promise<ZoteroFulltextResult | null> => {
        if (!cache) return null
        const truncated = cache.length > resolved.maxFulltextChars
        return {
          itemKey,
          attachmentKey: target!.key,
          filename: target!.filename ?? target!.title ?? '(未知)',
          mode: 'text' as const,
          text: truncated ? cache.slice(0, resolved.maxFulltextChars) : cache,
          truncated,
        }
      }

      // 首选：/file 端点 302 的 Location 就是附件本地路径，.zotero-ft-cache 与其同目录
      const location = await client.attachmentFilePath(target.key).catch(() => null)
      if (location?.startsWith('file:')) {
        const filePath = fileUrlToPath(location)
        const fromCache = await cacheHit(await readFulltextFile(join(dirname(filePath), '.zotero-ft-cache')))
        if (fromCache) return fromCache
        if (existsSync(filePath)) {
          const { size } = await stat(filePath)
          return {
            itemKey,
            attachmentKey: target.key,
            filename: basename(filePath),
            mode: 'file' as const,
            path: filePath,
            size,
          }
        }
      }
      // 次选：storage 目录探测（dataDir/storageDir 配置）
      if (storageDir) {
        const fromCache = await cacheHit(await readFulltextCache(storageDir, target.key))
        if (fromCache) return fromCache
      }
      // 兜底：下载附件副本到工作区（远程链接附件等场景）
      const { bytes, contentType, filename } = await client.downloadAttachment(target.key)
      const cwd = typeof exec?.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : undefined
      const path = await writeAttachment(filename, bytes, resolved.downloadDir, cwd)
      return { itemKey, attachmentKey: target.key, filename, contentType, mode: 'file' as const, size: bytes.byteLength, path }
    },
  })

  ctx.tools.register({
    name: 'zotero_download',
    description:
      'Download one attachment (typically a PDF) of a Zotero item to the local filesystem — by default into the session workspace so the model can read it. Use the attachmentKey values listed by zotero_item. If you only need the text, prefer zotero_fulltext. Size is capped by maxAttachmentBytes.',
    parameters: {
      type: 'object',
      properties: {
        itemKey: { type: 'string', description: 'Parent item key (from zotero_search)' },
        attachmentKey: { type: 'string', description: 'Attachment key (from zotero_item attachment list)' },
      },
      required: ['itemKey', 'attachmentKey'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          filename: { type: 'string' },
          contentType: { type: 'string' },
          size: { type: 'integer' },
          path: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => renderDownload(value as ZoteroDownloadResult),
    },
    async execute(rawArgs: unknown, exec: any) {
      const args = rawArgs as { itemKey?: string; attachmentKey?: string }
      const itemKey = requireKey(args.itemKey, 'itemKey')
      const attachmentKey = requireKey(args.attachmentKey, 'attachmentKey')
      await client.attachmentInfo(itemKey, attachmentKey)
      const { bytes, contentType, filename } = await client.downloadAttachment(attachmentKey)
      const cwd = typeof exec?.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : undefined
      const path = await writeAttachment(filename, bytes, resolved.downloadDir, cwd)
      return { key: attachmentKey, filename, contentType, size: bytes.byteLength, path }
    },
  })

  ctx.tools.register({
    name: 'zotero_attachment_path',
    description:
      'Resolve the on-disk path of a stored attachment (zero-copy): returns the absolute path inside Zotero storage so the model can read the original file directly. Works for stored attachments; linked attachments report their recorded path.',
    parameters: {
      type: 'object',
      properties: {
        itemKey: { type: 'string', description: 'Parent item key (from zotero_search)' },
        attachmentKey: { type: 'string', description: 'Attachment key (from zotero_item attachment list)' },
      },
      required: ['itemKey', 'attachmentKey'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          itemKey: { type: 'string' },
          attachmentKey: { type: 'string' },
          path: { type: 'string' },
          exists: { type: 'boolean' },
          linked: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: unknown) => renderAttachmentPath(value as ZoteroAttachmentPathResult),
    },
    async execute(rawArgs: unknown) {
      const args = rawArgs as { itemKey?: string; attachmentKey?: string }
      const itemKey = requireKey(args.itemKey, 'itemKey')
      const attachmentKey = requireKey(args.attachmentKey, 'attachmentKey')
      const target = await client.attachmentInfo(itemKey, attachmentKey)
      const location = await client.attachmentFilePath(attachmentKey).catch(() => null)
      if (location?.startsWith('file:')) {
        const resolvedPath = fileUrlToPath(location)
        return { itemKey, attachmentKey, path: resolvedPath, exists: existsSync(resolvedPath) }
      }
      if (location?.startsWith('http')) {
        return { itemKey, attachmentKey, path: location, exists: false, linked: true }
      }
      if (storageDir) {
        const resolvedPath = attachmentStoragePath(storageDir, attachmentKey, target.path)
        if (resolvedPath) {
          return { itemKey, attachmentKey, path: resolvedPath, exists: existsSync(resolvedPath) }
        }
      }
      if (target.path?.startsWith('attachments:')) {
        return { itemKey, attachmentKey, path: target.path, exists: false, linked: true }
      }
      return { itemKey, attachmentKey, path: target.path ?? '', exists: false }
    },
  })

  ctx.tools.register({
    name: 'zotero_notes',
    description:
      'List or search the notes of the Zotero library: with itemKey, the child notes of that item; otherwise a library-wide keyword search over note text (newest first). Returns noteKeys for zotero_note (append/update/delete).',
    parameters: {
      type: 'object',
      properties: {
        itemKey: { type: 'string', description: 'Item key: list only this item\'s child notes' },
        query: { type: 'string', description: 'Keyword to search in note text (library-wide; omit with itemKey omitted to list recent notes)' },
        limit: { type: 'integer', description: 'Max notes to return, 1-50, default 10' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args: unknown, value: unknown) => renderNotes(value as ZoteroNotesResult),
    },
    async execute(rawArgs: unknown) {
      const args = rawArgs as { itemKey?: string; query?: string; limit?: number }
      const limit = clampInt(args.limit, 10, 1, Math.min(resolved.maxLimit, MAX_LIMIT))
      const itemKey = args.itemKey && args.itemKey.trim() !== '' ? requireKey(args.itemKey, 'itemKey') : undefined
      const notes = await client.listNotes({ itemKey, query: args.query, limit })
      return { count: notes.length, notes }
    },
  })

  ctx.tools.register({
    name: 'zotero_note',
    description:
      'Write notes to Zotero: create a child note under an item, or append to / update / delete an existing note (noteKeys from zotero_notes). Only write notes the user asked for; never invent content.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'create (default) | append | update | delete' },
        itemKey: { type: 'string', description: 'Parent item key, required for create (from zotero_search)' },
        noteKey: { type: 'string', description: 'Note key, required for append/update/delete (from zotero_notes)' },
        text: { type: 'string', description: 'Note body; HTML tags allowed. Required for create/append/update' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (create/update)' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { action: { type: 'string' }, parentKey: { type: 'string' }, noteKey: { type: 'string' } },
      },
      render: (_args: unknown, value: unknown) => renderNote(value as ZoteroNoteResult),
    },
    async execute(rawArgs: unknown) {
      const args = rawArgs as { action?: string; itemKey?: string; noteKey?: string; text?: string; tags?: string[] }
      const action = (args.action ?? 'create') as ZoteroNoteAction
      if (!(['create', 'append', 'update', 'delete'] as const).includes(action)) {
        throw new Error(`action 只能是 create | append | update | delete（收到 "${args.action}"）`)
      }
      const text = (args.text ?? '').trim()
      const tags = Array.isArray(args.tags) ? args.tags : undefined
      if (action === 'create') {
        const itemKey = requireKey(args.itemKey, 'itemKey')
        if (text === '') throw new Error('text 不能为空')
        const noteKey = await client.addNote(itemKey, text, tags)
        return { action, parentKey: itemKey, noteKey }
      }
      const noteKey = requireKey(args.noteKey, 'noteKey')
      if (action === 'delete') {
        await client.deleteNote(noteKey)
        return { action, noteKey }
      }
      if (text === '') throw new Error(`action=${action} 时 text 不能为空`)
      if (action === 'append') await client.appendNote(noteKey, text)
      else await client.updateNote(noteKey, text, tags)
      return { action, noteKey }
    },
  })

  // Keep ZoteroError referenced so the error type survives bundling.
  void ZoteroError
}
