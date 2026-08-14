import { readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { basename } from 'node:path'
import { fileUrlToPath } from './files.js'
import type {
  ZoteroAttachment,
  ZoteroCollection,
  ZoteroConfig,
  ZoteroCreator,
  ZoteroItem,
  ZoteroNote,
  ResultMode,
} from './types.js'
import { noteToText } from './notes.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:23119'
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_LIMIT = 50
const DEFAULT_MAX_FULLTEXT_CHARS = 80000

export type ResolvedConfig = {
  baseUrl: string
  libraryPath: string
  downloadDir: string | undefined
  maxAttachmentBytes: number
  maxLimit: number
  timeoutMs: number
  dataDir: string | undefined
  storageDir: string | undefined
  maxFulltextChars: number
}

export function resolveConfig(config: ZoteroConfig = {}): ResolvedConfig {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const library = config.library && config.library.trim() !== '' ? config.library.trim() : 'user'
  if (library !== 'user' && !/^group:\d+$/.test(library)) {
    throw new Error('library 只能是 "user" 或 "group:<数字ID>"')
  }
  return {
    baseUrl,
    libraryPath: library === 'user' ? 'users/0' : `groups/${library.slice('group:'.length)}`,
    downloadDir: config.downloadDir && config.downloadDir.trim() !== '' ? config.downloadDir.trim() : undefined,
    maxAttachmentBytes: positiveInt(config.maxAttachmentBytes, DEFAULT_MAX_BYTES),
    maxLimit: positiveInt(config.maxLimit, DEFAULT_MAX_LIMIT),
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    dataDir: config.dataDir && config.dataDir.trim() !== '' ? config.dataDir.trim() : undefined,
    storageDir: config.storageDir && config.storageDir.trim() !== '' ? config.storageDir.trim() : undefined,
    maxFulltextChars: positiveInt(config.maxFulltextChars, DEFAULT_MAX_FULLTEXT_CHARS),
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 手工拼 query，空格用 %20（URLSearchParams 会编成 +，Zotero 本地端点不认） */
function qs(entries: Array<[string, string]>): string {
  return entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

export class ZoteroError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
  }
}

type RawItem = {
  key: string
  version?: number
  data: Record<string, unknown>
  meta?: Record<string, unknown>
  library?: Record<string, unknown>
}

export class ZoteroClient {
  constructor(private readonly cfg: ResolvedConfig) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.cfg.baseUrl}/api/${this.cfg.libraryPath}${path}`
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: { 'Zotero-Allowed-Request': 'true', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      })
    } catch (error) {
      throw new ZoteroError(
        `无法连接 Zotero 本地 API（${this.cfg.baseUrl}）。请确认 Zotero（7 及以上，含 9.x）已启动，且已在 设置 → 高级 → 通用 中勾选「允许本机上的其他应用程序与 Zotero 通信」。`,
        error,
      )
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      if (response.status === 400 && body.includes('Endpoint does not support method')) {
        throw new ZoteroError(
          '当前 Zotero 本地 API 为只读，不支持该写操作（POST/PATCH/DELETE 未开放）：笔记的创建/修改/删除不可用，读取不受影响。',
        )
      }
      const hint = response.status === 405 || response.status === 501 ? '（当前 Zotero 版本可能不支持该写操作）' : ''
      throw new ZoteroError(`Zotero API ${response.status} ${response.statusText}${hint}${body ? '：' + body.slice(0, 300) : ''}`)
    }
    return response
  }

  /**
   * 查询附件的本地文件地址。Zotero 本地 API 的 /file 端点返回 302，
   * Location 指向 file:///... （storage 内文件或链接附件的绝对路径），
   * 链接到网页的附件则是 http(s) 地址。不重定向（未来直接流式返回）时返回 null。
   * 用 node:http 手动请求：undici 的 fetch 会拒绝跟随非 HTTP(S) 的重定向。
   */
  async attachmentFilePath(attachmentKey: string): Promise<string | null> {
    const url = new URL(
      `${this.cfg.baseUrl}/api/${this.cfg.libraryPath}/items/${encodeURIComponent(attachmentKey)}/file`,
    )
    return await new Promise<string | null>((resolvePromise, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'GET',
          headers: { 'Zotero-Allowed-Request': 'true' },
        },
        (res) => {
          res.resume()
          const location = res.headers.location
          resolvePromise(typeof location === 'string' && location !== '' ? location : null)
        },
      )
      req.setTimeout(this.cfg.timeoutMs, () => {
        req.destroy(new ZoteroError(`获取附件路径超时（${this.cfg.baseUrl}）`))
      })
      req.on('error', (error) => {
        reject(
          error instanceof ZoteroError
            ? error
            : new ZoteroError(
                `无法连接 Zotero 本地 API（${this.cfg.baseUrl}）。请确认 Zotero（7 及以上，含 9.x）已启动，且已在 设置 → 高级 → 通用 中勾选「允许本机上的其他应用程序与 Zotero 通信」。`,
                error,
              ),
        )
      })
      req.end()
    })
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path, { headers: { Accept: 'application/json' } })
    return (await response.json()) as T
  }

  /** 探测连接与库可用性，返回库内条目总数 */
  async ping(): Promise<number> {
    const response = await this.request('/items?limit=1&format=json')
    const total = response.headers.get('Total-Results')
    await response.body?.cancel().catch(() => {})
    return total ? Number(total) : -1
  }

  async search(args: {
    query?: string
    itemType?: string
    collection?: string
    tag?: string
    limit: number
    sinceYear?: number
    beforeYear?: number
    sort?: string
    direction?: string
    start?: number
  }): Promise<{ items: ZoteroItem[]; totalResults?: number }> {
    const params: Array<[string, string]> = [
      ['limit', String(args.limit)],
      ['format', 'json'],
    ]
    if (args.query && args.query.trim() !== '') params.push(['q', args.query.trim()])
    if (args.itemType && args.itemType.trim() !== '') params.push(['itemType', args.itemType.trim()])
    if (args.tag && args.tag.trim() !== '') params.push(['tag', args.tag.trim()])
    if (args.sort && args.sort.trim() !== '') params.push(['sort', args.sort.trim()])
    if (args.direction && args.direction.trim() !== '') params.push(['direction', args.direction.trim()])
    if (args.start && args.start > 0) params.push(['start', String(args.start)])
    const base = args.collection && args.collection.trim() !== ''
      ? `/collections/${encodeURIComponent(args.collection.trim())}/items`
      : '/items'
    const response = await this.request(`${base}?${qs(params)}`, { headers: { Accept: 'application/json' } })
    const totalResults = Number(response.headers.get('Total-Results')) || undefined
    const raw = (await response.json()) as RawItem[]
    // 用户没有显式检索附件/笔记时才自动排除这两类
    const requestedTypes = (args.itemType ?? '').toLowerCase()
    const autoExclude = !requestedTypes.includes('attachment') && !requestedTypes.includes('note')
    let items = raw
      .filter((row) => !autoExclude || (row.data?.itemType !== 'attachment' && row.data?.itemType !== 'note'))
      .map(slimItem)
    const since = args.sinceYear
    const before = args.beforeYear
    if (since !== undefined || before !== undefined) {
      items = items.filter((item) => {
        const year = extractYear(item.date)
        if (year === undefined) return false
        if (since !== undefined && year < since) return false
        if (before !== undefined && year > before) return false
        return true
      })
    }
    return { items, totalResults }
  }

  /** 最近添加的条目（不含附件和笔记） */
  async recent(limit: number): Promise<{ items: ZoteroItem[] }> {
    const params = qs([
      ['sort', 'dateAdded'],
      ['direction', 'desc'],
      ['limit', String(limit)],
      ['format', 'json'],
      ['itemType', '-attachment -note'],
    ])
    const raw = await this.getJson<RawItem[]>(`/items?${params}`)
    return { items: raw.map(slimItem) }
  }

  async item(key: string): Promise<{ item: ZoteroItem; attachments: ZoteroAttachment[]; childNotes: number }> {
    const raw = await this.getJson<RawItem>(`/items/${encodeURIComponent(key)}`)
    if (!raw?.data) throw new ZoteroError(`条目 ${key} 不存在`)
    const { attachments, notes } = await this.children(key)
    return { item: slimItem(raw), attachments, childNotes: notes.length }
  }

  private async children(key: string): Promise<{ attachments: ZoteroAttachment[]; notes: ZoteroNote[] }> {
    // 不带 limit 时 Zotero 默认只回 25 条，子笔记/附件多的条目会被截断
    const raw = await this.getJson<RawItem[]>(`/items/${encodeURIComponent(key)}/children?${qs([['format', 'json'], ['limit', '100']])}`)
    const attachments: ZoteroAttachment[] = []
    const notes: ZoteroNote[] = []
    for (const child of raw) {
      const data = child.data ?? {}
      if (data.itemType === 'attachment') {
        attachments.push({
          key: child.key,
          itemType: String(data.itemType),
          title: str(data.title),
          contentType: str(data.contentType),
          path: str(data.path),
          filename: (str(data.path) ?? '').replace(/^storage:/, '').replace(/^attachments:/, '') || undefined,
        })
      } else if (data.itemType === 'note') {
        notes.push(this.toNote(child, key))
      }
    }
    return { attachments, notes }
  }

  private toNote(raw: RawItem, fallbackParent?: string): ZoteroNote {
    const data = raw.data ?? {}
    return {
      key: raw.key,
      parentKey: str(data.parentItem) ?? fallbackParent,
      text: noteToText(typeof data.note === 'string' ? data.note : ''),
      tags: Array.isArray(data.tags)
        ? (data.tags as Array<{ tag?: string }>).map((t) => t.tag ?? '').filter(Boolean)
        : undefined,
      dateAdded: str(data.dateAdded),
    }
  }

  /** 笔记检索：给了 itemKey 列其子笔记；否则全库按关键词搜笔记 */
  async listNotes(args: { itemKey?: string; query?: string; limit: number }): Promise<ZoteroNote[]> {
    if (args.itemKey && args.itemKey.trim() !== '') {
      const { notes } = await this.children(args.itemKey.trim())
      const keyword = args.query?.trim()
      const filtered = keyword ? notes.filter((n) => n.text.includes(keyword)) : notes
      return filtered.slice(0, args.limit)
    }
    const params: Array<[string, string]> = [
      ['itemType', 'note'],
      ['format', 'json'],
      ['limit', String(args.limit)],
      ['sort', 'dateModified'],
      ['direction', 'desc'],
    ]
    if (args.query && args.query.trim() !== '') params.push(['q', args.query.trim()])
    const raw = await this.getJson<RawItem[]>(`/items?${qs(params)}`)
    return raw.map((row) => this.toNote(row))
  }

  async addNote(parentKey: string, text: string, tags?: string[]): Promise<string> {
    const created = await this.postNote([
      { itemType: 'note', parentItem: parentKey, note: text, tags: (tags ?? []).map((t) => ({ tag: t })) },
    ])
    return created
  }

  /** 在现有笔记末尾追加内容 */
  async appendNote(noteKey: string, text: string): Promise<void> {
    const head = await this.noteHead(noteKey)
    const existing = typeof head.data.note === 'string' ? head.data.note.trim() : ''
    const merged = existing === '' ? text : `${existing}\n\n${text}`
    await this.patchNote(noteKey, head.version, { note: merged })
  }

  /** 整体替换笔记正文（可顺带更新标签） */
  async updateNote(noteKey: string, text: string, tags?: string[]): Promise<void> {
    const head = await this.noteHead(noteKey)
    const patch: { note: string; tags?: Array<{ tag: string }> } = { note: text }
    if (tags !== undefined) patch.tags = tags.map((t) => ({ tag: t }))
    await this.patchNote(noteKey, head.version, patch)
  }

  async deleteNote(noteKey: string): Promise<void> {
    const head = await this.noteHead(noteKey)
    await this.request(`/items/${encodeURIComponent(noteKey)}`, {
      method: 'DELETE',
      headers: { 'If-Unmodified-Since-Version': String(head.version) },
    })
  }

  private async noteHead(noteKey: string): Promise<RawItem> {
    const head = await this.getJson<RawItem>(`/items/${encodeURIComponent(noteKey)}`)
    if (head?.data?.itemType !== 'note') throw new ZoteroError(`${noteKey} 不是笔记条目（用 zotero_notes 获取笔记 key）`)
    if (typeof head.version !== 'number' || head.version < 0) {
      throw new ZoteroError(`无法获取笔记 ${noteKey} 的版本号`)
    }
    return head
  }

  private async patchNote(noteKey: string, version: number | undefined, patch: Record<string, unknown>): Promise<void> {
    const body: Record<string, unknown> = { itemType: 'note', ...patch }
    await this.request(`/items/${encodeURIComponent(noteKey)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Unmodified-Since-Version': String(version ?? 0),
      },
      body: JSON.stringify(body),
    })
  }

  private async postNote(items: Array<Record<string, unknown>>): Promise<string> {
    const response = await this.request(`/items?${qs([['format', 'json']])}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    })
    const created = (await response.json()) as { success?: Record<string, string> }
    const key = created?.success?.['0']
    if (!key) throw new ZoteroError('Zotero 返回成功但未包含新笔记的 key')
    return key
  }

  async collections(): Promise<ZoteroCollection[]> {
    const raw = await this.getJson<Array<{ key: string; data: Record<string, unknown>; meta?: Record<string, unknown> }>>(
      `/collections?${qs([['format', 'json'], ['limit', '100']])}`,
    )
    return raw.map((row) => ({
      key: row.key,
      name: str(row.data?.name) ?? '(未命名)',
      parentCollection: row.data?.parentCollection === undefined ? false : str(row.data?.parentCollection),
      numberOfItems: Number(row.meta?.numItems ?? row.meta?.numberOfItems) || 0,
    }))
  }

  async attachmentInfo(itemKey: string, attachmentKey: string): Promise<ZoteroAttachment> {
    const { attachments } = await this.children(itemKey)
    const found = attachments.find((a) => a.key === attachmentKey)
    if (!found) {
      throw new ZoteroError(
        `附件 ${attachmentKey} 不属于条目 ${itemKey}。请先用 zotero_item 查看该条目的附件列表。`,
      )
    }
    return found
  }

  async downloadAttachment(attachmentKey: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string; path?: string }> {
    const head = await this.getJson<RawItem>(`/items/${encodeURIComponent(attachmentKey)}`)
    const data = head?.data ?? {}
    const contentType = str(data.contentType) ?? 'application/octet-stream'
    const metaFilename =
      str(data.filename) ??
      (str(data.path) ?? '').replace(/^(storage|attachments):/, '') ??
      `${attachmentKey}.bin`

    // 首选：302 Location 指向的本地文件，直接从磁盘读（零 HTTP 传输）
    const location = await this.attachmentFilePath(attachmentKey).catch(() => null)
    if (location?.startsWith('file:')) {
      const path = fileUrlToPath(location)
      const info = await stat(path).catch(() => null)
      if (info?.isFile()) {
        if (info.size > this.cfg.maxAttachmentBytes) {
          throw new ZoteroError(`附件 ${basename(path)} 有 ${info.size} 字节，超过上限 ${this.cfg.maxAttachmentBytes} 字节（maxAttachmentBytes）。`)
        }
        const bytes = new Uint8Array(await readFile(path))
        return { bytes, contentType, filename: basename(path) || metaFilename, path }
      }
    }
    // 次选：Location 指向 http(s)（链接到网页的附件），直接下载
    if (location?.startsWith('http')) {
      const response = await fetch(location, { signal: AbortSignal.timeout(this.cfg.timeoutMs) })
      if (!response.ok) throw new ZoteroError(`下载附件失败：HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > this.cfg.maxAttachmentBytes) {
        throw new ZoteroError(`附件有 ${bytes.byteLength} 字节，超过上限 ${this.cfg.maxAttachmentBytes} 字节（maxAttachmentBytes）。`)
      }
      return { bytes, contentType, filename: metaFilename }
    }
    // 兜底：服务器未重定向、直接流式返回文件内容的场景
    try {
      const response = await this.request(`/items/${encodeURIComponent(attachmentKey)}/file`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > this.cfg.maxAttachmentBytes) {
        throw new ZoteroError(`附件有 ${bytes.byteLength} 字节，超过上限 ${this.cfg.maxAttachmentBytes} 字节（maxAttachmentBytes）。`)
      }
      if (bytes.byteLength > 0) return { bytes, contentType, filename: metaFilename }
    } catch (error) {
      // 大小超限等明确错误不能被兜底分支吞掉
      if (error instanceof ZoteroError) throw error
    }
    throw new ZoteroError(
      `无法获取附件 ${metaFilename} 的内容：可能是链接型附件且目标文件不在本机，或文件尚未同步到本地。`,
    )
  }
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed !== '' ? trimmed : undefined
}

