# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **TypeScript GitHub Action** (`runs.using: node24`) that resolves `pass://vault/item/field` URI references from a Proton Pass vault and exposes them as env vars and step outputs. The action wraps the official `pass-cli` binary; all logic lives in `src/` and ships as committed esbuild bundles in `dist/`.

## Common commands

```bash
npm ci                # install (node >= 24 required for native TS test runs)
npm run typecheck     # tsc --noEmit (TS7 strict; NEVER emit with tsc)
npm run lint          # oxlint (typescript-eslint type-aware rules don't support TS7 yet)
npm run build         # esbuild → dist/index.js + dist/cleanup.js (committed artifacts)
npm test              # node:test — unit + integration (integration runs the BUILT dist/)
npm run test:coverage # unit suites with the coverage gate CI enforces (85/85/75 lines/branches/functions)
npm run build:check   # typecheck + build + test, the pre-push gate
npm run test:workflow # mock action workflow through pinned agent-ci
npm run verify        # build:check + lint + local workflow simulation

# Run one test file
node --test tests/unit/resolver.test.ts

# Full workflow simulation with the official Actions runner
npm run test:workflow
```

Integration tests execute `dist/index.js`, so **run `npm run build` before `npm test`** after changing `src/`. CI fails if `dist/` is stale relative to `src/` (dist-freshness job).
`.github/workflows/e2e-real.yml` is the only workflow that exercises the real installer and vault (on all five supported platforms); all other tests use the mock CLI.
Workflows pin every action to a full commit SHA, and the `workflows` job in `test.yml` runs actionlint and zizmor on them; accepted zizmor exceptions live in `.github/zizmor.yml`, each with its reason.

## Architecture

Domain model first, then orchestration:

