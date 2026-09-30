/** file:///C:/a%20b/x.pdf → C:/a b/x.pdf；非 file: URL 原样返回 */
export declare function fileUrlToPath(url: string): string;
/** 把附件字节写到下载目录（配置）或会话工作区，返回绝对路径；同名冲突时自动加序号 */
export declare function writeAttachment(filename: string, bytes: Uint8Array, downloadDir: string | undefined, cwd: string | undefined): Promise<string>;
