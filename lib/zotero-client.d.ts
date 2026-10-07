import type { ZoteroAttachment, ZoteroCollection, ZoteroConfig, ZoteroItem, ZoteroNote, ResultMode } from './types.js';
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
};
export declare function resolveConfig(config?: ZoteroConfig): ResolvedConfig;
export declare class ZoteroError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
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
    private request;
    /**
     * 查询附件的本地文件地址。Zotero 本地 API 的 /file 端点返回 302，
     * Location 指向 file:///... （storage 内文件或链接附件的绝对路径），
     * 链接到网页的附件则是 http(s) 地址。不重定向（未来直接流式返回）时返回 null。
     * 用 node:http 手动请求：undici 的 fetch 会拒绝跟随非 HTTP(S) 的重定向。
     */
    attachmentFilePath(attachmentKey: string): Promise<string | null>;
    private getJson;
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
        totalResults?: number;
    }>;
    /** 最近添加的条目（不含附件和笔记） */
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
