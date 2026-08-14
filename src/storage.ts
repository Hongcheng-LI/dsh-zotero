import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** 各平台 Zotero 数据目录的默认位置 */
export function defaultDataDir(): string {
  const p = platform()
  if (p === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Zotero', 'Zotero')
  }
  if (p === 'darwin') return join(homedir(), 'Zotero')
  return join(homedir(), '.zotero')
}

/**
 * 解析 profiles.ini，返回 profile 目录的绝对路径。
 * 优先取 [Install*] 段的 Default 指向的 profile，否则取第一个带 Path 的段。
 */
export function profileDirFromIni(ini: string, dataDir: string): string | null {
  type Section = { name: string; path?: string; relative?: boolean }
  const sections: Section[] = []
  let current: Section | null = null
  let installDefault: string | null = null
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      current = { name: section[1] }
      sections.push(current)
      continue
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!kv || !current) continue
    const [, key, value] = kv
    if (key === 'Default' && current.name.startsWith('Install')) installDefault = value
    else if (key === 'Path') current.path = value
    else if (key === 'IsRelative') current.relative = value !== '0'
  }
  const chosen =
    sections.find((s) => s.path && s.name === installDefault) ?? sections.find((s) => s.path !== undefined)
  if (!chosen?.path) return null
  return chosen.relative === false ? chosen.path : join(dataDir, chosen.path)
}

/** 解析 storage 目录；找不到返回 null（工具会走下载兜底） */
export function resolveStorageDir(opts: { dataDir?: string; storageDir?: string } = {}): string | null {
  if (opts.storageDir && opts.storageDir.trim() !== '') return opts.storageDir.trim()
  const dataDir = opts.dataDir?.trim() || process.env.ZOTERO_DATA_DIR?.trim() || defaultDataDir()
  try {
    const ini = readFileSync(join(dataDir, 'profiles.ini'), 'utf8')
    const profile = profileDirFromIni(ini, dataDir)
    if (!profile) return null
    const storage = join(profile, 'zotero', 'storage')
    return existsSync(storage) ? storage : null
  } catch {
    return null
  }
}

/** 读取指定路径的全文缓存文件；读不到返回 null */
export async function readFulltextFile(cachePath: string): Promise<string | null> {
  try {
    const text = await readFile(cachePath, 'utf8')
    const trimmed = text.trim()
    return trimmed !== '' ? trimmed : null
  } catch {
    return null
  }
}

/** Zotero 全文索引缓存（纯文本，Zotero 自己维护），读不到返回 null */
export async function readFulltextCache(storageDir: string, attachmentKey: string): Promise<string | null> {
  return readFulltextFile(join(storageDir, attachmentKey, '.zotero-ft-cache'))
}

/** 由附件的 data.path（storage:xxx.pdf）拼出 storage 内的绝对路径；非 storage 附件返回 null */
export function attachmentStoragePath(
  storageDir: string,
  attachmentKey: string,
  path: string | undefined,
): string | null {
  if (!path?.startsWith('storage:')) return null
  return join(storageDir, attachmentKey, path.slice('storage:'.length))
}
