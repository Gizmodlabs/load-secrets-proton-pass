# Changelog

## 1.1.0 (unreleased)

The action is now a TypeScript action on the `node24` GitHub Actions runtime
(`dist/index.js` as `main`, `dist/cleanup.js` as `post`). It replaces the bash
composite implementation shipped in 1.0.0. The floating `v1` tag moves to this
release: existing `uses: gizmodlabs/load-secrets-proton-pass@v1` workflows keep
working without changes. `v1.0.0` remains the bash implementation.

### What stays the same

- **Inputs:** `personal-access-token`, `env-template`, `pass-cli-version`,
  `mask-values`, `strict`, and `output-path` keep their names and meaning.
- **Env-var loading:** every `pass://vault/item/field` value in the step's
  `env:` block is resolved and exported for subsequent steps (still the
  default — see `export-env` below).
- **Field globs:** `pass://vault/item/*` expands to `<PREFIX>_<FIELD>` env
  vars with the same sanitization (non-alphanumeric → `_`, collapse, trim,
  uppercase), the same collision detection (two fields sanitizing to the
  same suffix fail listing both raw names), and the same rejection of
  wildcards outside the field segment. Error messages are unchanged.
- **Strict mode:** unresolved URIs fail the step after a full scan with a
  `NAME -> pass://uri (error)` report (names and URIs only, never values);
  `strict: false` demotes failures to warnings and leaves the vars unset.
- **Template injection:** `env-template` renders `{{ pass://... }}`
  placeholders via `pass-cli inject`; output path is `output-path`, else strips
  `.template`/`.tpl`, else appends `.resolved`. Template failures are hard
  errors regardless of `strict`.
- **`resolved-keys` output:** sorted, comma-separated names; empty string
  when nothing resolved; written even when strict mode fails the step.
- **Single-line secret values** are byte-for-byte what 1.0.0 exported.
- **Cleanup:** logout always runs, now as a real `post:` step (equivalent to
  `if: always()`), and never fails the job.

### New

- **`export-env` input (default `true`).** Set to `false` to skip env-var
  export and consume secrets only as step outputs. (The upstream
  `protonpass/load-secret-action` defaults this to `false`; this action keeps
  `true` so existing workflows are unaffected.)
- **Per-variable step outputs.** Every resolved variable is also published
  as a masked step output: `steps.<id>.outputs.<NAME>` — including
  glob-expanded names.
- **Fail-closed installer, sourced from GitHub Releases.** 1.0.0 piped
  Proton's `install.sh` to bash for `latest` and only verified pinned
  downloads when `versions.json` happened to list a hash. 1.1.0 downloads
  `github.com/protonpass/pass-cli` release assets and refuses to run a binary
  whose SHA-256 does not match the release's `.sha256` asset (or your `hash`
  input). Proton's `versions.json` is no longer used: it describes only the
  latest release, so it cannot verify a pinned version.
- **`hash` and `platform` inputs** (same names and semantics as
  `protonpass/load-secret-action` / `protonpass/install-cli-action`).
- **PAT via environment.** `PROTON_PASS_PERSONAL_ACCESS_TOKEN` on the step is
  accepted when the `personal-access-token` input is empty, so upstream-style
  workflows are drop-in. The input is therefore no longer marked required.
- **Pre-installed CLI is respected.** With `pass-cli-version` unset (or
  `latest`), a `pass-cli` already on PATH — e.g. from
  `protonpass/install-cli-action` — is used as-is.
- **Session bound to the token.** If a `pass-cli` session already exists on
  the runner but was created from a different PAT, the action forces a fresh
  login instead of silently reusing it.
- **Windows support.** 1.0.0 was bash-only (linux/macos). 1.1.0 also runs on
  `windows-x86_64`.

### Behavior changes to be aware of

- **Default `pass-cli` is 2.3.3 (was 2.1.0); minimum 2.1.2.** Releases before
  2.1.2 are not published on GitHub Releases and cannot be verified, so an
  explicit `pass-cli-version: 2.1.0` (or `2.1.1`) now fails with a clear
  error. Leave the input empty, or pin `2.1.2` or newer.
- **An explicit `pass-cli-version` is enforced.** If a different `pass-cli` is
  already on PATH it is replaced. Leave the input empty to accept whatever is
  installed (1.0.0 reinstalled unless the installed version matched `2.1.0`).
- **Multi-line values keep their own trailing newline.** `pass-cli` prints a
  value followed by exactly one newline; the action strips exactly that one.
  1.0.0's bash command substitution stripped every trailing newline, which
  corrupted SSH keys and PEM certificates whose stored content ends with a
  newline. Single-line values are unaffected.
- **Secrets appear (masked) in `$GITHUB_OUTPUT`.** Because every resolved
  variable is now a step output, values are written to the runner's output
  file via `core.setOutput()`'s delimiter protocol. They are registered with
  the log masker first and never appear in logs.
- **Two extra env vars for later steps.** The action exports
  `PROTON_PASS_SESSION_DIR` and `PROTON_PASS_KEY_PROVIDER=fs` so its `post:`
  cleanup (and any `pass-cli` you run yourself later in the job) finds the
  session. The session directory is removed when the job ends.
- **Runtime is node24.** GitHub-hosted runners are ready; self-hosted runners
  need `actions/runner` 2.327.1 or newer. bash is no longer required.

## 1.0.0 (2026-05-25)

- Initial release: bash composite action wrapping `pass-cli` — `pass://` env
  var resolution, field globs, strict mode, template injection,
  `resolved-keys` output.