- `src/domain/` — `PassUri` (parse + classify: literal / field-glob / invalid wildcards; greedy vault parity with the old bash regex), `InstallerSpec`, `ResolutionReport` (failures carry name + URI + error, never values), `agent-reason` (audit reason per read: `<purpose>: <run context>`, cut to pass-cli's 300 chars).
- `src/installer/` — platform detection (5 targets incl. `windows-x86_64`); **GitHub Releases** as the only source: `release.ts` builds asset URLs, resolves `latest` via the `/releases/latest` 302 `Location` (no REST API → no rate limit), and takes the expected SHA-256 from the caller's `hash` input or the asset's `.sha256` sidecar; `install.ts` downloads, **fail-closed verifies** (mismatch deletes the file; no expected hash ⇒ abort), caches, `addPath`. `DEFAULT_PASS_CLI_VERSION` (pinned) applies when the input is empty. Pre-installed policy: unset/`latest` accept any `pass-cli` on PATH (this is how tests inject the mock); explicit versions must match `--version` output or are reinstalled. Proton's `versions.json` is NOT used — it is latest-only.
- `src/session/` — session dir setup (symlink-rejected, 0700) and login **bound to the PAT identity**: a SHA-256 fingerprint of the PAT is stored in the session dir; a valid session with a different/unknown fingerprint is logged out and replaced. Session ownership is saved before login so the post step cleans only the exact directory this invocation created. With `export-env: false` the session is step-scoped: never exported to `$GITHUB_ENV`, and ended (logout + dir removal + state cleared) in main's `finally` when the action created the dir; a pre-existing `PROTON_PASS_SESSION_DIR` is left for the post step.
- `src/resolver/` — env scan (full 3-segment URIs only; others silently ignored), literal + glob resolution, suffix sanitization, and collision detection (within one glob and across references, case-insensitive).
- `src/export/` — masks (whole value + per line) then writes via `core.setOutput`/`core.exportVariable` **only** — never raw appends to `$GITHUB_OUTPUT`/`$GITHUB_ENV` (heredoc protocol keeps multiline secrets intact).
- `src/template/` — `pass-cli inject --force` template rendering; output path = explicit input > strip `.template`/`.tpl` > `+.resolved`. The template is read before rendering; masking recovers each injected value by matching the output against the template's literal text (falls back to `KEY=` lines with a warning). Template failures are hard errors regardless of `strict`.
- `src/pass-cli.ts` — the single exec wrapper: silent output capture, `--` separator before every positional URI.
- `src/index.ts` (main) / `src/cleanup.ts` (post; always runs, never fails the job).

Key cross-cutting points:

- **The action reads `pass://` URIs from its own step's `env:` block, not from inputs.** Callers set `env: KEY: "pass://..."` on the action step.
- **Resolved values are the stored bytes.** pass-cli prints a value plus one `\n` (`println!`); `stripPrintNewline` in `src/resolver/resolver.ts` removes exactly that newline and nothing else, so PEM/SSH keys keep their own final newline. Never trim beyond that.
- **`export-env` defaults to `true`** (unlike upstream protonpass/load-secret-action) to preserve this action's env-var contract. Step outputs (per-var + `resolved-keys`) are always written.
- **Masking is opt-out** (`mask-values: true` default); the PAT is always masked.
- **Boolean inputs fail closed:** `true`/`false` in any case, anything else fails the step (no fallback is safe for every input).
- **Every `item view` and `inject` carries `PROTON_PASS_AGENT_REASON`** so agent tokens work; pass-cli never reads or sends it for plain PATs. Context precedence: `agent-reason` input > step env > run description.
- `resolved-keys` is written **before** a strict-mode failure so `if: always()` steps can inspect it.

## Testing model

`tests/fixtures/mock-pass-cli.mjs` is the test double for the real `pass-cli` (real one needs Proton Pass Plus+). `tests/helpers/mock-cli.ts` materializes it onto PATH cross-platform (sh shim on POSIX, `.cmd` on Windows). `tests/helpers/run-action.ts` spawns the built bundles with `INPUT_*` env vars and parses temp `$GITHUB_ENV`/`$GITHUB_OUTPUT` files (heredoc-aware: `tests/helpers/file-commands.ts`).

- `tests/unit/` — import `src/*.ts` directly (node's native type stripping; relative imports need explicit `.ts` extensions).
- `tests/integration/` — the ported bash behavioral spec (22 scenarios) + regression tests for the five critical fixes, run against `dist/`.
- Mock new URI shapes by adding entries in `tests/fixtures/mock-pass-cli.mjs` (`ITEM_JSON` / `FIELD_VALUES`, `INJECT_VALUES` for templates). `MOCK_PASS_CLI_AGENT=true` makes reads enforce agent-session reason rules; `MOCK_PASS_CLI_CALL_LOG=<file>` records every invocation in order (args, reason, session dir). The mock mirrors real CLI behavior that the action depends on: `--version` prints `Proton Pass CLI <x.y.z> (<hash>)`, and `inject` refuses to overwrite an existing file without `--force`. Check new assumptions against the pass-cli source and record them in `docs/CLI-VERIFICATION.md`.
- `tests/fixtures/install-mock.mjs` installs the mock in smoke workflows via `$GITHUB_PATH`.

## Constraints worth remembering

- The rewrite ships on the v1 line: `v1.1.0` moves the floating `v1` tag to it, `v1.0.0` stays the bash composite. Every v1 input keeps its meaning; treat incompatible `action.yml` input changes as breaking. Known accepted deviations are listed in `CHANGELOG.md`.
- TS7: `tsc` is typecheck-only (`--noEmit`); bundling is esbuild's job. Keep `erasableSyntaxOnly` (no enums/namespaces) so node can run the TS sources directly in tests.
- The URI parse is greedy (`.+/.+/.+`): vault/item names containing `/` misparse (extra segments join the vault).
- Secrets must never appear in logs, error messages, reports, or `resolved-keys` — names and URIs only. Values reach `$GITHUB_OUTPUT`/`$GITHUB_ENV` exclusively through `@actions/core`.
