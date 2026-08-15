# dsh-zotero 插件审计报告

**审计工具**：`@deepseek-ai/dsh-plugin-check@0.0.1`（`omdsh-dev/dsh-plugin-check`）
**审计日期**：2026-08-15
**DSH 版本**：0.1.0-rc.6
**审计对象**：`plugins/zotero/`（cordis bundle 形态）
**最终结论**：✅ **PASS**（18/19 检查项通过，1 项跳过为网络问题）

---

## 1. 审计工具安全审查（前置）

`@deepseek-ai/dsh-plugin-check` 通过源码审计确认是**纯只读健康检查插件**：

| 审计维度 | 结论 |
|---|---|
| 注册的工具 | 1 个（`plugin_check`，3 个 action） |
| 文件写操作 | **0**（仅 `fs.readFile`） |
| 网络出站 | **仅 `execFile('gh', ...)`**，5 秒超时（hub catalog 探测） |
| Shell 风险 | `execFile` 参数数组，无 shell 注入 |
| 路径围栏 | 严格：`..`/绝对路径/symlink/junction 全拒，realpath 双重校验 |
| 资源预算 | 400 文件 / 4MB / 8 层目录 |
| npm 生产依赖 | **0**（仅 peerDeps 声明接口） |
| 凭证读取 | 无（仅读 `DSH_HUB_SOURCE` 配置路径） |

**审计 PASS ✅，安全可信。**

---

## 2. 自动检测 vs 强制 bundle

dsh-zotero 是 **cordis bundle 形态**（含 `cordis.patch.yml`），但同时含 `dsh.plugin.json`（cordis bundle 的元信息文件），导致 plugin-check 的 `detectKind()` 优先把它识别为 registry 形态。

| 形态 | verdict | pass / fail / warn / skip |
|---|---|---|
| **registry**（自动检测） | ❌ FAIL | 7 / 2 / 0 / 1 |
| **bundle**（修复前） | ⚠ WARN | 15 / 0 / 3 / 1 |
| **bundle**（**修复后**） | ✅ **PASS** | **18 / 0 / 0 / 1** |

**结论**：修复后 zotero 在真实形态下零 error、零 warning。

---

## 3. 已修复的 Warnings

### ✅ W1: `incomplete-files` — `files` 缺少 `src`

**修复后**：
```json
"files": ["lib", "src", "cordis.patch.yml", "dsh.plugin.json", "README.md", "LICENSE"]
```

发布源码 `src/` 让消费者可以审计 / 重建（`npm pack --dry-run` 确认打包 26 个文件正常）。

---

### ✅ W2: `missing-peer` — `peerDependencies` 未声明

**修复后**：
```json
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1"
}
```

声明出"这是个 cordis 插件"的契约。

---

### ✅ W3: `no-build-script` — 缺 `scripts.prepack`

**修复后**：
```json
"scripts": {
  "build": "tsc",
  "prepare": "tsc",
  "prepack": "tsc",
  "prepublishOnly": "pnpm run build",
  ...
}
```

`prepack` 是 npm/pnpm 9+ 在 `npm pack` 时触发的钩子，让 `npm pack` 用户也能拿到构建产物。

---

## 4. Hub Catalog 检查（skipped）

`hub catalog 不可达（无本地 catalog 且 gh 调用失败）` —— 非仓库问题。

如需启用 hub 检查：
- 设置环境变量 `DSH_HUB_SOURCE` 指向本地 `catalog.source.json`
- 或安装并登录 [GitHub CLI](https://cli.github.com/)，plugin-check 会用 `gh api` 读 `dsh-external/hub` 的 catalog

---

## 5. 修复变更摘要

| 字段 | 变更 |
|---|---|
| `files` | `+ "src"`（共 6 项） |
| `peerDependencies` | 新增 `{ "@deepseek-ai/cordis": "^4.0.1" }` |
| `scripts.prepack` | 新增 `"tsc"` |
| `scripts.audit` | 新增（`node tools/audit-with-plugin-check.mjs . --kind=bundle`） |

### 验证结果

```
$ npm run audit
verdict: PASS
checks: 18 pass / 0 fail / 0 warn / 1 skip

$ npx tsc --noEmit
(无输出, 退出码 0)

$ npm pack --dry-run
npm notice Tarball Contents
npm notice 1.1kB LICENSE
npm notice 6.5kB README.md
npm notice 1.1kB cordis.patch.yml
npm notice 262B dsh.plugin.json
npm notice lib/*.js  lib/*.d.ts
npm notice src/*.ts
... 26 files total
```

---

## 6. 审计方法学（可复用）

```bash
# 1. 装插件到隔离 profile（首次）
dsh --profile audit-tmp plugin add github:omdsh-dev/dsh-plugin-check

# 2. 在任意 plugin 目录跑审计
npm run audit
# 或：node tools/audit-with-plugin-check.mjs . --kind=bundle

# 3. 清理隔离 profile（可选）
rmdir $env:USERPROFILE\.dsh\profiles\audit-tmp
```

详见 `tools/audit-with-plugin-check.mjs`。

---

## 7. 横向对比

`dsh-scientific` monorepo 5 个插件的合规状态：

| Plugin | peerDeps | prepack | files 项数 | 状态 |
|---|---|---|---|---|
| `dsh-zotero` | ✅ | ✅ | 6 | **PASS** ✅ |
| `dsh-chimerax` | ❌ | ❌ | 4 | 骨架（无 apply） |
| `dsh-gromacs` | ❌ | ❌ | 4 | 骨架（无 apply） |
| `dsh-pymol` | ❌ | ❌ | 4 | 骨架（无 apply） |
| `dsh-vina` | ❌ | ❌ | 4 | 骨架（无 apply） |

骨架插件不注册工具所以不算 fail —— 等它们补 `apply` 后需要重新走这个清单。
