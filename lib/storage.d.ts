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
/**
 * 解析 Zotero 的 Firefox profile 目录（含 prefs.js）。
 * 与 resolveStorageDir 共用 profiles.ini 解析；找不到返回 null。
 * Zotero 把本地 API 授权密钥写到 <profile>/localAPIKeys.json。
 */
export declare function resolveProfileDir(opts?: {
    dataDir?: string;
}): string | null;
/**
 * 读取 Zotero 7+ 本地 API 的持久写密钥。
 * 用户在「本地 API 授权」弹窗点「始终允许」后，Zotero 会把
 * {"keys":[{"key":"...","appName":"...","remember":true,...}]}
 * 写到 <profile>/localAPIKeys.json（server_localAPI.js 的 _localAPIKeysPath）。
 * 优先取 appName 含 dsh 的持久 key，其次任意 remember 的 key，最后任意 key。
 */
export declare function readStoredLocalAPIKey(opts?: {
    dataDir?: string;
}): string | undefined;
