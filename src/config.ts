// 插件配置 schema（schemastery）。
// DSH 0.2.0-rc.x 的插件加载器会把 profile 里 tool-zotero 行的 config 交给该 schema 校验，
// 并据此在「插件管理器 → 配置」里渲染设置表单；所有字段全部可选，缺省即用内置默认值
// （与 src/zotero-client.ts 的 resolveConfig 一一对应）。
import Schema from '@deepseek-ai/schemastery'

/** 描述统一英文写在 description，中文经 i18n() 以 locale 字典合并，设置表单按界面语言显示。 */
function zhDesc(schema: Schema<string> | Schema<number>, text: string) {
  return schema.i18n({ 'zh-CN': { $description: text } })
}

export const Config = Schema.object({
  baseUrl: zhDesc(
    Schema.string().description('Zotero local API base URL (default http://127.0.0.1:23119)'),
    'Zotero 本地 API 地址，默认 http://127.0.0.1:23119',
  ),
  library: zhDesc(
    Schema.string()
      .description('"user" (my library) or "group:<groupID>" (default user)')
      .pattern(/^\s*(user|group:\d+)\s*$/),
    '"user"（我的文献库）或 "group:<群组ID>"，默认 user',
  ),
  downloadDir: zhDesc(
    Schema.string().description('Directory for downloaded attachments (default: session workspace)'),
    '附件下载目录；缺省写入会话工作区',
  ),
  dataDir: zhDesc(
    Schema.string().description('Zotero data directory containing profiles.ini (auto-detected by default)'),
    'Zotero 数据目录（含 profiles.ini）；默认自动探测',
  ),
  storageDir: zhDesc(
    Schema.string().description('Zotero storage directory (auto-detected by default)'),
    '直接指定 storage 目录；默认自动探测',
  ),
  maxAttachmentBytes: zhDesc(
    Schema.natural().description('Max bytes per attachment download (default 64 MiB)'),
    '单附件下载上限（字节），默认 64MB',
  ),
  maxLimit: zhDesc(
    Schema.natural().description('Max rows per search/list call (default 50)'),
    '检索/列表单次返回条数上限，默认 50',
  ),
  timeoutMs: zhDesc(
    Schema.natural().description('Local API request timeout in ms (default 15000)'),
    '本地 API 请求超时（毫秒），默认 15000',
  ),
  maxFulltextChars: zhDesc(
    Schema.natural().description('Max characters returned by zotero_fulltext (default 80000)'),
    'zotero_fulltext 返回的最大字符数，默认 80000',
  ),
})
