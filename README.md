<p align="center">
  <img src="docs/assets/logo.svg" alt="Load Secrets from Proton Pass logo" width="160">
</p>

# Load Secrets from Proton Pass

A GitHub Action that loads secrets from [Proton Pass](https://proton.me/pass) vaults into your GitHub Actions workflows using `pass://` URI references.

Works like [1Password's load-secrets-action](https://github.com/1password/load-secrets-action), but backed by Proton Pass.

A TypeScript action on the `node24` runtime; runs on ubuntu, macos, and windows GitHub-hosted runners. Migrating from the bash-based v1? See [MIGRATION.md](MIGRATION.md).

## Quick Start

```yaml
- name: Load secrets
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
  env:
    DATABASE_URL: "pass://Production/Database/connection_string"
    STRIPE_KEY: "pass://Production/Stripe/secret_key"

- name: Deploy
  run: ./deploy.sh   # DATABASE_URL and STRIPE_KEY are in env
```

Each `pass://vault/item/field` value is replaced with the real secret and exported as a regular environment variable for every subsequent step in the job.

## Setup

### 1. Prerequisites

- A [Proton Pass Plus+](https://proton.me/pass) subscription (required for CLI access)
- The [Proton Pass CLI](https://proton.me/support/pass-cli) installed locally (you only need it on your own machine to mint the token — the action installs it on the runner automatically)

### 2. Generate a Personal Access Token

Log in to `pass-cli` on your local machine, then create a scoped, expiring token for CI:

```bash
# Create a named token (90-day expiration in this example)
pass-cli pat create --name "github-actions" --expiration 90d

# Grant it read-only access to each vault it should be able to see.
# IMPORTANT: `pat create` alone gives the token zero vault access — you must
# run this grant for every vault the action needs to read from.
pass-cli pat access grant --pat-name "github-actions" --vault-name "Production" --role viewer
```

The `create` command prints the token in the format `pst_xxxx::TOKENKEY`. **Copy it now — it is shown only once.**

Token tips:
- Scope per-vault with `--role viewer` so the token can read but never write.
- Use short expirations (`30d`, `90d`) and rotate.
- Revoke any time with `pass-cli pat delete --name "github-actions"`.

### 3. Add the GitHub secret

In your repository, go to **Settings → Secrets and variables → Actions** and add:

| GitHub Secret | Description |
|---|---|
| `PROTON_PASS_PERSONAL_ACCESS_TOKEN` | The full `pst_xxxx::TOKENKEY` value from step 2 |

### 4. Reference secrets with `pass://` URIs

Define each secret as an environment variable on the action step using a `pass://` URI:

```
pass://vault-name/item-name/field-name
```

- **vault-name** — name of the Proton Pass vault
- **item-name** — name of the item in the vault
- **field-name** — `password`, `username`, or any custom field name

## Usage

### Environment variables (default)

Every `pass://` env var on the action step is resolved and re-exported as a regular env var available to all subsequent steps in the same job:

```yaml
- name: Load secrets
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
  env:
    DB_PASSWORD: "pass://Production/Database/password"

- name: Run migrations
  run: ./migrate.sh   # DB_PASSWORD is in env
```

### Pin the CLI version and hash

```yaml
- uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    pass-cli-version: "2.3.3"
    hash: "b5b49a8b3fd0af8830c0c1979f28ea0c90ccece73f59023a8bca8245d4b68da9" # linux-x86_64
  env:
    DB_PASSWORD: "pass://Production/Database/password"
```

The hash is per platform. Get it from the release asset
`https://github.com/protonpass/pass-cli/releases/download/<version>/pass-cli-<platform>[.zip].sha256`.
Without `hash`, the action fetches that same file and verifies against it.

### Using with `protonpass/install-cli-action`

If `pass-cli` is already on PATH and you leave `pass-cli-version` empty, the action uses it as-is.

```yaml
- uses: protonpass/install-cli-action@v1
  with:
    version: "2.3.3"
- uses: gizmodlabs/load-secrets-proton-pass@v1
  env:
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    API_KEY: "pass://Production/Stripe/secret-key"
```

### Bulk-load every field on an item (glob URIs)

When an item carries several related fields (a database item with `host`, `port`, `password`, `database_name`), use `*` in the field segment to pull all of them with one entry:

```yaml
- name: Load secrets
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
  env:
    DB: "pass://Production/Database/*"

- name: Connect
  run: psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME"
```

The env-var name on the left becomes the prefix. Each field is exported as `<PREFIX>_<FIELD>`, where `<FIELD>` is sanitized: non-alphanumeric characters collapse to `_`, leading/trailing `_` is trimmed, and the result is uppercased. `api-key` and `API Key` both become `API_KEY`.

Restrictions:
- Wildcards are only valid in the **field** segment. `pass://Vault/*/field` and `pass://*/item/field` are rejected.
- An item with zero fields fails the step (a warning instead when `strict: false`).
- Two field names that sanitize to the same suffix (e.g. `api-key` and `api_key`) fail the step with both raw names listed. Rename the field or use explicit `pass://` URIs.
- Adding a new field to a globbed item adds a new env var on the next run. Keep that in mind when sharing vaults across workflows.

### Unresolved secrets (strict mode)

By default the step fails when any `pass://` URI cannot be resolved, ending with a report that lists every failing variable (names and URIs only — never secret values):

```
::error::Failed to resolve 1 secret(s):
::error::  BOGUS -> pass://Prod/Does-Not-Exist/x (Error: Could not find item by name 'Does-Not-Exist')
```

Keeping `strict: true` (the default) is strongly recommended — a missing secret that silently becomes an empty string tends to surface later as a confusing failure (empty `DB_PASSWORD`, 401s from an empty `API_KEY`) far from the real cause.

If some secrets are genuinely optional, set `strict: false`: failures are reported as warnings, the affected variables are left unset, and the step succeeds:

```yaml
- name: Load secrets (best effort)
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    strict: false
  env:
    OPTIONAL_TOKEN: "pass://CI/Optional-Service/token"
```

### Template file injection

For applications that read a `.env` file, render one from a template with `{{ pass://vault/item/field }}` placeholders:

```yaml
- name: Render .env from template
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    env-template: ".env.production.template"
```

Template (`.env.production.template`):
```
DB_HOST=db.example.com
DB_PASSWORD={{ pass://Production/Database/password }}
REDIS_URL={{ pass://Production/Redis/url }}
```

Output (`.env.production`):
```
DB_HOST=db.example.com
DB_PASSWORD=actual-resolved-password
REDIS_URL=redis://actual-url:6379
```

With an explicit output path:

```yaml
- name: Render .env from template with custom output
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    env-template: ".env.production.template"
    output-path: ".env.production"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `personal-access-token` | No* | | Proton Pass PAT (`pst_xxxx::TOKENKEY`). *Required unless the step sets the `PROTON_PASS_PERSONAL_ACCESS_TOKEN` env var (upstream-compatible). |
| `env-template` | No | `''` | Path to a template file with `pass://` references |
| `pass-cli-version` | No | `''` → `2.3.3` | `MAJOR.MINOR.PATCH` or `latest`. Empty installs the pinned default **or** accepts any `pass-cli` already on PATH (e.g. from `protonpass/install-cli-action`). An explicit version is enforced. Minimum `2.1.2`. |
| `hash` | No | `''` | Expected SHA-256 of the `pass-cli` download. Empty → fetched from the release's official `.sha256` asset. Always verified. |
| `platform` | No | auto | `linux-x86_64`, `linux-aarch64`, `macos-x86_64`, `macos-aarch64`, `windows-x86_64`. |
| `mask-values` | No | `true` | Mask resolved values in workflow logs |
| `strict` | No | `true` | Fail the step when any `pass://` URI cannot be resolved. Set `false` for best-effort mode: failures become warnings and the step continues |
| `output-path` | No | `''` | Where to write the rendered template. Defaults to stripping `.template`/`.tpl`, else `<input>.resolved`. |
| `export-env` | No | `true` | Export resolved secrets as env vars for subsequent steps. Set `false` to consume them only as step outputs. (Upstream `protonpass/load-secret-action` defaults this to `false`; this action defaults to `true` for compatibility with its own earlier releases.) |

## Outputs

| Output | Description |
|--------|-------------|
| `resolved-keys` | Comma-separated, sorted list of env var names the action populated (e.g. `API_KEY,DB_PASSWORD`). Names only — values never appear. Empty string when nothing resolved. |
| `<NAME>` (per resolved var) | Every resolved variable is also exposed as its own masked step output, e.g. `steps.secrets.outputs.DB_PASSWORD` — including glob-expanded names. |

Resolved values are exported **byte-exact** as printed by `pass-cli` — trailing newlines are preserved (they matter for SSH keys and PEM certificates). When comparing a resolved env var with strict string equality in bash, strip the CLI's trailing newline first: `"${DB_PASSWORD%$'\n'}"`.

Use it to gate downstream steps on what was actually loaded, without touching values:

```yaml
- name: Load secrets
  id: secrets
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
  env:
    DB_PASSWORD: "pass://Prod/DB/password"

- name: Run migrations only if DB_PASSWORD loaded
  if: contains(steps.secrets.outputs.resolved-keys, 'DB_PASSWORD')
  run: ./run-migrations.sh
```

## Examples

Ready-to-copy workflow files live in [`examples/`](examples/):

| Example | Description |
|---------|-------------|
| [`with-pat.yml`](examples/with-pat.yml) | Generate a PAT locally, load one secret in CI |
| [`basic-usage.yml`](examples/basic-usage.yml) | Load a couple of secrets and use them |
| [`multi-service.yml`](examples/multi-service.yml) | Load secrets for multiple services in one step |
| [`env-template.yml`](examples/env-template.yml) | Inject secrets into a `.env` template file |

## Local development

The action is TypeScript (`src/`) bundled with esbuild into committed `dist/` bundles, on top of `pass-cli`. The local loop:

```bash
npm ci

# Typecheck (TS7 strict, no emit), bundle, and run the full test suite
npm run build:check

# Or individually:
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint (typescript-eslint's type-aware rules don't support the TS7 checker yet)
npm run build       # esbuild → dist/index.js + dist/cleanup.js
npm test            # node:test — unit + integration against the mock pass-cli (no Proton account needed)

# Full workflow simulation using the official GitHub Actions runner
npx @redwoodjs/agent-ci run --workflow tests/test-workflow.yml
```

`dist/` is a committed build artifact — rebuild and commit it with any `src/` change (CI fails on stale `dist/`).

[`agent-ci`](https://agent-ci.dev) wraps the official `actions/runner` binary, so what passes locally is what runs in CI.

### Smoke test against a real vault

`tests/test-real.yml` (gitignored) runs the action end-to-end against your own Proton Pass account. Set up:

```bash
# 1. Put your PAT in .env.agent-ci (also gitignored) — agent-ci picks up
#    secrets from this file automatically.
echo 'PROTON_PASS_PERSONAL_ACCESS_TOKEN=pst_xxxx::TOKENKEY' > .env.agent-ci

# 2. Edit the pass:// URIs in tests/test-real.yml to point at items you own.

# 3. Run it.
npx @redwoodjs/agent-ci run --workflow tests/test-real.yml
```

The workflow references the PAT as `${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}`, so the token never lives in the YAML.

## Requirements

- A [Proton Pass Plus+](https://proton.me/pass) subscription (required for CLI access)
- The [Proton Pass CLI](https://proton.me/support/pass-cli) — installed automatically on the runner by this action; needed locally only to mint the PAT
- `pass-cli` 2.1.2 or newer when the action installs it from GitHub Releases

## Project status

This is an **independent, community-maintained** GitHub Action. It is **not affiliated with, endorsed by, or sponsored by Proton AG**. "Proton" and "Proton Pass" are trademarks of Proton AG and are used here only to describe what the action talks to.

The action is a thin wrapper around Proton's public [`pass-cli`](https://proton.me/support/pass-cli) — the same binary anyone can install and run. It uses only documented commands, accesses no private APIs, bypasses no auth, and does not reuse Proton branding beyond naming the integration.

## Contributing

Open source under MIT. Contributions welcome — bug reports, fixes, docs, new examples, dependency bumps, anything.

- File issues and feature requests in the [Issues](../../issues) tab.
- Before opening a PR, run `npm run build:check` locally (typecheck + build + tests) and commit the rebuilt `dist/`.
- Keep PRs focused; one concern per branch.
- See [Local development](#local-development) for the full dev loop.

## Author

Created by [Martin](https://github.com/thisguymartin) at [Gizmodlabs LLC](https://github.com/gizmodlabs), with contributions from the community.

## License

MIT — see [LICENSE](LICENSE)
