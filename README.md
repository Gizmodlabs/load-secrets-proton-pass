<p align="center">
  <img src="docs/assets/logo.svg" alt="Load Secrets from Proton Pass logo" width="160">
</p>

# Load Secrets from Proton Pass

A GitHub Action that loads secrets from [Proton Pass](https://proton.me/pass) vaults into your GitHub Actions workflows using `pass://` URI references.

Works like [1Password's load-secrets-action](https://github.com/1password/load-secrets-action), but backed by Proton Pass.

Since v1.1.0 the action is TypeScript on the `node24` runtime and runs on ubuntu, macos, and windows GitHub-hosted runners. Upgrading from the bash-based 1.0.0? Nothing to change; see [CHANGELOG.md](CHANGELOG.md) for what is new.

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
# Create a named token (3-month expiration in this example)
pass-cli pat create --name "github-actions" --expiration 3m

# Grant it read-only access to each vault it should be able to see.
# IMPORTANT: `pat create` alone gives the token zero vault access — you must
# run this grant for every vault the action needs to read from.
pass-cli pat access grant --pat-name "github-actions" --vault-name "Production" --role viewer
```

The `create` command prints the token in the format `pst_xxxx::TOKENKEY`. **Copy it now — it is shown only once.**

Token tips:
- Scope per-vault with `--role viewer` so the token can read but never write, or narrow it to one item with `--item-title "DB password"`.
- Use short expirations and rotate. `--expiration` takes `1h`, `1d`, `1w`, `1m`, `3m`, `6m` or `1y`. `pass-cli pat renew --personal-access-token-name "github-actions" --expiration 3m` issues a new token string (update the GitHub secret; the old one stops working) and keeps its vault access.
- Revoke any time: `pass-cli pat list` shows the token's ID, then `pass-cli pat delete --pat-id <ID>`.
- Want a record of every read? Use an [agent token](#audit-reads-with-an-agent-token) instead: same format, plus an audit log.

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

`pass-cli` resolves the reference, so its forms pass straight through: vaults and items by ID instead of name, section-qualified fields (`pass://Work/Deploy Targets/Staging.password`), and TOTP fields, which resolve to the current code (`?totp=uri` returns the stored `otpauth://` URI instead).

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

### Outputs-only mode

With `export-env: false` the step hands secrets only to the steps you choose and leaves nothing behind for the rest of the job:

- Resolved values become step outputs only. No env var is exported.
- The `pass-cli` session ends before the step does: it is logged out, its directory and key file are deleted, and `PROTON_PASS_SESSION_DIR` is never exported. A later step, including a third-party action, cannot read your vault through it.

```yaml
- name: Load secrets
  id: secrets
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    export-env: false
  env:
    DB_PASSWORD: "pass://Production/Database/password"

- name: Run migrations
  run: ./migrate.sh
  env:
    DB_PASSWORD: ${{ steps.secrets.outputs.DB_PASSWORD }}   # only this step gets it

- uses: some-org/some-action@<sha>   # sees neither DB_PASSWORD nor a pass-cli session
```

If `PROTON_PASS_SESSION_DIR` already points at an existing directory (for example one `protonpass/install-cli-action` logged into), that session is shared on purpose, so the action leaves it for the post step to log out when the job ends.

Pair this with a token that can read only what the workflow needs: a viewer-role PAT scoped to one vault or item, or an [agent token](#audit-reads-with-an-agent-token) so every read is logged.

### Audit reads with an agent token

A Proton Pass agent is a personal access token whose reads are recorded in an audit log, each with a reason. Create one and grant it read access:

```bash
pass-cli agent create github-actions --expiration 3m
pass-cli agent access grant github-actions --vault-name "Production" --role viewer
```

`agent create` prints JSON whose `token` field reads `PROTON_PASS_PERSONAL_ACCESS_TOKEN=pst_xxxx::TOKENKEY`. Store the part after `=` as a GitHub secret and pass it as `personal-access-token`. No other setting is needed: the action sends a reason with every read, and `pass-cli` uses it only for agent tokens.

By default each reason says what the read loads and links to the exact run attempt:

```text
load DB_PASSWORD: GitHub Actions run https://github.com/acme/api/actions/runs/123456789/attempts/1 (workflow "Deploy" #42, ref main, actor octocat)
```

Glob listings read `list fields to load DB_*: …` and templates `render .env.template: …`. Set `agent-reason` (or `PROTON_PASS_AGENT_REASON` on the step) to replace the part after the colon. A reason over `pass-cli`'s 300-character limit is cut from the end, so the purpose and the run URL survive. Review the log with `pass-cli agent monitor github-actions`.

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
- An expanded name that another reference also produces (e.g. `DB: pass://Vault/Item/*` yielding `DB_HOST` next to an explicit `DB_HOST: pass://...`) fails the step, listing every source, instead of letting one silently overwrite the other. Names compare case-insensitively.
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

The rendered file replaces any existing file at the output path and is written with mode `0600`. It holds plaintext secrets, so keep it out of uploaded artifacts and caches. Every injected value is masked in the logs, including quoted values, `key: value` lines, and several placeholders on one line.

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
| `export-env` | No | `true` | Export resolved secrets as env vars for subsequent steps. Set `false` for [outputs-only mode](#outputs-only-mode): step outputs only, and the `pass-cli` session ends with the step. (Upstream `protonpass/load-secret-action` defaults this to `false`; this action defaults to `true` for compatibility with its own earlier releases.) |
| `agent-reason` | No | `''` | Audit reason for reads made with an [agent token](#audit-reads-with-an-agent-token). Empty → `PROTON_PASS_AGENT_REASON` from the step env, else a description of the run. Each read prefixes what it loads. Plain PATs ignore it. |

Boolean inputs take `true` or `false` in any case. Any other value fails the step, so a typo can never switch masking or strict mode off, or export secrets you meant to keep in step outputs.

## Outputs

| Output | Description |
|--------|-------------|
| `resolved-keys` | Comma-separated, sorted list of env var names the action populated (e.g. `API_KEY,DB_PASSWORD`). Names only — values never appear. Empty string when nothing resolved. |
| `<NAME>` (per resolved var) | Every resolved variable is also exposed as its own masked step output, e.g. `steps.secrets.outputs.DB_PASSWORD` — including glob-expanded names. |

Resolved values are exactly what is stored in Proton Pass: `pass-cli` prints each value followed by one newline and the action strips exactly that newline. Single-line secrets compare cleanly (`[[ "$DB_PASSWORD" == "..." ]]`), and multi-line values such as SSH keys and PEM certificates keep their own trailing newline.

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
| [`outputs-only-agent.yml`](examples/outputs-only-agent.yml) | Hardened: audited agent token, secrets passed only to the steps that need them |

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
npm run test:coverage # unit suites with the coverage gate CI enforces
npm run test:workflow # agent-ci mock workflow using the official Actions runner
npm run verify      # build check + lint + agent-ci workflow
```

CI also lints the workflows with [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh); run `actionlint` and `zizmor .github/` locally if you change them. Accepted zizmor exceptions live in `.github/zizmor.yml`.

`dist/` is a committed build artifact — rebuild and commit it with any `src/` change (CI fails on stale `dist/`).

[`@redwoodjs/agent-ci`](https://agent-ci.dev) is pinned at 0.18.1 and wraps the official `actions/runner` binary. It now forwards to Local CI, while preserving the `agent-ci` command used by this repository.

### Smoke test against a real vault

`tests/test-real.yml` (gitignored) runs the action end-to-end against your own Proton Pass account. Set up:

```bash
# 1. Put your PAT in .env.local-ci (also gitignored) — agent-ci picks up
#    secrets from this file automatically.
echo 'PROTON_PASS_PERSONAL_ACCESS_TOKEN=pst_xxxx::TOKENKEY' > .env.local-ci

# 2. Edit the pass:// URIs in tests/test-real.yml to point at items you own.

# 3. Run it.
npm exec agent-ci run --workflow tests/test-real.yml
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
