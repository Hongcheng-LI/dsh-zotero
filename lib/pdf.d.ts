/**
 * 解析 PDF 文件为纯文本。
 * @param path PDF 绝对路径
 * @param maxChars 最大字符数（0 = 不截断）。提前截断会停止解析后续页，节省时间。
 * @returns 纯文本（页间换行分隔，去首尾空白）
 */
export declare function extractPdfText(path: string, maxChars?: number): Promise<string>;
