/**
 * 解析 PDF 文件为纯文本。
 * @param path PDF 绝对路径
 * @param maxChars 最大字符数（0 = 不截断）。提前截断会停止解析后续页，节省时间。
 * @returns 纯文本（页间换行分隔，去首尾空白）
 */
export declare function extractPdfText(path: string, maxChars?: number): Promise<string>;
/**
 * 解析 PDF 文本并保留页边界（供 zotero_retrieve 的页码锚点使用）。
 * @param maxPages 最大解析页数（0 = 全部）
 * @returns 每页文本数组（索引 0 = 第 1 页）；空页保留为空串以维持页码对齐
 */
export declare function extractPdfPages(path: string, maxPages?: number): Promise<string[]>;
