# Proton Pass CLI Verification

Verification of the action's scripts against the [official Proton Pass CLI documentation](https://protonpass.github.io/pass-cli/).

## Verified Commands

| What | Action uses | Real CLI | Status |
|------|-------------|----------|--------|
| Install | `curl -fsSL https://proton.me/download/pass-cli/install.sh \| bash` | Same | Correct |
| Login (PAT) | `pass-cli login` (with `PROTON_PASS_PERSONAL_ACCESS_TOKEN` in env) | Same | Correct |
| Session probe | `pass-cli info` | Same | Correct |
| Read field value | `pass-cli item view "pass://vault/item/field"` | Same | Correct |
| Inject template | `pass-cli inject -i template -o output` | Same | Correct |
| Logout | `pass-cli logout` | Same | Correct |

## Environment Variables

| Variable | Purpose | Used in |
|----------|---------|---------|
| `PROTON_PASS_PERSONAL_ACCESS_TOKEN` | PAT for non-interactive login (`pst_xxxx::TOKENKEY`) | Authenticate step |
| `PROTON_PASS_KEY_PROVIDER` | Encryption key storage backend (`keyring`, `fs`, `env`) | All steps calling pass-cli |
| `PROTON_PASS_SESSION_DIR` | Override session storage location | Not used (defaults work) |
| `PROTON_PASS_ENCRYPTION_KEY` | Encryption key (only when provider=`env`) | Not used |
| `PASS_LOG_LEVEL` | Logging verbosity (`trace`/`debug`/`info`/`warn`/`error`/`off`) | Not used |

The action sets `PROTON_PASS_KEY_PROVIDER=fs` on every step that calls `pass-cli`. This is required because GitHub Actions runners (and Docker containers) cannot access the OS keyring. The `fs` provider stores the encryption key at `<session-dir>/local.key`.

## Secret Reference Format

```
pass://vault-name/item-name/field-name
```

- Vault and item identifiers can be names or IDs
- Field names are case-sensitive
- All three components are required

Accepted by three commands: `view`, `run`, `inject`.

## Generating a PAT

Run locally (you need an interactive `pass-cli` session first):

```bash
pass-cli pat create --name "github-actions" --expiration 90d
pass-cli pat access grant --pat-name "github-actions" --vault-name "Production" --role viewer
```

The `create` command prints `pst_xxxx::TOKENKEY` exactly once. Store the full string as the GitHub secret `PROTON_PASS_PERSONAL_ACCESS_TOKEN`.

## Testing with a Real PAT

Before pushing to GitHub, verify the token works locally:

```bash
# 1. Install the CLI
curl -fsSL https://proton.me/download/pass-cli/install.sh | bash

# 2. Authenticate with the PAT
export PROTON_PASS_KEY_PROVIDER=fs
export PROTON_PASS_PERSONAL_ACCESS_TOKEN="pst_xxxx::TOKENKEY"
pass-cli login
pass-cli info   # prints the token name on success

# 3. Read a secret
pass-cli item view "pass://YourVault/YourItem/password"

# 4. Clean up
pass-cli logout
```

If all four commands succeed, the action will work on GitHub Actions.

## Sources

- [Proton Pass CLI Overview](https://protonpass.github.io/pass-cli/)
- [Login Command (PAT section)](https://protonpass.github.io/pass-cli/commands/login/#personal-access-token-login)
- [Personal Access Tokens](https://protonpass.github.io/pass-cli/commands/personal-access-token/)
- [Secret References](https://protonpass.github.io/pass-cli/commands/contents/secret-references/)
- [Configuration](https://protonpass.github.io/pass-cli/get-started/configuration/)
