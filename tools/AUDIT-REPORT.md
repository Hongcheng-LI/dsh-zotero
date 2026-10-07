# dsh-zotero 运行时审计报告

- **日期**：2026-10-07（0.2.1 修订：移除 prepare 生命周期脚本）
- **目标运行时**：DSH 0.2.0-rc.2（桌面版 44.0.0 内核，@deepseek-ai/dsh-tools@0.2.0-rc.2 真实注册表校验）
- **工具**：`npm run audit`（tools/audit.mjs，取代旧 omdsh-dev/dsh-plugin-check 方案）

``	ext
> node tools/audit.mjs .


===== dsh-zotero 运行时审计：C:\Vibe Coding\dsh-zotero =====
  ✔ 包名 dsh-zotero
  ✔ 版本 0.2.1
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

16 项全部通过、0 警告。9 个工具在真实 DSH 注册表上注册并执行成功；Config schema 接受空配置与全部文档化键；lib/ 为入库的预构建产物；**不声明任何生命周期脚本**——pnpm 10 对声明 prepare 的 git 依赖会硬性拒装（ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED，实测于桌面 profile 安装），移除后可免白名单直装。
