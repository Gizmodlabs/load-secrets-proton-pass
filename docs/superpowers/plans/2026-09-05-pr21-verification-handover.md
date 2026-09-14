# PR #21 implementation handover

PR #21 keeps the v1 public action contract while moving the implementation to
Node24 and committed TypeScript bundles. This document supersedes the release
instructions in `2026-09-03-upstream-parity-handover.md`.

## Implemented contract

- Consumer workflows continue to use `gizmodlabs/load-secrets-proton-pass@v1`.
- Existing inputs and default environment export behavior remain compatible.
- `hash`, `platform`, `export-env`, and the PAT environment fallback remain
  additive features.
- Explicit CLI pins require an exact stable `pass-cli --version` match.
- Session cleanup saves state before login, targets only the saved session, and
  deletes a session directory only when this invocation created it.

## Validation and release flow

`npm run verify` performs typechecking, bundle generation, unit/integration
tests, linting, and the pinned `@redwoodjs/agent-ci` mock workflow.

The release workflow resolves an immutable tag SHA, calls the reusable test and
real-vault workflows for that SHA, then packages, attests, publishes, and moves
the floating major tag. A release requires
`PROTON_PASS_PERSONAL_ACCESS_TOKEN`; ordinary pull requests still skip real
vault work when that secret is unavailable.

Package an archive without publishing:

```bash
npm run release:package -- --tag v1.1.0 --out-dir "$(mktemp -d)"
```

## Before releasing v1.1.0

1. Rotate the repository test PAT and keep it scoped to the GithubActions test
   vault.
2. Confirm real-vault E2E passes on Linux, macOS, and Windows.
3. Run `npm run verify` and confirm `git diff --exit-code -- dist/` is clean.
4. Merge PR #21, tag `v1.1.0`, and push the tag. The release workflow moves
   `v1` only after all validation gates pass.
