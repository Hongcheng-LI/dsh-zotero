// 直接调用 dsh-plugin-check 的核心函数，对当前 zotero 插件做体检
// 用法：node tools/audit-with-plugin-check.mjs [path]
import { resolve } from 'node:path'
import { detectKind } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/form.js'
import { checkManifest } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/manifest.js'
import { checkPatch } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/patch.js'
import { checkBuildPitfalls } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/build-check.js'
import { checkRegistry } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/registry.js'
import { checkHubStatus, resolveRepoIdentity } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/hub.js'
import { checkProfileInstallDocs, checkCoreRowIds, isBundleInstallable } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/ecosystem.js'
import { parsePatchSections } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/patch.js'
import { buildRepoReport, CHECK_SCHEMA } from '../node_modules/@deepseek-ai/dsh-plugin-check/lib/report.js'

const target = resolve(process.argv[2] ?? '../plugins/zotero')
const forceKind = process.argv[3] // optional: --kind=bundle | --kind=tool-bundle

async function main() {
  console.log(`[audit] target: ${target}`)
  const kind = forceKind ? forceKind.replace('--kind=', '') : await detectKind(target)
  console.log(`[audit] detected kind: ${kind}${forceKind ? ' (forced)' : ''}`)
  const repo = await resolveRepoIdentity(target)
  console.log(`[audit] repo identity: ${repo}`)
  const issues = []

  if (kind === 'registry') {
    issues.push(...await checkRegistry(target))
  } else if (kind === 'bundle' || kind === 'tool-bundle') {
    const { issues: m, pkg } = await checkManifest(target)
    issues.push(...m)
    if (pkg !== null) {
      const p = await checkPatch(target, kind, pkg.name)
      issues.push(...p)
      issues.push(...await checkBuildPitfalls(target, pkg))
      const coreIds = await checkCoreRowIdsOf(target)
      issues.push(...coreIds)
      const docs = await checkProfileInstallDocs(target, kind)
      issues.push(...docs)
      const hasPatchDecl = pkg.dsh?.bundle?.patch !== undefined
      if (!isBundleInstallable(hasPatchDecl, docs)) {
        issues.push({ code: 'manual-install-only', detail: '无法通过标准 Profile Bundle 安装' })
      }
    }
  }

  // hub status (skipped if no gh)
  if (kind !== 'unknown' && kind !== 'infra') {
    const hub = await checkHubStatus(repo, kind)
    issues.push(...hub.issues)
  }

  const report = buildRepoReport(repo, target, kind, issues, false)
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
    const entries = parsePatchSections(text).flatMap(s => s.entries)
    return checkCoreRowIds(entries)
  } catch { return [] }
}

main().catch(err => {
  console.error('AUDIT FAILED:', err.message)
  console.error(err.stack)
  process.exit(1)
})
