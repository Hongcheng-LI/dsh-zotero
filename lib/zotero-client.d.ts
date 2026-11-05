import type { ZoteroAnnotation, ZoteroAttachment, ZoteroCollection, ZoteroConfig, ZoteroItem, ZoteroNote, ResultMode } from './types.js';
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
    /** 显式配置的本地 API 写密钥；缺省自动读 Zotero profile 的持久 key */
    localApiKey: string | undefined;
    /** 授权弹窗等待时间（毫秒），单独放宽，默认 120000 */
    authorizeTimeoutMs: number;
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
    private serverId;
    private apiKey;
    constructor(cfg: ResolvedConfig);
    /** 缓存每个响应头里的 Zotero-Server-ID（server_localAPI.js：每个响应都带）。 */
    private cacheServerId;
    /**
     * 写请求前确保拿到 Server ID。GET 无需认证，一次轻量请求读响应头即可。
     * 不走 request() 以免递归；失败时返回 undefined，让写请求带出更明确的错误。
     */
    private ensureServerId;
    /** 解析写密钥：显式配置 > Zotero profile 中「始终允许」持久化的 key。 */
    private writeKey;
    private request;
    /**
     * 触发 Zotero 桌面端的「本地 API 授权」弹窗，返回写密钥。
     * 端点 /api/local/authorize 不在 /api/<libraryPath> 下，故直接 fetch，不走 request()。
     * 用户点「始终允许」→ remember=true，key 由 Zotero 持久化到 <profile>/localAPIKeys.json；
     * 点「允许」→ 一次性 key，首次成功写入后即被消费，下次写会 401。
     */
    authorize(appName?: string): Promise<{
        key: string;
        remember: boolean;
    }>;
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
    /**
     * 在指定 PDF 附件下创建一条高亮批注（annotation item）。
     * 字段与 Zotero 本地 API 的 annotation JSON 对齐（实测库内已有 2040 条同类条目）：
     * annotationPosition 是「转义后的 JSON 字符串」，pageIndex 从 0 起；
     * annotationPageLabel 是 PDF 内印刷页码。
     * annotationSortIndex 对 PDF 附件必须匹配 /^\d{5}\|\d{6}\|\d{5}$/
     * （Zotero chrome/content/zotero/xpcom/data/item.js:4547 的 PDF 分支校验），
     * 即「页序(5)|纵向(6)|横向(5)」三段。这里用首个 rect 的坐标派生后两段，
     * 只保证格式合法与阅读顺序大致合理，不精确复现 Zotero PDF reader 内部的坐标换算；
     * 不传 rects 时使用占位矩形，高亮在 reader 中的落点不精确。
     */
    addHighlight(args: {
        attachmentKey: string;
        text: string;
        page: number;
        pageLabel?: string;
        color?: string;
        comment?: string;
        rects?: number[][];
    }): Promise<string>;
    /**
     * 修改已有 PDF 批注的批注评论。Zotero annotation 是普通 item，
     * 走 Item 端点的 PATCH，并带 If-Unmodified-Since-Version 做并发保护。
     */
    updateAnnotationComment(annotationKey: string, comment: string): Promise<void>;
    /** 在现有笔记末尾追加内容 */
    appendNote(noteKey: string, text: string): Promise<void>;
    /** 整体替换笔记正文（可顺带更新标签） */
    updateNote(noteKey: string, text: string, tags?: string[]): Promise<void>;
    deleteNote(noteKey: string): Promise<void>;
    private noteHead;
    private patchNote;
    /** 批量创建条目（POST /items），返回第一个新条目的 key */
    private postItems;
    collections(): Promise<ZoteroCollection[]>;
    attachmentInfo(itemKey: string, attachmentKey: string): Promise<ZoteroAttachment>;
    /**
     * 单条目导出为引用格式（BibTeX/RIS/CSL JSON）。
     * 本地 API 对多 key 的 itemKey= 过滤会静默忽略（实测返回整库），因此
     * 批量导出必须逐 key 调用本方法后由调用方拼接。
     */
    exportItem(key: string, format: 'bibtex' | 'ris' | 'csljson'): Promise<string>;
    /**
     * 读取条目附件上的 PDF 批注（高亮/笔记/图像等）。
     * 本地 API 不在 /items/{key}/children 里返回批注，必须按
     * itemType=annotation&parentItem=<附件key> 检索（实测有效）。
     */
    annotations(itemKey: string, attachmentKey?: string): Promise<ZoteroAnnotation[]>;
    /** 列出库内用户标签（按 Zotero 默认序） */
    tags(limit: number): Promise<string[]>;
    /** 列出保存的智能搜索（key + 名称 + 条件摘要） */
    savedSearches(limit: number): Promise<Array<{
        key: string;
        name: string;
        conditions?: string;
    }>>;
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
