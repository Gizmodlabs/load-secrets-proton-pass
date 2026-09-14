# TypeScript node24 Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bash composite action with a TypeScript 7 / node24 JavaScript action that merges upstream `protonpass/load-secret-action` plumbing with this repo's features, fixing five known bugs.

**Architecture:** Domain-model-first TypeScript under `src/` (domain → installer → session → resolver → export → template), bundled with esbuild into committed `dist/index.js` (main) and `dist/cleanup.js` (post). All `pass-cli` calls go through one safe exec wrapper (`--` separator, silent output capture). Tests are `node:test` with node24 native type stripping: unit tests import `src/` directly; integration tests spawn the built `dist/` bundles against a cross-platform mock `pass-cli`.

**Tech Stack:** TypeScript 7.0 (strict, `tsc --noEmit` only), esbuild bundling (`--platform=node --target=node24`), oxlint, `@actions/core` / `@actions/exec` / `@actions/http-client` / `@actions/tool-cache`, `node:test`.

## Global Constraints

- `runs.using: node24`; no node20 support.
- Never emit with `tsc`; typecheck only (`tsc --noEmit`). Bundle with esbuild.
- `core.setSecret()` on PAT immediately at read; on every resolved value before any export (when masking on; PAT always masked).
- Only `core.setOutput()` / `core.exportVariable()` write outputs/env — never raw appends to `$GITHUB_OUTPUT`/`$GITHUB_ENV` (fix #1).
- Installer fails closed: no expected hash ⇒ abort; mismatch ⇒ abort; no unverified binary ever runs (fix #2).
- Session bound to PAT identity via SHA-256 fingerprint file in session dir; mismatch ⇒ logout + fresh login (fix #3).
- `post:` cleanup always runs, logs out, warns (never fails) on error (fix #4).
- Resolved values preserved byte-exact — no trim, no newline stripping (fix #5).
- `--` argument separator before every positional URI on `pass-cli` invocations.
- Errors/reports/logs/`resolved-keys` carry names + URIs only, never values.
- Public contract preserved: inputs `personal-access-token` (required), `env-template`, `pass-cli-version` (default `2.1.0`), `mask-values` (default `true`), `strict` (default `true`), `output-path`; output `resolved-keys` (sorted, comma-separated, empty string when none). New input `export-env` — **default `true`** (deviation from upstream's `false`, required by "do not regress env vars" + "keep stable for existing users"; documented in MIGRATION.md).
- Per-secret step outputs always emitted via `core.setOutput(name, value)` (upstream mode), masked first.
- The 22 bash test scenarios (63 assertions) in `tests/run-local-tests.sh` are the behavioral spec; port them all.
- Glob rules: `*` only as the whole field segment; vault/item wildcards rejected; partial field wildcards rejected; zero-field glob fails; sanitized-suffix collisions fail listing raw names; empty sanitized suffix fails.
- Sanitization: non-alphanumeric → `_`, collapse runs, strip leading/trailing `_`, uppercase.
- Strict mode: failures annotate as errors and step fails after full scan (resolved-keys still written first); `strict: false` → warnings, vars left unset, step succeeds.
- Template injection independent of strict (hard error on failure); skipped when strict resolution already failed.
- pass:// values with fewer than 3 segments are silently ignored (bash parity).
- Greedy URI parse parity: extra `/` goes to the vault segment (`pass://a/b/c/d` → vault `a/b`, item `c`, field `d`).

## File Structure

```
action.yml                     node24, main: dist/index.js, post: dist/cleanup.js
package.json / package-lock.json / tsconfig.json
src/
  domain/pass-uri.ts           PassUri value object: parse, classify (literal|glob|invalid-*)
  domain/installer-spec.ts     Platform union + InstallerSpec {version, platform, sha256, url}
  domain/resolution.ts         ResolvedSecret, ResolutionFailure, ResolutionReport
  pass-cli.ts                  runPassCli(args): {exitCode, stdout, stderr} via @actions/exec (silent)
  inputs.ts                    ActionInputs reader/validator
  hints.ts                     vault/item/field troubleshooting hints from stderr
  installer/platform.ts        detectPlatform/resolvePlatform (5 valid targets)
  installer/manifest.ts        fetch+parse versions.json; resolve version ('latest' → max semver) → InstallerSpec; FAIL CLOSED
  installer/install.ts         skip-if-present, download (tool-cache), verify sha256, cache, addPath
  session/session.ts           session dir setup (symlink-reject, 0700), PAT fingerprint bind, login/logout, saveState
  resolver/env-scan.ts         findSecretRefs(env) → {name, uri}[]
  resolver/sanitize.ts         sanitizeSuffix(raw)
  resolver/resolver.ts         resolve literal + glob expansion + collision detection → ResolutionReport
  export/exporter.ts           mask → setOutput (+ per-var), exportVariable (opt), resolved-keys
  template/inject.ts           pass-cli inject, output-path derivation, masking of injected values
  main.ts                      orchestration; index.ts entry; cleanup.ts post entry
dist/index.js, dist/cleanup.js (committed esbuild bundles)
tests/
  fixtures/mock-pass-cli.mjs   ported mock + PEM multiline item + '--' handling
  helpers/mock-cli.ts          install mock into temp PATH dir (sh wrapper + .cmd for windows)
  helpers/file-commands.ts     parse GITHUB_ENV/GITHUB_OUTPUT heredoc protocol
  unit/*.test.ts               pass-uri, sanitize, platform, manifest(fail-closed), env-scan, exporter(multiline), session(PAT binding)
  integration/*.test.ts        22 ported scenarios vs dist/index.js; cleanup; multiline PEM regression
.github/workflows/test.yml     typecheck+lint+unit (3 OS), dist-freshness, smoke (3 OS)
MIGRATION.md, README.md, CLAUDE.md updates; scripts/*.sh and run-local-tests.sh removed
```

## Tasks

### Task 1: Scaffold + toolchain
- [x] package.json (type: module; scripts typecheck/build/test/lint/build:check), tsconfig (strict, noEmit, nodenext, allowImportingTsExtensions), pin typescript@7, esbuild, oxlint, @types/node; deps @actions/*.
- [x] Commit.

### Task 2: Domain model (TDD)
- [x] `PassUri.parse(value)`: null for non-matching (incl. <3 segments); greedy vault; `kind: 'literal' | 'field-glob' | 'invalid-vault-item-wildcard' | 'invalid-partial-field-wildcard'`. Unit tests first.
- [x] `sanitizeSuffix`: `'API Key'→'API_KEY'`, `'database-name'→'DATABASE_NAME'`, `'---'→''`. Tests first.
- [x] Platform: `linux-x86_64|linux-aarch64|macos-x86_64|macos-aarch64|windows-x86_64`; detect from process.platform/arch; explicit input validated. Tests.
- [x] Commit per unit.

### Task 3: Installer (fail closed)
- [x] manifest.ts: `resolveInstallerSpec(versionInput, platform, fetchJson)` — parses `{passCliVersions:[{version, urls:{<os>:{<arch>:{url,hash}}}}]}`; latest = max semver; missing manifest/version/platform/hash ⇒ typed error. Tests: unreachable manifest, missing hash, unknown platform, latest resolution, happy path.
- [x] install.ts: skip when `pass-cli --version` contains requested version (or any, for `latest`); download via tool-cache from manifest URL; sha256 via node:crypto; mismatch ⇒ delete + throw (no actual-hash in message); cache + addPath; windows binary named pass-cli.exe. Hash-verify unit tests with temp files.
- [x] Commit.

### Task 4: pass-cli wrapper + session
- [x] pass-cli.ts: `runPassCli(args, opts)` via `getExecOutput('pass-cli', args, {silent: true, ignoreReturnCode: true, env})`.
- [x] session.ts: `establishSession(pat, runner)` — session dir (PROTON_PASS_SESSION_DIR respected, symlink-rejected, 0700; else mkdtemp under RUNNER_TEMP), export vars, fingerprint = sha256(pat); reuse iff `info` ok AND fingerprint file matches; else logout→login→verify info→write fingerprint (0600); saveState('session-dir'). Unit tests with injected fake runner: fresh login, reuse on match, forced relogin on mismatch, login failure message (no PAT in message).
- [x] cleanup.ts: getState → logout (warn-only), rm session dir (warn-only). Never throws.
- [x] Commit.

### Task 5: Resolver + exporter (core behavior)
- [x] env-scan.ts: full-pattern matches only.
- [x] resolver.ts: literal resolve via `item view -- <uri>` (byte-exact stdout); glob via `item view --output json -- pass://v/i` → fields[].name → sanitize → empty-suffix fail, collision fail (both raw names), per-field resolve; failures accumulate `{name, uri, detail}`.
- [x] exporter.ts: mask (whole + per line) when mask-values; always setOutput(name, value); exportVariable when export-env; resolved-keys sorted CSV set before strict failure.
- [x] hints.ts ported.
- [x] Unit tests: exporter multiline PEM through GITHUB_ENV + GITHUB_OUTPUT heredoc roundtrip byte-exact (fix #1/#5 regression).
- [x] Commit.

### Task 6: Template + main orchestration
- [x] template/inject.ts: output path (explicit > strip .template > strip .tpl > +.resolved); `pass-cli inject -i t -o out`; missing template ⇒ error 'Template file not found'; mask values for template lines containing pass://; hard error on inject failure.
- [x] main.ts flow: inputs → setSecret(PAT) → install → session → scan → resolve → export → resolved-keys → (strict fail? setFailed : template if set) → done. index.ts entry.
- [x] Commit.

### Task 7: Bundles + action.yml
- [x] esbuild both entries; action.yml → node24 main/post; delete scripts/*.sh.
- [x] Commit (dist committed).

### Task 8: Integration tests (port the 63)
- [x] mock-pass-cli.mjs port (+ PEM item `GithubActions/ssh-key-item/private-key`, `--` handling, `--output json` cases).
- [x] helpers (mock install w/ windows .cmd, file-command parser).
- [x] Port all 22 scenarios against dist/index.js; cleanup test vs dist/cleanup.js; multiline PEM e2e both modes; export-env=false outputs-only mode; installer fail-closed covered at unit level.
- [x] All green. Commit.

### Task 9: CI + smoke + docs
- [x] .github/workflows/test.yml: typecheck+lint+unit+integration on 3-OS matrix; dist-freshness (`npm run build && git diff --exit-code dist`); smoke job 3-OS using `./` with mock preinstalled (env mode + resolved-keys + template).
- [x] README (node24, new inputs, disclaimer kept), MIGRATION.md, CLAUDE.md rewrite, examples check.
- [x] Commit.

### Task 10: Verify definition of done
- [x] `npm run build:check` clean (typecheck + build + test).
- [x] oxlint clean.
- [x] dist fresh; no secret values in logs/artifacts.
