// 解析 PDF 并保存为 .zotero-ft-cache 格式
// 模拟 Zotero 的全文索引过程
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const PDF = 'C:/Software/Data/02-Zotero/storage/IWGJ2PMQ/2024-Science-Characterization and heterologous reconstitution of Taxus biosynthetic enzymes leading to baccatin III.pdf'
const CACHE = join(dirname(PDF), '.zotero-ft-cache')

console.log('PDF:', PDF)
console.log('Cache:', CACHE)

const pdfBuf = await readFile(PDF)
console.log(`PDF size: ${pdfBuf.length} bytes`)
console.log(`PDF header: ${pdfBuf.subarray(0, 8).toString()}`)

// 尝试方案 A: pdfjs-dist (纯 JS, 不依赖 schannel)
console.log('\n--- 尝试 pdfjs-dist ---')
try {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuf),
    useSystemFonts: false,
    disableFontFace: true
  }).promise
  console.log(`pages: ${data.numPages}`)
  let fullText = ''
  for (let i = 1; i <= Math.min(data.numPages, 10); i++) {
    const page = await data.getPage(i)
    const tc = await page.getTextContent()
    const pageText = tc.items.map(it => it.str).join(' ')
    fullText += `\n--- Page ${i} ---\n${pageText}\n`
  }
  console.log(`提取字符数: ${fullText.length}`)
  console.log(`\n====== 预览（前 3000 字符）======`)
  console.log(fullText.substring(0, 3000))
  await writeFile(CACHE, fullText.trim(), 'utf8')
  console.log(`\n  ✓ 已写入 ${CACHE}`)
} catch (e) {
  console.log(`pdfjs-dist 失败: ${e.message}`)
  // 方案 B: 用 mutool (MuPDF) 如果在 PATH
  console.log('\n--- 尝试 mutool ---')
  const tryCmd = (cmd, args) => new Promise(resolve => {
    const p = spawn(cmd, args)
    let out = '', err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => err += d)
    p.on('close', code => resolve({ code, out, err }))
  })
  let r = await tryCmd('mutool', ['draw', '-F', 'text', PDF])
  if (r.code === 0) {
    console.log(`mutool 输出: ${r.out.length} chars`)
    console.log(r.out.substring(0, 1000))
    await writeFile(CACHE, r.out, 'utf8')
  } else {
    console.log('mutool 不在 PATH')
    // 方案 C: pdftotext
    r = await tryCmd('pdftotext', ['-layout', PDF, '-'])
    if (r.code === 0) {
      console.log(`pdftotext 输出: ${r.out.length} chars`)
      console.log(r.out.substring(0, 1000))
      await writeFile(CACHE, r.out, 'utf8')
    } else {
      console.log('pdftotext 也不在 PATH')
      console.log('stderr:', r.err.substring(0, 200))
    }
  }
}
