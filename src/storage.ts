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

/**
 * 解析 Zotero 的 Firefox profile 目录（含 prefs.js）。
 * 与 resolveStorageDir 共用 profiles.ini 解析；找不到返回 null。
 * Zotero 把本地 API 授权密钥写到 <profile>/localAPIKeys.json。
 */
export function resolveProfileDir(opts: { dataDir?: string } = {}): string | null {
  const dataDir = opts.dataDir?.trim() || process.env.ZOTERO_DATA_DIR?.trim() || defaultDataDir()
  try {
    const ini = readFileSync(join(dataDir, 'profiles.ini'), 'utf8')
    return profileDirFromIni(ini, dataDir)
  } catch {
    return null
  }
}

/**
 * 读取 Zotero 7+ 本地 API 的持久写密钥。
 * 用户在「本地 API 授权」弹窗点「始终允许」后，Zotero 会把
 * {"keys":[{"key":"...","appName":"...","remember":true,...}]}
 * 写到 <profile>/localAPIKeys.json（server_localAPI.js 的 _localAPIKeysPath）。
 * 优先取 appName 含 dsh 的持久 key，其次任意 remember 的 key，最后任意 key。
 */
export function readStoredLocalAPIKey(opts: { dataDir?: string } = {}): string | undefined {
  const profile = resolveProfileDir(opts)
  if (!profile) return undefined
  try {
    const file = join(profile, 'localAPIKeys.json')
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      keys?: Array<{ key?: string; appName?: string; remember?: boolean }>
    }
    const keys = Array.isArray(parsed.keys) ? parsed.keys : []
    const valid = keys.filter((k) => typeof k.key === 'string' && k.key.length > 0)
    if (valid.length === 0) return undefined
    const remembered = valid.filter((k) => k.remember === true)
    const dsh = remembered.find((k) => (k.appName ?? '').toLowerCase().includes('dsh'))
    return (dsh ?? remembered[0] ?? valid[0])?.key
  } catch {
    return undefined
  }
}
