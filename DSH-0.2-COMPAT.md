# DSH 0.2 compatibility notes

This revision targets the DSH 0.2 tool-plugin contract, audited against `@deepseek-ai/dsh@0.2.0-rc.1` (2026-09-29).

## Result

The Zotero tool implementations do not require an API rewrite for DSH 0.2. The plugin still uses supported contracts:

- module-level `export const inject = ['tools']`;
- `ctx.tools.register({...})` with raw JSON Schema parameters;
- mandatory `output.schema` + `output.render`;
- `execute(args, exec)` and `exec.agent.session.header.cwd` for the session workspace.

The main compatibility risk was packaging rather than the nine tool bodies. The package entry is `lib/index.js`, while the previous repository ignored `lib/` and depended on `prepare: tsc` during Git installation. pnpm 10 can block Git dependency build scripts, causing the plugin to look incompatible even though the runtime API is still valid.


## Changes in 0.1.3

- Replaces the unsupported two-value negative `itemType=-attachment -note` query with a single server-side `-attachment` filter plus client-side `note` filtering and refill pagination.
- Fixes Zotero 7+ storage discovery to prefer `<profile>/storage` while retaining the legacy `<profile>/zotero/storage` fallback.
- Maps Zotero 10 HTTP 428 write rejection (`Zotero-Server-ID not provided`) to the existing friendly read-only error used by the smoke test.
- Ships `skills/paper-reading/SKILL.md` in the published package.

## Changes in 0.1.2

- Removes nested `undefined` values from Zotero item/note/attachment outputs so DSH remote JSON validation accepts full-mode results.
- Paginates collections and child items beyond 100 rows.
- Validates collection keys before collection-scoped searches.
- Moves default attachment/note exclusion into the Zotero API query and paginates client-side year filtering until the requested result count is filled.

## Changes in 0.1.1

- Keep `lib/` in the repository so a Git/profile installation is self-contained.
- Remove the `prepare` script; publishing still rebuilds through `prepack`.
- Keep `dsh.bundle.patch` as the current DSH bundle activation mechanism.
- Synchronize the legacy `dsh.plugin.json` metadata with `inject: ["tools"]` for older tooling that still reads it. DSH 0.2 activation itself is driven by `package.json` + `cordis.patch.yml`.
- Add a package-layout test to ensure future releases do not accidentally reintroduce a Git-install build dependency.

## Validation

Run:

```sh
npm install
npm test
npm pack
```

Then install the generated tarball into a disposable DSH 0.2 profile and start the real profile, because `--dump-config` verifies composition but does not import every plugin module:

```sh
dsh plugin --profile zotero-test add ./dsh-zotero-0.1.3.tgz
dsh --profile zotero-test --dump-config
dsh --profile zotero-test
```

For the Web profile, replace `zotero-test` with `web` after the disposable-profile check succeeds.
