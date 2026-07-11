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
npm run build:check   # typecheck + build + test, the pre-push gate

# Run one test file
node --test tests/unit/resolver.test.ts

# Full workflow simulation with the official Actions runner
npx @redwoodjs/agent-ci run --workflow tests/test-workflow.yml
```

Integration tests execute `dist/index.js`, so **run `npm run build` before `npm test`** after changing `src/`. CI fails if `dist/` is stale relative to `src/` (dist-freshness job).

## Architecture

Domain model first, then orchestration:

- `src/domain/` — `PassUri` (parse + classify: literal / field-glob / invalid wildcards; greedy vault parity with the old bash regex), `InstallerSpec`, `ResolutionReport` (failures carry name + URI + error, never values).
- `src/installer/` — platform detection (5 supported targets incl. `windows-x86_64`), `versions.json` manifest resolution, download + **fail-closed SHA-256 verification** (no expected hash or a mismatch aborts; an unverified binary never runs). Install is skipped when a matching `pass-cli` is already on PATH — that's how tests inject the mock.
- `src/session/` — session dir setup (symlink-rejected, 0700) and login **bound to the PAT identity**: a SHA-256 fingerprint of the PAT is stored in the session dir; a valid session with a different/unknown fingerprint is logged out and replaced. Session dir is saved to action state for the post step.
- `src/resolver/` — env scan (full 3-segment URIs only; others silently ignored), literal + glob resolution, suffix sanitization + collision detection.
- `src/export/` — masks (whole value + per line) then writes via `core.setOutput`/`core.exportVariable` **only** — never raw appends to `$GITHUB_OUTPUT`/`$GITHUB_ENV` (heredoc protocol keeps multiline secrets intact).
- `src/template/` — `pass-cli inject` template rendering; output path = explicit input > strip `.template`/`.tpl` > `+.resolved`. Template failures are hard errors regardless of `strict`.
- `src/pass-cli.ts` — the single exec wrapper: silent output capture, `--` separator before every positional URI.
- `src/index.ts` (main) / `src/cleanup.ts` (post; always runs, never fails the job).

Key cross-cutting points:

- **The action reads `pass://` URIs from its own step's `env:` block, not from inputs.** Callers set `env: KEY: "pass://..."` on the action step.
- **Resolved values are byte-exact** — no trimming. Trailing newlines from pass-cli are preserved (PEM/SSH keys). Workflow assertions strip one trailing newline: `"${VAR%$'\n'}"`.
- **`export-env` defaults to `true`** (unlike upstream protonpass/load-secret-action) to preserve this action's env-var contract. Step outputs (per-var + `resolved-keys`) are always written.
- **Masking is opt-out** (`mask-values: true` default); the PAT is always masked.
- `resolved-keys` is written **before** a strict-mode failure so `if: always()` steps can inspect it.

## Testing model

`tests/fixtures/mock-pass-cli.mjs` is the test double for the real `pass-cli` (real one needs Proton Pass Plus+). `tests/helpers/mock-cli.ts` materializes it onto PATH cross-platform (sh shim on POSIX, `.cmd` on Windows). `tests/helpers/run-action.ts` spawns the built bundles with `INPUT_*` env vars and parses temp `$GITHUB_ENV`/`$GITHUB_OUTPUT` files (heredoc-aware: `tests/helpers/file-commands.ts`).

- `tests/unit/` — import `src/*.ts` directly (node's native type stripping; relative imports need explicit `.ts` extensions).
- `tests/integration/` — the ported bash behavioral spec (22 scenarios) + regression tests for the five critical fixes, run against `dist/`.
- Mock new URI shapes by adding entries in `tests/fixtures/mock-pass-cli.mjs` (`ITEM_JSON` / `FIELD_VALUES`).
- `tests/fixtures/install-mock.mjs` installs the mock in smoke workflows via `$GITHUB_PATH`.

## Constraints worth remembering

- The action is consumed via `uses: gizmodlabs/load-secrets-proton-pass@v1` — changes to `action.yml` inputs are breaking unless defaults preserve old behavior.
- TS7: `tsc` is typecheck-only (`--noEmit`); bundling is esbuild's job. Keep `erasableSyntaxOnly` (no enums/namespaces) so node can run the TS sources directly in tests.
- The URI parse is greedy (`.+/.+/.+`): vault/item names containing `/` misparse (extra segments join the vault).
- Secrets must never appear in logs, error messages, reports, or `resolved-keys` — names and URIs only. Values reach `$GITHUB_OUTPUT`/`$GITHUB_ENV` exclusively through `@actions/core`.
