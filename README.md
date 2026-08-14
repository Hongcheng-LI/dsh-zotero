# dsh-zotero

[English](#english) | [中文](#中文)

<a name="中文"></a>

DeepSeek Harness 的 Zotero 工具插件：让 agent 直接**检索你的 Zotero 文献库、阅读条目元数据与摘要、列出分类和 PDF 附件、把 PDF 下载到工作区阅读、代写读书笔记**。通过 Zotero 本地 API（7 代及以上可用，实测 9.x；`http://127.0.0.1:23119`）访问，无需 API Key，纯 Node 实现，零核心改动。

## 前置条件

1. 本机安装并运行 **Zotero 7 及以上**（本地 API 自 7 代引入；本项目在 **Zotero 9.0.6 / Windows** 上实测通过）；
2. 打开 Zotero：**设置 → 高级 → 通用 → 勾选「允许本机上的其他应用程序与 Zotero 通信」**。

> 兼容性说明：读取类工具（检索/条目/全文/附件路径/笔记读取）在 Zotero 9 上全部实测通过。笔记**写入**（create/append/update/delete）受本地 API 只读限制不可用（见工具表说明）。

## 工具一览

| 工具 | 作用 |
|---|---|
| `zotero_collections` | 列出文献库的所有分类（collectionKey + 条目数），用于限定检索范围 |
| `zotero_search` | 按关键词检索文献库（标题/作者/年份），支持条目类型、分类、标签、年份区间（sinceYear/beforeYear）、排序、分页；`mode` 控制返回粒度省 token |
| `zotero_recent` | 列出最近添加的条目（"我刚导入的文献"场景） |
| `zotero_item` | 按 key 读取条目详情：作者、期刊、DOI、摘要、标签、附件列表 |
| `zotero_fulltext` | 读条目全文纯文本：优先读 Zotero 全文缓存（`.zotero-ft-cache`，零下载），无缓存时自动下载 PDF 到工作区 |
| `zotero_attachment_path` | 返回附件在 storage 的原始绝对路径，让 read 工具零拷贝直读 |
| `zotero_download` | 把条目的 PDF 附件下载到会话工作区（默认），供模型用 read 工具阅读 |
| `zotero_notes` | 列出某条目的子笔记，或全库按关键词搜笔记正文 |
| `zotero_note` | 笔记写入：create 新增 / append 追加 / update 更新 / delete 删除。⚠️ 实测多数版本的本地 API 为只读（POST/PATCH/DELETE 未开放），写操作会返回明确提示并建议手动操作 |

示例对话：

> 在我的 Zotero 里搜一下 transformer 相关的论文，挑 2020 年以后的，把第一篇的全文读一遍，给我写个摘要存进笔记。

## 安装

```sh
dsh plugin --profile web add dsh-zotero
```

或从 GitHub 安装：

```sh
dsh plugin --profile web add github:<你的账号>/dsh-zotero#<commit>
```

装好后重启 `dsh web`。插件自带空配置，不会弄崩启动；Zotero 未运行时工具会返回明确的连接提示。

## 配置（可选）

默认配置即可用（本地库、端口 23119）。如需自定义，在你的 profile（`$DSH_HOME/profiles/<name>/`）的 `cordis.patch.yml` 里覆盖 `tool-zotero` 行，然后重启：

```yaml
- id: tool-zotero
  config:
    baseUrl: http://127.0.0.1:23119   # Zotero 本地 API 地址
    library: user                      # user（我的文献库）或 group:<群组ID>
    downloadDir: D:/papers             # 附件下载目录，缺省存到会话工作区
    dataDir: D:/ZoteroData             # Zotero 数据目录（含 profiles.ini），默认自动探测
    storageDir: .../zotero/storage     # 直接指定 storage 目录（zotero_fulltext / attachment_path 用）
    maxAttachmentBytes: 67108864       # 单附件下载上限，默认 64MB
    maxFulltextChars: 80000            # zotero_fulltext 返回的最大字符数，默认 80000
    maxLimit: 50                       # 检索结果条数上限，默认 50
    timeoutMs: 15000                   # 本地 API 超时（毫秒）
```

全文与附件路径：插件通过本地 API `/file` 端点的 302 重定向拿到附件的真实磁盘路径（自定义数据目录也能自动识别，无需配置），全文优先读 Zotero 自己维护的 `.zotero-ft-cache` 缓存（与附件同目录）。`dataDir`/`storageDir` 配置仅在重定向不可用时作为兜底。

## 开发

```sh
npm install
npm test          # 构建单元测试（离线，不需要 Zotero）
npm run test:smoke # 真实环境冒烟测试：对本机 Zotero 完整跑一遍工具链
```

冒烟测试覆盖 `zotero_recent → zotero_item → zotero_search → zotero_fulltext → zotero_attachment_path → 笔记 create/append/update/delete` 全链路，需要 Zotero 7+（实测 9.0.6）在线（不可达时自动 skip，不报错）。笔记测试会创建并清理自己的笔记，附件下载进系统临时目录，不会污染你的文献库和工作区；如果当前 Zotero 版本的本地 API 不支持 PATCH/DELETE 写操作，会以 skip/diagnostic 形式明确报告而不是误报失败。指定 API 地址：`ZOTERO_SMOKE=1 ZOTERO_BASE_URL=http://127.0.0.1:23119 node --test test/smoke.mjs`。

结构遵循 DSH 插件规范：`dsh.plugin.json` 元信息、`cordis.patch.yml` 运行时注入行、`src/` 源码、`lib/` 构建产物。

---

<a name="english"></a>

Zotero tools for DeepSeek Harness: search your library, read item metadata and abstracts, list collections and PDF attachments, download PDFs into the session workspace, and attach notes — all through the Zotero local API (no API key needed).

Requires Zotero 7+ (tested on 9.0.6 / Windows) running locally with "Allow other applications on this computer" enabled in Settings → Advanced.

| Tool | What it does |
|---|---|
| `zotero_collections` | List library collections with keys and counts |
| `zotero_search` | Quick-search items; filters by type, collection, tag, year range; sort/pagination; `mode` controls verbosity |
| `zotero_recent` | Recently added items |
| `zotero_item` | Full metadata of one item plus attachment keys |
| `zotero_fulltext` | Full text as plain text (Zotero fulltext cache first, PDF download fallback) |
| `zotero_attachment_path` | On-disk path of a stored attachment (zero-copy read) |
| `zotero_download` | Download an attachment (PDF) to the workspace |
| `zotero_notes` | List an item's child notes or search notes library-wide |
| `zotero_note` | Create / append / update / delete notes |

Install: `dsh plugin --profile web add dsh-zotero`, then restart `dsh web`. Optional config (`baseUrl`, `library`, `downloadDir`, `maxAttachmentBytes`, `maxLimit`, `timeoutMs`) goes under the `tool-zotero` row of your profile's `cordis.patch.yml`.

## License

MIT
