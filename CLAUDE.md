# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **composite GitHub Action** that resolves `pass://vault/item/field` URI references from a Proton Pass vault and exposes them as step outputs or env vars. There is no compiled application — the action is glue around the official `pass-cli` binary plus bash scripts in `scripts/`.

## Common commands

```bash
# Lint every bash script
shellcheck scripts/*.sh tests/*.sh

# Run the bash test suite directly (uses the mock pass-cli; no Proton account needed)
bash tests/run-local-tests.sh

# Simulate the full GitHub workflow locally with the official Actions runner
npx @redwoodjs/agent-ci run --workflow tests/test-workflow.yml
```

There is no single-test selector; `run-local-tests.sh` runs all numbered tests sequentially. To run one, comment out the others or copy the block.

## Architecture

The action is defined in `action.yml` as 5 composite steps that run in order:

1. **install-cli.sh** — installs `pass-cli` to `~/.local/bin` and appends to `$GITHUB_PATH`. Uses Proton's `install.sh` for `latest`, or downloads a pinned binary and verifies against `versions.json` SHA-256 when a version is specified.
2. **Authenticate** (inline in action.yml) — runs `pass-cli login` non-interactively, reading `PROTON_PASS_PERSONAL_ACCESS_TOKEN` from env. Then `pass-cli info` confirms the token resolved to a session. `PROTON_PASS_KEY_PROVIDER=fs` is required so the session persists across steps.
3. **resolve-secrets.sh** — iterates over `env()`, regex-matches `^pass://(.+)/(.+)/(.+)$`, calls `pass-cli view` for each, and writes results to `$GITHUB_ENV` using random heredoc delimiters (`EOF_<hex>`) so multiline secrets (e.g. SSH keys) survive intact. Masks each line individually via `::add-mask::` so multiline values are fully redacted. Env-var-only — composite actions can't emit dynamic step outputs, so we don't try.
4. **inject-template.sh** — only runs if `env-template` input is set. Delegates `{{ pass://... }}` substitution to `pass-cli inject -i <template> -o <output>`. Output path strips `.template` / `.tpl`, else appends `.resolved`. Masks values by re-reading the resolved file.
5. **cleanup.sh** — runs with `if: always()`. Calls `pass-cli logout` and removes `~/.local/share/proton-pass-cli/.session/`.

Key cross-cutting points:

- **The action reads `pass://` URIs from its own step's `env:` block, not from inputs.** That's why callers set `env: KEY: "pass://..."` on the action step.
- **Session state flows between steps via the filesystem** (`PROTON_PASS_KEY_PROVIDER=fs`). Every script that touches pass-cli must export this env var.
- **Masking is opt-out** (`mask-values: true` default). When disabled in tests, secret values appear in logs.

## Testing model

`tests/mock-pass-cli.sh` is the test double for the real `pass-cli`. It pattern-matches the URI in `pass-cli view` and returns deterministic strings (`mock-db-password-12345`, etc.). The mock is installed onto `PATH` ahead of the real binary by `run-local-tests.sh`. For workflow-level simulation, `tests/test-workflow.yml` copies the mock onto the runner's `/usr/local/bin/pass-cli` before invoking the action.

When adding a new test:
- Use `env -i PATH=... HOME=... ...` to give resolve-secrets.sh a clean env — otherwise stray vars from your shell leak into the resolver.
- Mock new URI shapes by adding a case branch in `tests/mock-pass-cli.sh`.
- Run `shellcheck scripts/*.sh tests/*.sh` to catch regressions before pushing.

## Constraints worth remembering

- The action is consumed via `uses: gizmodlabs/load-secrets-proton-pass@v1` — changes to `action.yml` inputs are breaking unless defaults preserve old behavior.
- `pass-cli` requires Proton Pass Plus+; tests must use the mock.
- The URI regex is greedy (`.+/.+/.+`); vault/item/field names containing `/` will misparse.
