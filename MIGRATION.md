# Migrating from the bash composite action (v1) to the node24 action (v2)

v2 rewrites the action in TypeScript running on the `node24` GitHub Actions
runtime. The public contract is preserved: existing workflows keep working
without changes. This note lists the exact parity guarantees and the few
deliberate behavior changes.

## What stays the same

- **Inputs:** `personal-access-token` (required), `env-template`,
  `pass-cli-version` (default `2.1.0`), `mask-values` (default `true`),
  `strict` (default `true`), `output-path` — unchanged names, defaults, and
  semantics.
- **Env-var loading:** every `pass://vault/item/field` value in the step's
  `env:` block is resolved and exported for subsequent steps (still the
  default — see `export-env` below).
- **Field globs:** `pass://vault/item/*` expands to `<PREFIX>_<FIELD>` env
  vars with the same sanitization (non-alphanumeric → `_`, collapse, trim,
  uppercase), the same collision detection (two fields sanitizing to the
  same suffix fail listing both raw names), and the same rejection of
  wildcards outside the field segment.
- **Strict mode:** unresolved URIs fail the step after a full scan with a
  `NAME -> pass://uri (error)` report (names and URIs only, never values);
  `strict: false` demotes failures to warnings and leaves the vars unset.
- **Template injection:** `env-template` renders `{{ pass://... }}`
  placeholders; output path is `output-path`, else strips
  `.template`/`.tpl`, else appends `.resolved`. Template failures are hard
  errors regardless of `strict`.
- **`resolved-keys` output:** sorted, comma-separated names; empty string
  when nothing resolved; written even when strict mode fails the step.
- **Cleanup:** logout always runs, now as a real `post:` step (equivalent
  to `if: always()`), and never fails the job.

## New in v2

- **`export-env` input (default `true`).** Set to `false` to skip env-var
  export and consume secrets only as step outputs. Note: the upstream
  `protonpass/load-secret-action` defaults this to `false`; this action
  defaults to `true` so v1 workflows that read env vars keep working.
- **Per-variable step outputs.** Every resolved variable is also published
  as a masked step output: `steps.<id>.outputs.<NAME>` — including
  glob-expanded names.
- **Fail-closed installer.** v1 continued with an unverified binary when
  `versions.json` was unreachable or listed no hash. v2 aborts unless the
  downloaded `pass-cli` matches the SHA-256 listed in Proton's
  `versions.json`. `pass-cli-version: latest` now also resolves through the
  manifest and is verified (v1 piped Proton's `install.sh` to bash,
  unverified).
- **Session bound to the token.** If a `pass-cli` session already exists on
  the runner but was created from a different PAT, v2 forces a fresh login
  instead of silently reusing it.
- **Windows support.** v1 was bash-only (linux/macos). v2 runs on
  `windows-x86_64` as well.

## Behavior changes to be aware of

- **Values are byte-exact (no trimming).** v1's bash command substitution
  stripped all trailing newlines from resolved values; upstream's node
  action trimmed all surrounding whitespace. v2 exports exactly the bytes
  `pass-cli` prints — significant for SSH keys, PEM certificates, and
  tokens where the trailing newline matters. If you compared a resolved
  env var with strict string equality (e.g. `[[ "$DB_PASSWORD" == "x" ]]`),
  strip the CLI's trailing newline first: `"${DB_PASSWORD%$'\n'}"`.
- **Secrets appear (masked) in `$GITHUB_OUTPUT`.** Because every resolved
  variable is now a step output, values are written to the runner's output
  file via `core.setOutput()`'s delimiter protocol. They are registered
  with the log masker first and never appear in logs.
- **Runtime is node24.** The action no longer needs bash on the runner and
  does not support the removed node20 runtime.
