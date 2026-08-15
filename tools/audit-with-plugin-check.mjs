// 直接调用 dsh-plugin-check 的核心函数，对当前 zotero 插件做体检
// 用法：node tools/audit-with-plugin-check.mjs [path]
// 依赖：@deepseek-ai/dsh-plugin-check 不在 npm registry（GitHub-only），
//   首次运行前手动安装：npm i -D github:omdsh-dev/dsh-plugin-check
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let check
try {
  check = {
    detectKind: require('@deepseek-ai/dsh-plugin-check/lib/form.js').detectKind,
    checkManifest: require('@deepseek-ai/dsh-plugin-check/lib/manifest.js').checkManifest,
    checkPatch: require('@deepseek-ai/dsh-plugin-check/lib/patch.js').checkPatch,
    checkBuildPitfalls: require('@deepseek-ai/dsh-plugin-check/lib/build-check.js').checkBuildPitfalls,
    checkRegistry: require('@deepseek-ai/dsh-plugin-check/lib/registry.js').checkRegistry,
    checkHubStatus: require('@deepseek-ai/dsh-plugin-check/lib/hub.js').checkHubStatus,
    resolveRepoIdentity: require('@deepseek-ai/dsh-plugin-check/lib/hub.js').resolveRepoIdentity,
    checkProfileInstallDocs: require('@deepseek-ai/dsh-plugin-check/lib/ecosystem.js').checkProfileInstallDocs,
    checkCoreRowIds: require('@deepseek-ai/dsh-plugin-check/lib/ecosystem.js').checkCoreRowIds,
    isBundleInstallable: require('@deepseek-ai/dsh-plugin-check/lib/ecosystem.js').isBundleInstallable,
    parsePatchSections: require('@deepseek-ai/dsh-plugin-check/lib/patch.js').parsePatchSections,
    buildRepoReport: require('@deepseek-ai/dsh-plugin-check/lib/report.js').buildRepoReport,
  }
} catch {
  console.error('[audit] 缺少 @deepseek-ai/dsh-plugin-check。先装：\n  npm i -D github:omdsh-dev/dsh-plugin-check')
  process.exit(1)
}

const target = resolve(process.argv[2] ?? '.')
const forceKind = process.argv[3] // optional: --kind=bundle | --kind=tool-bundle

async function main() {
  console.log(`[audit] target: ${target}`)
  const kind = forceKind ? forceKind.replace('--kind=', '') : await check.detectKind(target)
  console.log(`[audit] detected kind: ${kind}${forceKind ? ' (forced)' : ''}`)
  const repo = await check.resolveRepoIdentity(target)
  console.log(`[audit] repo identity: ${repo}`)
  const issues = []

  if (kind === 'registry') {
    issues.push(...await check.checkRegistry(target))
  } else if (kind === 'bundle' || kind === 'tool-bundle') {
    const { issues: m, pkg } = await check.checkManifest(target)
    issues.push(...m)
    if (pkg !== null) {
      const p = await check.checkPatch(target, kind, pkg.name)
      issues.push(...p)
      issues.push(...await check.checkBuildPitfalls(target, pkg))
      const coreIds = await checkCoreRowIdsOf(target)
      issues.push(...coreIds)
      const docs = await check.checkProfileInstallDocs(target, kind)
      issues.push(...docs)
      const hasPatchDecl = pkg.dsh?.bundle?.patch !== undefined
      if (!check.isBundleInstallable(hasPatchDecl, docs)) {
        issues.push({ code: 'manual-install-only', detail: '无法通过标准 Profile Bundle 安装' })
      }
    }
  }

  // hub status (skipped if no gh)
  if (kind !== 'unknown' && kind !== 'infra') {
    const hub = await check.checkHubStatus(repo, kind)
    issues.push(...hub.issues)
  }

  const report = check.buildRepoReport(repo, target, kind, issues, false)
  console.log('\n========== REPORT ==========')
  console.log(JSON.stringify(report, null, 2))
  console.log('============================\n')
  console.log(`verdict: ${report.verdict.toUpperCase()}`)
  console.log(`checks: ${report.checks.passed} pass / ${report.checks.failed} fail / ${report.checks.warned} warn / ${report.checks.skipped} skip`)
  if (report.errors.length > 0) {
    console.log('\nERRORS:')
    for (const e of report.errors) console.log(`  [${e.code}] ${e.detail}`)
  }
  if (report.warnings.length > 0) {
    console.log('\nWARNINGS:')
    for (const w of report.warnings) console.log(`  [${w.code}] ${w.detail}`)
  }
  if (report.suggestions.length > 0) {
    console.log('\nSUGGESTIONS:')
    for (const s of report.suggestions) console.log(`  - ${s}`)
  }
}

async function checkCoreRowIdsOf(dir) {
  try {
    const fs = await import('node:fs/promises')
    const { join } = await import('node:path')
    const text = await fs.readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    const entries = check.parsePatchSections(text).flatMap(s => s.entries)
    return check.checkCoreRowIds(entries)
  } catch { return [] }
}

main().catch(err => {
  console.error('AUDIT FAILED:', err.message)
  console.error(err.stack)
  process.exit(1)
})
