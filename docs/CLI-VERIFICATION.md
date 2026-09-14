# Proton Pass CLI Verification

Verification of the action's scripts against the [official Proton Pass CLI documentation](https://protonpass.github.io/pass-cli/).

## Verified Commands

| What | Action uses | Real CLI | Status |
|------|-------------|----------|--------|
| Install | Downloads the requested [GitHub release](https://github.com/protonpass/pass-cli/releases) asset and verifies it against the asset's `.sha256` sidecar or the caller's `hash` input | Official release binary and checksum | Correct |
| Login (PAT) | `pass-cli login` (with `PROTON_PASS_PERSONAL_ACCESS_TOKEN` in env) | Same | Correct |
| Session probe | `pass-cli info` | Same | Correct |
| Read field value | `pass-cli item view -- "pass://vault/item/field"` (`--` guards against flag-like values) | Same; prints the stored value followed by exactly one newline (`println!`, `pass-cli/src/commands/item/view.rs`), which the action strips | Correct |
| List item fields (glob) | `pass-cli item view --output json -- "pass://vault/item"` | Same command, and the response schema is now pinned too: see [Item JSON schema](#item-json-schema) | Correct |
| Inject template | `pass-cli inject -i template -o output` | Same | Correct |
| Logout | `pass-cli logout` | Same | Correct |

A real-network installer smoke on 2026-09-03 verified download, SHA-256, and
tool-cache installation of `pass-cli` 2.3.3 for `macos-aarch64`. The real-vault
E2E workflow targets that pinned default, then reinstalls 2.3.2 to verify
explicit-version enforcement. Its covered commands are expected to use the same
output shapes as 2.1.0; any observed difference must be recorded here.


## Item JSON schema

The glob expansion parses `item view --output json`, so its response shape is
part of the contract, not just the command. Captured from pass-cli 2.1.0
against a live vault:

```json
{
  "item": {
    "content": {
      "title": "my-item",
      "note": "",
      "content": { "Login": { "email": "", "username": "", "password": "", "urls": [], "totp_uri": "", "passkeys": [] } },
      "extra_fields": [{ "name": "Custom Thing", "content": { "Text": "value" } }]
    }
  },
  "attachments": []
}
```

Built-in fields sit in one tagged variant under `item.content.content`, keyed by
item type. Custom fields sit in `item.content.extra_fields`; a Custom item keeps
them in `Custom.sections[].section_fields[]` instead, using the same
`{ name, content: { <Kind>: value } }` element. Kind is `Text`, `Hidden`, `Totp`
or `Timestamp`, and a `Timestamp` value serializes as a number rather than a
string.

Which names a glob may emit is constrained by what the per-field read accepts:

- Field lookup is case-insensitive but not punctuation-insensitive. `api key`
  finds `API Key`; `API_Key` does not.
- An unset built-in scalar answers `Field does not exist`, so empty strings are
  skipped. So are the array-valued keys, `urls` and `passkeys`.
- A custom field resolves once declared, even with an empty value, so those are
  always included.
- `title` and `note` resolve but are item metadata rather than secrets, so a
  glob leaves them out.
- A `Totp` field resolves to a freshly generated code, not the stored
  `otpauth://` URI.

Item type decides where the built-in fields live. `Login`, `CreditCard`,
`Identity`, `SshKey` and `Wifi` carry scalars directly; `SshKey`, `Wifi` and
`Custom` also carry a `sections` list; `Note` and `Alias` are unit structs and
serialize as a bare `null`, so a glob over them yields nothing.

Arrays inside a variant are told apart by element shape, not by key, because the
keys differ per item type. A list of strings is itself one addressable field
registered under the array's own key and joined with `, `, which is how
`Login.urls` resolves. A list of `{ name, content }` is custom fields under their
plain names, which is how `Identity` carries `extra_personal_details`,
`extra_address_details`, `extra_contact_details` and `extra_work_details`. A list
of `{ section_name, section_fields }` is sections, registered as
`SectionName.fieldname`, covering `sections` on SshKey, Wifi and Custom items
plus `Identity.extra_sections`. `Login.passkeys` matches none of these and is
skipped; its elements have no `name`, and their `content` is a byte array rather
than an object.

Section fields are emitted qualified even though a bare name usually resolves,
because the unqualified lookup returns the first match across all sections.
Verified against a live vault with two sections sharing a field name:

```
Alpha.shared   -> alpha-shared
Beta.shared    -> beta-shared
shared         -> alpha-shared
```

Emitting the bare name would silently drop one of the two secrets.

`tests/fixtures/item-json.mjs` builds every offline fixture from this shape. The
1.1.0 rewrite originally parsed an invented `{"fields":[{"name":…}]}` envelope,
which no pass-cli version emits, so globs matched zero fields against the real
CLI while the whole offline suite passed.

## Environment Variables

| Variable | Purpose | Used in |
|----------|---------|---------|
| `PROTON_PASS_PERSONAL_ACCESS_TOKEN` | PAT for non-interactive login (`pst_xxxx::TOKENKEY`) | Authenticate step |
| `PROTON_PASS_KEY_PROVIDER` | Encryption key storage backend (`keyring`, `fs`, `env`) | All steps calling pass-cli |
| `PROTON_PASS_SESSION_DIR` | Action-created or caller-provided session storage location | Set by the action; post cleanup targets the saved directory explicitly |
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
- [pass-cli GitHub Releases](https://github.com/protonpass/pass-cli/releases) — release assets and `.sha256` sidecars
- [Proton download manifest](https://proton.me/download/pass-cli/versions.json) — `formatVersion: 1` with a single latest-only `passCliVersions` object, so it cannot verify arbitrary pinned releases
