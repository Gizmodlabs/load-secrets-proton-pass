---
title: "Use Proton Pass as a Secret Source for GitHub Actions"
description: "A practical way to resolve pass:// references from Proton Pass during GitHub Actions workflows."
tags: ["github-actions", "proton-pass", "devops", "security", "ci-cd"]
canonical_url: ""
---

# Use Proton Pass as a Secret Source for GitHub Actions

Most CI pipelines need secrets: database URLs, deploy tokens, API keys, signing keys, webhook secrets, and service credentials. GitHub Actions already has encrypted repository secrets, but teams that keep their operational credentials in a password manager often end up copying the same values into multiple repositories.

That creates a drift problem. The password manager becomes the source of truth for humans, while GitHub Secrets becomes a second source of truth for automation.

[`load-secrets-proton-pass`](https://github.com/Gizmodlabs/load-secrets-proton-pass) is a GitHub Action for teams using Proton Pass who want to load secrets into CI from `pass://` references.

## The basic idea

Instead of storing every application secret directly in GitHub, store a Proton Pass personal access token as one GitHub secret. Then reference the real secrets by URI in your workflow:

```yaml
- name: Load secrets
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
  env:
    DATABASE_URL: "pass://Production/Database/connection_string"
    STRIPE_KEY: "pass://Production/Stripe/secret_key"

- name: Deploy
  run: ./deploy.sh
```

The action resolves each `pass://vault/item/field` value using the Proton Pass CLI, masks the resolved value in workflow logs, and exports it as a normal environment variable for later steps in the job.

## Why build this?

Proton Pass added CLI support, which makes it possible to access vault items from automation with scoped personal access tokens. That opens up a useful workflow:

- Keep secrets in Proton Pass.
- Grant CI read-only access to the vaults it needs.
- Reference secrets by name in workflow files.
- Rotate values in Proton Pass without editing every repository secret.

This is especially useful for small teams already using Proton Pass as their shared credential store. It gives CI a path to the same source of truth without introducing a separate secret manager.

## Setup

First, create a Proton Pass personal access token locally:

```bash
pass-cli pat create --name "github-actions" --expiration 90d
```

Then grant the token read-only access to the vaults your workflow needs:

```bash
pass-cli pat access grant \
  --pat-name "github-actions" \
  --vault-name "Production" \
  --role viewer
```

Add the resulting token to your repository as a GitHub Actions secret:

```text
PROTON_PASS_PERSONAL_ACCESS_TOKEN=pst_xxxx::TOKENKEY
```

After that, any workflow can resolve values from Proton Pass using `pass://` URIs.

## URI format

The action uses this format:

```text
pass://vault-name/item-name/field-name
```

Examples:

```text
pass://Production/Database/password
pass://Production/Stripe/secret_key
pass://Shared/Deploy Bot/token
```

The field can be a standard Proton Pass field such as `username` or `password`, or a custom field on the item.

## Rendering an env file

Some applications expect a `.env` file instead of environment variables. The action can render a template file with inline `pass://` placeholders:

```yaml
- name: Render production env
  uses: gizmodlabs/load-secrets-proton-pass@v1
  with:
    personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    env-template: ".env.production.template"
    output-path: ".env.production"
```

Template:

```text
DATABASE_URL={{ pass://Production/Database/connection_string }}
REDIS_URL={{ pass://Production/Redis/url }}
STRIPE_KEY={{ pass://Production/Stripe/secret_key }}
```

Rendered output:

```text
DATABASE_URL=actual-resolved-value
REDIS_URL=actual-resolved-value
STRIPE_KEY=actual-resolved-value
```

## Security notes

This action is designed to be a thin wrapper around Proton's official `pass-cli`.

The practical recommendations are:

- Use a dedicated personal access token for GitHub Actions.
- Grant only `viewer` access to the vaults CI needs.
- Use short token expirations, such as 30 or 90 days.
- Rotate the token on a schedule.
- Do not grant CI access to personal or unrelated vaults.
- Keep `mask-values` enabled unless you have a specific debugging reason.

The GitHub repository secret still matters. Treat `PROTON_PASS_PERSONAL_ACCESS_TOKEN` like any other credential that can read production secrets.

## When this is a good fit

This action is a good fit when:

- Your team already uses Proton Pass.
- Your CI workflows need secrets from shared vaults.
- You want to avoid duplicating every secret into every repository.
- You prefer a simple GitHub Actions-native workflow over running a separate secret management service.

It may not be the right tool if you need dynamic secret leasing, cloud IAM integration, audit-heavy enterprise workflows, or a full secrets platform such as Vault, AWS Secrets Manager, Google Secret Manager, or Azure Key Vault.

## Try it

The project is open source under MIT:

https://github.com/Gizmodlabs/load-secrets-proton-pass

The README includes setup instructions, examples, template rendering, local tests, and development notes.

This is an independent, community-maintained GitHub Action. It is not affiliated with, endorsed by, or sponsored by Proton AG.
