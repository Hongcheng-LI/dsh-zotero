import type { ZoteroAttachment, ZoteroCollection, ZoteroConfig, ZoteroItem, ZoteroNote, ResultMode, ZoteroTotalKind } from './types.js';
export type ResolvedConfig = {
    baseUrl: string;
    libraryPath: string;
    downloadDir: string | undefined;
    maxAttachmentBytes: number;
    maxLimit: number;
    timeoutMs: number;
    dataDir: string | undefined;
    storageDir: string | undefined;
    maxFulltextChars: number;
    writeEnabled: boolean;
    apiKey: string | undefined;
};
export declare function resolveConfig(config?: ZoteroConfig): ResolvedConfig;
export declare class ZoteroError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
/**
 * writeEnabled=false 时的统一提示，工具层与客户端层共用：
 * 写操作直接给出可操作路径，不发起任何请求，也不把原因归给「服务器只读」。
 */
export declare function writeDisabledError(): ZoteroError;
type RawItem = {
    key: string;
    version?: number;
    data: Record<string, unknown>;
    meta?: Record<string, unknown>;
    library?: Record<string, unknown>;
};
export declare class ZoteroClient {
    private readonly cfg;
    constructor(cfg: ResolvedConfig);
    /** 缓存的 Zotero-Server-ID（null 表示取不到），写请求需要它才能通过 412 检查 */
    private serverIdCache;
    /** 从 GET /api/ 的响应头读取本实例的 Server-ID（Zotero 自己公开返回，无需授权） */
    private serverId;
    private request;
    /** 写入被拒时按 Zotero 的实际状态码给出可操作的归因，不再笼统归因于「服务器只读」 */
    private writeBlockedMessage;
    /**
     * 查询附件的本地文件地址。Zotero 本地 API 的 /file 端点返回 302，
     * Location 指向 file:///... （storage 内文件或链接附件的绝对路径），
     * 链接到网页的附件则是 http(s) 地址。不重定向（未来直接流式返回）时返回 null。
     * 用 node:http 手动请求：undici 的 fetch 会拒绝跟随非 HTTP(S) 的重定向。
     */
    attachmentFilePath(attachmentKey: string): Promise<string | null>;
    private getJson;
    private getJsonPage;
    /** 只取 Total-Results（limit=1），用于按 itemType 数出各子类条目数 */
    private countRows;
    /**
     * 默认检索里「真正可翻页的条目数」。
     *
     * Zotero 10.0.3 的 `itemType=-attachment` 会同时排除附件与标注（annotation），
     * 但**保留**笔记。实测全库 13169 = 顶层 4938 + 笔记 1541 + 附件 4662 + 标注 2028，
     * 而 `itemType=-attachment` 返回 6479 = 顶层 + 笔记。因此：
     * 既不能把服务器计数（6479）当成可见条目数，也不能用「全部 − 附件 − 笔记」（6966，多算了标注）。
     * 这里用四个 limit=1 的计数把口径算准，并为「服务器忽略负向参数」的未来情形兜底。
     */
    private visibleCount;
    private ensureCollectionExists;
    /** 探测连接与库可用性，返回库内条目总数 */
    ping(): Promise<number>;
    search(args: {
        query?: string;
        itemType?: string;
        collection?: string;
        tag?: string;
        limit: number;
        sinceYear?: number;
        beforeYear?: number;
        sort?: string;
        direction?: string;
        start?: number;
    }): Promise<{
        items: ZoteroItem[];
        totalResults: number;
        totalResultsKind: ZoteroTotalKind;
    }>;
    /** 最近添加的顶层条目（不含附件和笔记） */
    recent(limit: number): Promise<{
        items: ZoteroItem[];
    }>;
    item(key: string): Promise<{
        item: ZoteroItem;
        attachments: ZoteroAttachment[];
        childNotes: number;
    }>;
    private children;
    private toNote;
    /** 笔记检索：给了 itemKey 列其子笔记；否则全库按关键词搜笔记 */
    listNotes(args: {
        itemKey?: string;
        query?: string;
        limit: number;
    }): Promise<ZoteroNote[]>;
    /** 写入前的统一门禁：writeEnabled=false 时在读版本号之前就拒绝，不发任何请求 */
    private assertWriteEnabled;
    addNote(parentKey: string, text: string, tags?: string[]): Promise<string>;
    /** 在现有笔记末尾追加内容 */
    appendNote(noteKey: string, text: string): Promise<void>;
    /** 整体替换笔记正文（可顺带更新标签） */
    updateNote(noteKey: string, text: string, tags?: string[]): Promise<void>;
    deleteNote(noteKey: string): Promise<void>;
    private noteHead;
    private patchNote;
    private postNote;
    collections(): Promise<ZoteroCollection[]>;
    attachmentInfo(itemKey: string, attachmentKey: string): Promise<ZoteroAttachment>;
    downloadAttachment(attachmentKey: string): Promise<{
        bytes: Uint8Array;
        contentType: string;
        filename: string;
        path?: string;
    }>;
}
/** 把 Zotero 原始条目压缩成模型友好的精简结构 */
export declare function slimItem(raw: RawItem): ZoteroItem;
/** 按粒度裁剪检索结果：minimal 只留定位字段；preview 附 400 字截断摘要；full 不动 */
export declare function trimItems(items: ZoteroItem[], mode: ResultMode): ZoteroItem[];
export {};
