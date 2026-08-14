export type ZoteroConfig = {
  /** Zotero 本地 API 基地址，默认 http://127.0.0.1:23119 */
  baseUrl?: string
  /** 文献库：`user`（本地库，默认）或 `group:<id>` */
  library?: string
  /** 附件下载目录；缺省下载到会话工作区（由工具调用的 cwd 决定） */
  downloadDir?: string
  /** 单个附件最大下载字节数，默认 64MB */
  maxAttachmentBytes?: number
  /** 工具返回的最大条目数上限，默认 50 */
  maxLimit?: number
  /** 本地 API 请求超时（毫秒），默认 15000 */
  timeoutMs?: number
  /** Zotero 数据目录（含 profiles.ini）；默认自动探测，也可用环境变量 ZOTERO_DATA_DIR */
  dataDir?: string
  /** storage 目录（含各附件的 <attachmentKey> 子目录）；默认从数据目录推导 */
  storageDir?: string
  /** zotero_fulltext 返回的最大字符数，默认 80000 */
  maxFulltextChars?: number
}

/** 检索结果粒度：minimal 只留定位字段，preview 附截断摘要，full 全量 */
export type ResultMode = 'minimal' | 'preview' | 'full'

export type ZoteroCreator = { creatorType?: string; firstName?: string; lastName?: string; name?: string }

/** 精简后的文献条目，返回给模型 */
export type ZoteroItem = {
  key: string
  itemType: string
  title: string
  creators?: string
  date?: string
  publicationTitle?: string
  volume?: string
  issue?: string
  pages?: string
  publisher?: string
  DOI?: string
  ISBN?: string
  url?: string
  abstractNote?: string
  tags?: string[]
  collections?: string[]
  dateAdded?: string
}

export type ZoteroCollection = {
  key: string
  name: string
  parentCollection?: string | false
  numberOfItems?: number
}

export type ZoteroAttachment = {
  key: string
  itemType: string
  title?: string
  contentType?: string
  path?: string
  filename?: string
}

export type ZoteroNote = {
  key: string
  parentKey?: string
  text: string
  tags?: string[]
  dateAdded?: string
}

export type ZoteroSearchArgs = {
  query?: string
  itemType?: string
  collection?: string
  tag?: string
  limit?: number
  sinceYear?: number
  beforeYear?: number
  sort?: string
  direction?: string
  offset?: number
  mode?: ResultMode
}

export type ZoteroSearchResult = {
  count: number
  totalResults?: number
  items: ZoteroItem[]
}

export type ZoteroItemResult = {
  item: ZoteroItem
  attachments: ZoteroAttachment[]
  childNotes: number
}

export type ZoteroCollectionsResult = { collections: ZoteroCollection[] }

export type ZoteroDownloadResult = { key: string; filename: string; contentType: string; size: number; path: string }

export type ZoteroNoteAction = 'create' | 'append' | 'update' | 'delete'

export type ZoteroNoteArgs = { action?: ZoteroNoteAction; itemKey?: string; noteKey?: string; text?: string; tags?: string[] }

export type ZoteroNoteResult = { action: ZoteroNoteAction; parentKey?: string; noteKey: string }

export type ZoteroNotesArgs = { itemKey?: string; query?: string; limit?: number }

export type ZoteroNotesResult = { count: number; notes: ZoteroNote[] }

export type ZoteroRecentArgs = { limit?: number; mode?: ResultMode }

export type ZoteroFulltextArgs = { itemKey: string; attachmentKey?: string }

export type ZoteroFulltextResult = {
  itemKey: string
  attachmentKey: string
  filename: string
  mode: 'text' | 'file'
  text?: string
  truncated?: boolean
  path?: string
  size?: number
}

export type ZoteroAttachmentPathResult = {
  itemKey: string
  attachmentKey: string
  path: string
  exists: boolean
  linked?: boolean
}