function extractYear(date: string | undefined): number | undefined {
  if (!date) return undefined
  const match = /\d{4}/.exec(date)
  return match ? Number(match[0]) : undefined
}

/** 把 Zotero 原始条目压缩成模型友好的精简结构 */
export function slimItem(raw: RawItem): ZoteroItem {
  const data = raw.data ?? {}
  const creators = Array.isArray(data.creators)
    ? (data.creators as ZoteroCreator[])
        .map((c) => c.name ?? [c.lastName, c.firstName].filter(Boolean).join(', '))
        .filter(Boolean)
        .join('; ')
    : undefined
  const tags = Array.isArray(data.tags)
    ? (data.tags as Array<{ tag?: string }>).map((t) => t.tag ?? '').filter(Boolean)
    : undefined
  return {
    key: raw.key,
    itemType: str(data.itemType) ?? 'unknown',
    title: str(data.title) ?? str(data.name) ?? '(无标题)',
    creators: creators || undefined,
    date: str(data.date),
    publicationTitle: str(data.publicationTitle),
    volume: str(data.volume),
    issue: str(data.issue),
    pages: str(data.pages),
    publisher: str(data.publisher),
    DOI: str(data.DOI),
    ISBN: str(data.ISBN),
    url: str(data.url),
    abstractNote: str(data.abstractNote),
    tags: tags && tags.length > 0 ? tags : undefined,
    collections: Array.isArray(data.collections) ? (data.collections as string[]) : undefined,
    dateAdded: str(data.dateAdded),
  }
}

const MINIMAL_FIELDS = ['key', 'itemType', 'title', 'creators', 'date', 'publicationTitle', 'DOI'] as const
const PREVIEW_FIELDS = [...MINIMAL_FIELDS, 'url', 'tags'] as const

/** 按粒度裁剪检索结果：minimal 只留定位字段；preview 附 400 字截断摘要；full 不动 */
export function trimItems(items: ZoteroItem[], mode: ResultMode): ZoteroItem[] {
  if (mode === 'full') return items
  const fields = mode === 'minimal' ? MINIMAL_FIELDS : PREVIEW_FIELDS
  return items.map((item) => {
    const trimmed: ZoteroItem = { ...pick(item, fields) }
    if (mode === 'preview' && item.abstractNote) {
      trimmed.abstractNote =
        item.abstractNote.length > 400 ? item.abstractNote.slice(0, 400) + '…' : item.abstractNote
    }
    return trimmed
  })
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}
