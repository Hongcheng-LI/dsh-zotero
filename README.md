# dsh-zotero

[English](#english) | [中文](#中文)

<a name="中文"></a>

DeepSeek Harness 的 Zotero 工具插件：让 agent 直接**检索你的 Zotero 文献库、阅读条目元数据与摘要、列出分类和 PDF 附件、读 PDF 全文、代写读书笔记**。通过 Zotero 本地 API（7 代及以上可用，实测 9.x；`http://127.0.0.1:23119`）访问，无需 API Key，纯 Node 实现，零核心改动。

> **独立仓库**：本仓库是 dsh-zotero 的唯一正本（曾作为 dsh-scientific monorepo 的 `plugins/zotero`，2026-08 拆分独立）。配套的 skills / workflows 仍在 [dsh-scientific](https://github.com/Hongcheng-LI/dsh-scientific)。

## DSH 兼容性

当前 `0.1.3` 已按 DSH 0.2 工具插件接口复核（基线：`@deepseek-ai/dsh@0.2.0-rc.1`）。9 个 Zotero 工具继续使用官方支持的 `inject = ['tools']`、`ctx.tools.register(...)`、`output.schema/output.render` 和 `execute(args, exec)` 接口，无需重写。

从 GitHub 安装时，本仓库直接提交 `lib/` 构建产物，因此安装不再依赖 Git 依赖的 `prepare` 构建脚本，可避开 pnpm 10 对 Git build script 的限制。`dsh.plugin.json` 仅保留给旧工具读取；DSH 0.2 的安装/启用以 `package.json` 中的 `dsh.bundle` 和 `cordis.patch.yml` 为准。详细审计见 `DSH-0.2-COMPAT.md`。

## 前置条件

1. 本机安装并运行 **Zotero 7 及以上**（本地 API 自 7 代引入；本项目在 **Zotero 10.0.3 / Windows** 上实测通过）；
2. 打开 Zotero：**设置 → 高级 → 通用 → 勾选「允许本机上的其他应用程序与 Zotero 通信」**。

> 兼容性说明：读取类工具（检索/条目/全文/附件路径/笔记读取）在 Zotero 10.0.3 上实测通过。笔记**写入**（create/append/update/delete）受本地 API 只读限制不可用（见工具表说明）。

## 工具一览

| 工具 | 作用 |
|---|---|
| `zotero_collections` | 列出文献库的所有分类（collectionKey + 条目数），用于限定检索范围 |
| `zotero_search` | 按关键词检索文献库（标题/作者/年份），支持条目类型、分类、标签、年份区间（sinceYear/beforeYear）、排序、分页；`mode` 控制返回粒度省 token |
| `zotero_recent` | 列出最近添加的条目（"我刚导入的文献"场景） |
| `zotero_item` | 按 key 读取条目详情：作者、期刊、DOI、摘要、标签、附件列表 |
| `zotero_fulltext` | 读条目全文纯文本：优先读 Zotero 全文缓存（`.zotero-ft-cache`，零下载），无缓存时**现场解析本地 PDF**（pdfjs-dist，约 0.3s）并写缓存；仅远程链接附件才下载到工作区 |
| `zotero_attachment_path` | 返回附件在 storage 的原始绝对路径，让 read 工具零拷贝直读 |
| `zotero_download` | 把条目的 PDF 附件下载到会话工作区（默认），供模型用 read 工具阅读 |
| `zotero_notes` | 列出某条目的子笔记，或全库按关键词搜笔记正文 |
| `zotero_note` | 笔记写入：create 新增 / append 追加 / update 更新 / delete 删除。默认关闭（`writeEnabled: false`），此时不发任何请求、直接给出可操作提示；开启后还需完成 Zotero 本地 API 授权（`POST /api/local/authorize`）并把密钥填入 `apiKey` |

另有随包 skill `paper-reading`（结构化文献精读）：插件启动时会把它注册进 DSH 的技能目录，无需额外配置。

示例对话：

> 在我的 Zotero 里搜一下 transformer 相关的论文，挑 2020 年以后的，把第一篇的全文读一遍，给我写个摘要存进笔记。


### 0.1.4 修复

- `writeEnabled` 不再是无效配置：默认 `false` 时写工具在**发起任何请求前**就拒绝，并解释开启路径；设为 `true` 时写请求会带上 `Zotero-Server-ID`（从 `GET /api/` 公开读取）与配置的 `apiKey`（`Zotero-API-Key` 头）。
- 写失败按 Zotero 的真实状态码归因，不再笼统说「服务器只读」：`401` → 需要本地授权（`POST /api/local/authorize` 换 API key，填入 `apiKey`）；`412` → Server-ID 与实例不匹配；`428` → 未取到 Server-ID；只有 `405/501/400` 才表示端点确实不支持写入。
- `zotero_search` 的 `totalResults` 口径修正：默认检索会用三次 `limit=1` 计数（全部 − 附件 − 笔记）算出**真正可翻页的条目数**（新增 `totalResultsKind: visible`）；带年份过滤时无法精确计数，标注为 `server-approximate` 并在渲染文案里说明「含已过滤的附件/笔记」，不再把服务器计数当成可翻页条数。
- 随包 `skills/paper-reading` 现在真正生效：插件按 `dsh-skill-office` 的方式向 `ctx.skills` 注册自带 provider（rank 600），不再需要在 `customSkillDirs` 里额外配置；注册表缺失或重复注册时静默降级，不影响加载。

### 0.1.3 修复

- 修复 Zotero 10.0.3 本地 API 不识别 `itemType=-attachment -note` 的问题：默认检索改为服务端单值排除 `attachment`，客户端继续排除 `note`，并自动翻页补足 `limit`。
- `zotero_recent` 与 collection 限定检索复用同一过滤流程，不再混入附件或笔记。
- storage 自动探测优先支持 Zotero 7+ 的 `<profile>/storage`，并保留旧的 `<profile>/zotero/storage` 兼容。
- Zotero 10 返回 HTTP 428 `Zotero-Server-ID not provided` 时，笔记写操作转换为明确的只读提示；空 `statusText` 不再显示为 `undefined`。
- 发布包现在包含 `skills/paper-reading/SKILL.md`。

### 0.1.2 修复

- 修复 DSH Remote JSON 校验失败：返回对象不再包含嵌套 `undefined`。
- `zotero_collections` 支持完整分页，并正确保留顶层分类的 `parentCollection: false`。
- `zotero_search` 在使用 collection 前先校验 collectionKey，避免无效 key 被 Zotero 10 本地 API 静默当作全库。
- 默认检索在服务端排除 attachment/note；年份过滤会连续分页直到取够 `limit`，并在过滤后应用 `offset`。
- 条目子附件/笔记列表支持超过 100 条时继续分页。

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
    storageDir: .../storage     # 直接指定 storage 目录（zotero_fulltext / attachment_path 用）
    maxAttachmentBytes: 67108864       # 单附件下载上限，默认 64MB
    maxFulltextChars: 80000            # zotero_fulltext 返回的最大字符数，默认 80000
    maxLimit: 50                       # 检索结果条数上限，默认 50
    timeoutMs: 15000                   # 本地 API 超时（毫秒）
    writeEnabled: false                # 是否允许 zotero_note 写入（默认 false）
    apiKey: <授权得到的密钥>            # writeEnabled: true 且完成本地授权后填入
```

全文与附件路径：插件通过本地 API `/file` 端点的 302 重定向拿到附件的真实磁盘路径（自定义数据目录也能自动识别，无需配置），全文优先读 Zotero 自己维护的 `.zotero-ft-cache` 缓存（与附件同目录）。`dataDir`/`storageDir` 配置仅在重定向不可用时作为兜底。

## 开发

```sh
npm install
npm test          # 构建单元测试（离线，不需要 Zotero）
npm run test:smoke # 真实环境冒烟测试：对本机 Zotero 完整跑一遍工具链
```

冒烟测试覆盖 `zotero_recent → zotero_item → zotero_search → zotero_fulltext → zotero_attachment_path → 笔记 create/append/update/delete` 全链路，需要 Zotero 7+（实测 10.0.3）在线（不可达时自动 skip，不报错）。笔记生命周期测试默认跳过（写入默认关闭）：设 `ZOTERO_SMOKE_WRITE=1`（必要时加 `ZOTERO_API_KEY=<本地授权密钥>`）才会真正写库。笔记测试会创建并清理自己的笔记，附件下载进系统临时目录，不会污染你的文献库和工作区；如果当前 Zotero 版本的本地 API 不支持 PATCH/DELETE 写操作，会以 skip/diagnostic 形式明确报告而不是误报失败。指定 API 地址：`ZOTERO_SMOKE=1 ZOTERO_BASE_URL=http://127.0.0.1:23119 node --test test/smoke.mjs`。

结构遵循 DSH 插件规范：`dsh.plugin.json` 元信息、`cordis.patch.yml` 运行时注入行、`src/` 源码、`lib/` 构建产物。

---

<a name="english"></a>

Zotero tools for DeepSeek Harness: search your library, read item metadata and abstracts, list collections and PDF attachments, download PDFs into the session workspace, and attach notes — all through the Zotero local API (no API key needed).

Requires Zotero 7+ (tested on 10.0.3 / Windows) running locally with "Allow other applications on this computer" enabled in Settings → Advanced.

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
