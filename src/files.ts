import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** file:///C:/a%20b/x.pdf → C:/a b/x.pdf；非 file: URL 原样返回 */
export function fileUrlToPath(url: string): string {
  if (!url.startsWith('file:')) return url
  let pathname = decodeURIComponent(new URL(url).pathname)
  // Windows: /C:/Software/... → C:/Software/...
  if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
  return pathname
}

/** 把附件字节写到下载目录（配置）或会话工作区，返回绝对路径；同名冲突时自动加序号 */
export async function writeAttachment(
  filename: string,
  bytes: Uint8Array,
  downloadDir: string | undefined,
  cwd: string | undefined,
): Promise<string> {
  const safeName = filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'attachment.bin'
  const dir = downloadDir ? resolve(downloadDir) : cwd ? resolve(cwd) : process.cwd()
  await mkdir(dir, { recursive: true })
  const { basename, extname } = await import('node:path')
  const ext = extname(safeName)
  const base = basename(safeName, ext).slice(0, Math.max(1, 180 - ext.length))
  let target = join(dir, `${base}${ext}`)
  for (let i = 1; i < 100; i++) {
    try {
      await writeFile(target, bytes, { flag: 'wx' })
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      target = join(dir, `${base}(${i})${ext}`)
    }
  }
  throw new Error('附件文件名冲突过多，请换个下载目录（downloadDir）')
}
