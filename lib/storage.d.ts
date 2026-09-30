/** 各平台 Zotero 数据目录的默认位置 */
export declare function defaultDataDir(): string;
/**
 * 解析 profiles.ini，返回 profile 目录的绝对路径。
 * 优先取 [Install*] 段的 Default 指向的 profile，否则取第一个带 Path 的段。
 */
export declare function profileDirFromIni(ini: string, dataDir: string): string | null;
/** 解析 storage 目录；找不到返回 null（工具会走下载兜底） */
export declare function resolveStorageDir(opts?: {
    dataDir?: string;
    storageDir?: string;
}): string | null;
/** 读取指定路径的全文缓存文件；读不到返回 null */
export declare function readFulltextFile(cachePath: string): Promise<string | null>;
/** Zotero 全文索引缓存（纯文本，Zotero 自己维护），读不到返回 null */
export declare function readFulltextCache(storageDir: string, attachmentKey: string): Promise<string | null>;
/** 由附件的 data.path（storage:xxx.pdf）拼出 storage 内的绝对路径；非 storage 附件返回 null */
export declare function attachmentStoragePath(storageDir: string, attachmentKey: string, path: string | undefined): string | null;
