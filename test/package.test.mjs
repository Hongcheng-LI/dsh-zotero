import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const legacyManifest = JSON.parse(readFileSync(resolve(root, 'dsh.plugin.json'), 'utf8'))

test('package is self-contained for Git/profile installation', () => {
  assert.equal(pkg.version, '0.1.3')
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(existsSync(resolve(root, pkg.main)), 'compiled lib/index.js must be checked in')
  assert.equal(pkg.scripts.prepare, undefined, 'Git install must not require a prepare build')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok((pkg.files ?? []).includes('skills'), 'skills/ must be included in the published package')
  assert.ok(existsSync(resolve(root, 'skills/paper-reading/SKILL.md')), 'paper-reading skill must exist')
})

test('legacy plugin metadata stays consistent with runtime exports', () => {
  assert.equal(legacyManifest.version, pkg.version)
  assert.deepEqual(legacyManifest.entry?.inject, ['tools'])
})
