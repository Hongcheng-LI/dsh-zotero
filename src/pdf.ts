// PDF 文本提取：用 pdfjs-dist（纯 JS legacy build，无 worker，内存解析）。
// 用于 zotero_fulltext 在 Zotero 全文缓存（.zotero-ft-cache）未命中时，现场解析 PDF 返回全文。
import { readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/**
 * 解析 PDF 文件为纯文本。
 * @param path PDF 绝对路径
 * @param maxChars 最大字符数（0 = 不截断）。提前截断会停止解析后续页，节省时间。
 * @returns 纯文本（页间换行分隔，去首尾空白）
 */
export async function extractPdfText(path: string, maxChars = 0): Promise<string> {
  const data = new Uint8Array(await readFile(path))
  let doc: PDFDocumentProxy | null = null
  try {
    doc = await getDocument({
      data,
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise

    let text = ''
    for (let i = 1; i <= doc.numPages; i++) {
      const page: PDFPageProxy = await doc.getPage(i)
      try {
        const content = await page.getTextContent()
        const pageText = content.items
          .map((it) => ('str' in it ? (it as { str: string }).str : ''))
          .join(' ')
          .trim()
        if (pageText) text += pageText + '\n'
      } finally {
        page.cleanup()
      }
      if (maxChars > 0 && text.length >= maxChars) {
        text = text.slice(0, maxChars)
        break
      }
    }
    return text.trim()
  } finally {
    await doc?.destroy()
  }
}
