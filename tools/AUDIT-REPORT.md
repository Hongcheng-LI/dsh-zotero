# dsh-zotero 运行时审计报告

- **日期**：2026-10-07（0.2.2 修订：检索与最近条目改用 /items/top 顶层端点）
- **目标运行时**：DSH 0.2.0-rc.2（桌面版 44.0.0 内核，@deepseek-ai/dsh-tools@0.2.0-rc.2 真实注册表校验）
- **工具**：`npm run audit`（tools/audit.mjs，取代旧 omdsh-dev/dsh-plugin-check 方案）

``	ext
> node tools/audit.mjs .


===== dsh-zotero 运行时审计：C:\Vibe Coding\dsh-zotero =====
  ✔ 包名 dsh-zotero
  ✔ 版本 0.2.2
  ✔ description 存在
  ✔ dsh.bundle.patch → ./cordis.patch.yml
  ✔ files 含 lib
  ✔ files 含 cordis.patch.yml
  ✔ files 含 locale（插件管理器标题/描述）
  ✔ engines.node >=20
  ✔ 无依赖侧生命周期脚本（pnpm 10 免白名单直装）
  ✔ lib/index.js 已入库（即装即用）
  ✔ lib/ 不落后于 src/
  ✔ patch 注入 1 行（tool-zotero）
  ✔ locale/en.json title/description 齐全
  ✔ locale/zh-CN.json title/description 齐全
  ✔ 未声明 @deepseek-ai/dsh(-*) peer：与任何 DSH 版本都通过兼容门禁
  ✔ 真实 dsh-tools 门禁：9 个工具全部通过注册校验，Config schema 接受空配置与全键配置
-----
通过 16 · 警告 0 · 失败 0
``

## 结论

16 项全部通过、0 警告。9 个工具在真实 DSH 注册表上注册并执行成功；Config schema 接受空配置与全部文档化键；lib/ 为入库的预构建产物；不声明任何生命周期脚本（pnpm 10 免白名单直装）。

## 0.2.2 修订说明

实测 Zotero 本地 API（9.0.6）对否定 itemType 语法（`-attachment -note`）解析不可靠：`itemType='-attachment -note'` 实际只排除了批注，2445 个附件仍计入结果与 `Total-Results`。`zotero_search`（未显式指定类型时）与 `zotero_recent` 已改为 `/items/top` 顶层端点，总数与分页恢复正确；契约测试的 mock 增加 `/items/top` 路由防回归。
