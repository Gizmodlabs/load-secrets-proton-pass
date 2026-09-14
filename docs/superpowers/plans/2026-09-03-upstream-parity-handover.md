# Upstream Parity + Installer Fix — Handover Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `feat/typescript-node24-rewrite` branch installable against today's real Proton infrastructure by adopting upstream `protonpass/load-secret-action`'s GitHub-Releases + `.sha256` install model, and port the handful of upstream inputs/behaviors worth having (`hash`, `platform`, PAT-via-env, pre-installed CLI interop, gated real-vault e2e).

**Architecture:** Replace `src/installer/manifest.ts` (Proton `versions.json` parser) with `src/installer/release.ts` (GitHub release asset URLs, `.sha256` sidecar fetch, `latest` via the `/releases/latest` 302 redirect, user-supplied `hash` override). `install.ts` keeps its fail-closed download → verify → cache → PATH flow and gains a "pre-installed CLI acceptance" policy. `inputs.ts`/`action.yml` grow two inputs and a PAT env fallback. CI gains a real-vault e2e job (3 OS, no mock) so the installer is exercised against the live release feed on every push.

**Tech Stack:** unchanged — TypeScript 7 (`tsc --noEmit`), esbuild, oxlint, `node:test`, `@actions/core|exec|http-client|tool-cache`.

**Spec:** this document (sections "Why", "Upstream comparison", "Design decisions"). No separate spec file.

---

## Why (state of the world, 2026-09-03)

- **No PRs exist for the rewrite.** `feat/typescript-node24-rewrite` is local-only, 9 commits ahead of `main`, 0 merge conflicts, `npm run build:check` green (92/92), `dist/` fresh. Two orca worktrees (`bristlemouth`, `sandworm`) are clean at `main` — nothing in them.
- **Working tree hazard:** `package-lock.json` deleted, `pnpm-lock.yaml` untracked. CI runs `npm ci` with `cache: npm`. Committing that swap breaks CI. Task 0 fixes it.
- **P0 — the rewrite cannot install `pass-cli` for any real user.** Verified 2026-09-03 by running `resolveInstallerSpec` from `src/installer/manifest.ts` against the live `https://proton.me/download/pass-cli/versions.json`:

  ```
  2.1.0:  FAIL -> Unexpected versions.json schema: expected a non-empty "passCliVersions" array.
  latest: FAIL -> Unexpected versions.json schema: expected a non-empty "passCliVersions" array.
  2.3.3:  FAIL -> Unexpected versions.json schema: expected a non-empty "passCliVersions" array.
  ```

  Root cause: the live manifest's `passCliVersions` is a **single object** (latest only, currently `2.3.3`), not an array. Our parser and its unit fixture assume an array of every version. Even with the schema fixed, the manifest lists only the latest release, so our pinned default `2.1.0` (and any pin) fails closed. Every unit/integration/smoke test passes only because the mock `pass-cli` is pre-installed on PATH, which skips the installer entirely.

  Live manifest shape (1183 bytes):

  ```json
  {
    "formatVersion": 1,
    "passCliVersions": {
      "version": "2.3.3",
      "urls": {
        "macos":   { "aarch64": {"url": "...", "hash": "..."}, "x86_64": {...} },
        "linux":   { "aarch64": {...}, "x86_64": {...} },
        "windows": { "x86_64": {"url": ".../pass-cli-windows-x86_64.zip", "hash": "..."} }
      }
    }
  }
  ```

- **Upstream's install model works for pinning.** `github.com/protonpass/pass-cli` publishes 14 releases (2.1.2 … 2.3.3), each with `pass-cli-<platform>[.zip]` plus a `pass-cli-<platform>[.zip].sha256` sidecar. Hash parity checked: the GitHub sidecar for 2.3.3 `linux-x86_64` equals the proton.me manifest hash (`b5b49a8b…68da9`). Releases `< 2.1.2` (including our current default `2.1.0`) are **not** on GitHub Releases; proton.me still serves the 2.1.0 binary but publishes no hash for it.
- Issue #16 (hybrid Go resolver) is superseded by the Node rewrite — close it with the PR. Issue #17 (smoke-test field glob against a real vault) is delivered by Task 7.

## Upstream comparison (`protonpass/load-secret-action` @ `dcb5cd9`)

| Upstream idea | Verdict | Why |
|---|---|---|
| Download from GitHub Releases, verify against `.sha256` sidecar | **Adopt** (Task 1–3) | Only source that supports pinned versions with a published hash. Fixes the P0. |
| `hash` input (caller-supplied expected SHA-256) | **Adopt** (Task 2, 4) | Lets callers pin binary identity independent of GitHub. Still fail-closed. |
| `platform` input (override auto-detect) | **Adopt** (Task 4) | `resolvePlatform(input)` already exists; just not exposed. Needed for cross-compiling/self-hosted oddities. |
| Version string validated `^\d+\.\d+\.\d+$` before URL building | **Adopt** (Task 1) | Path-traversal guard; matters now that we build URLs from input. |
| PAT read from `PROTON_PASS_PERSONAL_ACCESS_TOKEN` env | **Adopt as fallback** (Task 4) | Drop-in compatibility with upstream workflows and `install-cli-action` chaining. Input still wins when set. |
| Skip install if *any* `pass-cli` is on PATH | **Adopt partially** (Task 3) | When `pass-cli-version` is unset or `latest`, accept whatever is pre-installed (interop with `protonpass/install-cli-action`). An explicit version still must match or we reinstall. |
| Real-vault integration jobs gated on secret presence | **Adopt, hardened** (Task 7) | Ours (`load-secrets.yml`) only `echo`es. New job asserts literal + glob (#17) + step output, on 3 OS, **without the mock** — so it exercises the real download path. Gate via job `env`, not job `if` (secrets aren't available in job-level `if`). |
| `latest` via GitHub REST `releases/latest` API | **Adapt** (Task 2) | REST API is rate-limited per IP (60/h unauthenticated) and hosted runners share IPs. Use the HTML redirect instead: `HEAD /releases/latest` → `302 Location: …/releases/tag/2.3.3`. No API, no token, no rate limit. Verified 2026-09-03. |
| 64 KB response-size guard on API body | **Adapt** (Task 2) | Apply a 1 KB cap to the `.sha256` sidecar body instead. |
| Raw `key=value` append to `$GITHUB_OUTPUT` alongside `core.setOutput` | **Reject** | Double-writes and breaks multiline values. This is exactly fix #1 in our rewrite. |
| `.trim()` on resolved values | **Reject** | Byte-exact values is a deliberate, documented decision (PEM/SSH keys). |
| `export-env` default `false` | **Reject** | Deliberate: our v1 users depend on env export. Documented in `action.yml`, README, MIGRATION. |
| `scripts/local-run.js` | **Reject** | `npx @redwoodjs/agent-ci run --workflow tests/test-workflow.yml` already simulates the runner with the real Actions toolkit. |
| No `post:` cleanup, no PAT-bound session | n/a — ours is stronger | Keep ours. |

## Design decisions

1. **Install source = GitHub Releases only.** `https://github.com/protonpass/pass-cli/releases/download/<version>/pass-cli-<platform>` (`.zip` for `windows-x86_64`), sidecar `<same>.sha256` (format `<hex>  <filename>`, first whitespace-separated token). `versions.json` is no longer consulted. `manifest.ts` and its test are deleted.
2. **`latest` = follow the redirect.** `HEAD https://github.com/protonpass/pass-cli/releases/latest` without following redirects; parse `/releases/tag/v?(\d+\.\d+\.\d+)$` from `Location`. Anything else → error, fail closed.
3. **Fail-closed is unchanged.** Expected hash comes from exactly one of: the `hash` input (validated 64-hex) or the sidecar. No hash → no install. Mismatch → delete file, throw, never disclose the actual digest.
4. **Default `pass-cli-version` becomes `2.3.3`, applied in code, with `action.yml` default `''`.** The empty action default lets the installer distinguish "caller did not choose" from "caller chose". Versions `< 2.1.2` cannot be installed (404 on the sidecar) — the error message says so and points at MIGRATION.md.
5. **Pre-installed acceptance policy** (`acceptsPreinstalled(versionOutput, requested)`): requested `''` or `latest` → accept any `pass-cli` on PATH; explicit `X.Y.Z` → accept only if `pass-cli --version` output contains it, else reinstall. Threat model unchanged vs today (a prior step controlling PATH already controls the binary; that is how tests inject the mock).
6. **PAT source**: `personal-access-token` input if non-empty, else `PROTON_PASS_PERSONAL_ACCESS_TOKEN` env, else fail with a message naming both. Masked immediately either way. `action.yml` marks the input `required: false` (loosening a requirement is not a breaking change).
7. **Real-vault e2e** replaces `.github/workflows/load-secrets.yml` with `e2e-real.yml`: 3-OS matrix, no mock, gated per-step on `env.HAS_PAT == 'true'` where `HAS_PAT: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN != '' }}` is set at job level. Asserts literal value non-empty, glob expansion produced `E2E_ALL_*` keys, per-var step output present, and a second invocation with an explicit different version reinstalls. Weekly cron catches upstream asset changes.
8. **Docs** (README, MIGRATION, CLAUDE.md, CLI-VERIFICATION) updated in the same PR; `dist/` rebuilt and committed.

### Rejected alternatives

- **Fix the manifest parser to accept object-or-array and stay on proton.me.** Only `latest` would ever be installable; pinning (the repo's stated reproducibility philosophy) is dead. Rejected.
- **Hybrid: manifest for `latest`, GitHub sidecar for pins, cross-check when both exist.** Two code paths, two failure modes, twice the test surface, and a cross-check that can only ever fail closed on Proton's own publishing lag. YAGNI. Revisit only if GitHub Releases stop shipping sidecars.
- **Default `pass-cli-version: latest`** (upstream's default). Rejected: non-reproducible builds, and a silent CLI behavior change can break every consumer overnight. Pinned default + weekly e2e cron is the compromise.

### Decisions Martin may want to override (each is one line to change)

| Decision | Where | Alternative |
|---|---|---|
| Default `2.3.3` pinned | `DEFAULT_PASS_CLI_VERSION` in `src/installer/install.ts` | `latest` |
| PAT env fallback on | `readPat()` in `src/inputs.ts` | Delete the `env[...]` branch, restore `required: true` |
| Unset version accepts pre-installed CLI | `acceptsPreinstalled()` in `src/installer/install.ts` | Return `versionOutput.includes(requested \|\| DEFAULT_PASS_CLI_VERSION)` |
| Rename `load-secrets.yml` → `e2e-real.yml` | `.github/workflows/` | Keep the filename; branch-protection required checks reference job names, not filenames, so either is safe |

## Global Constraints

- `runs.using: node24`; TS7 `tsc --noEmit` only; esbuild bundles to committed `dist/index.js` + `dist/cleanup.js`; `npm run build` before `npm test`; CI `dist-freshness` fails on stale `dist/`.
- `erasableSyntaxOnly`: no enums/namespaces; relative imports carry `.ts`; `verbatimModuleSyntax` (use `import type`).
- `noUncheckedIndexedAccess` is on — index results are `T | undefined`.
- Installer fails closed: no expected hash ⇒ abort; mismatch ⇒ delete + abort; the actual digest of a tampered file is never disclosed; an unverified binary never runs.
- Only `core.setOutput` / `core.exportVariable` write outputs/env. Never append to `$GITHUB_OUTPUT`/`$GITHUB_ENV`.
- Values byte-exact; no trimming. Secrets never in logs/errors/`resolved-keys` — names and URIs only.
- `--` before every positional URI passed to `pass-cli`.
- Public contract: existing inputs keep working with their documented behavior; `export-env` default stays `true`; `resolved-keys` written before strict-mode failure.
- Package manager is **npm** (`package-lock.json` committed). Do not introduce `pnpm-lock.yaml`.
- Commit messages: Conventional Commits; end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

```
action.yml                              +hash, +platform; personal-access-token required:false;
                                        pass-cli-version default '' (docs say 2.3.3)
src/inputs.ts                           +passCliHash, +platform; passCliVersion now raw (''); PAT env fallback
src/main.ts                             ensurePassCli({ version, hash, platform })
src/installer/release.ts       (new)    asset/URL builders, version + hash validation, latest via redirect,
                                        sidecar fetch, resolveInstallerSpec(version, platform, hash, http)
src/installer/install.ts                DEFAULT_PASS_CLI_VERSION, InstallOptions, acceptsPreinstalled,
                                        releaseHttp() adapter; verifySha256 message no longer says versions.json
src/installer/manifest.ts      (delete)
tests/unit/release.test.ts     (new)    replaces tests/unit/manifest.test.ts (delete)
tests/unit/install-policy.test.ts (new) acceptsPreinstalled
tests/unit/inputs.test.ts      (new)    PAT input/env precedence, raw version, new inputs
tests/integration/install.integration.test.ts (new)  unset version accepts mock; PAT via env
.github/workflows/test.yml              smoke-glob/template/multiline drop pass-cli-version (unset path);
                                        smoke keeps "1.0.0" (explicit-match path)
.github/workflows/e2e-real.yml (new)    replaces load-secrets.yml (delete)
README.md, MIGRATION.md, CLAUDE.md, docs/CLI-VERIFICATION.md   docs
dist/index.js, dist/cleanup.js          rebuilt
```

---

## Tasks

### Task 0: Housekeeping — lockfile, push, draft PR

**Files:**
- Restore: `package-lock.json`
- Delete (untracked): `pnpm-lock.yaml`

- [ ] **Step 1: Restore npm lockfile, remove pnpm lockfile**

```bash
cd /Users/martin/workspace/load-secrets-proton-pass
git checkout -- package-lock.json
rm -f pnpm-lock.yaml
git status --short   # expect: clean
```

- [ ] **Step 2: Prove the lockfile still installs and the gate is green**

```bash
rm -rf node_modules && npm ci && npm run build:check
```
Expected: `ℹ pass 92`, `ℹ fail 0`.

- [ ] **Step 3: Push the branch and open a draft PR**

```bash
git push -u origin feat/typescript-node24-rewrite
gh pr create --draft --base main --title "feat!: TypeScript node24 action (v2) — replaces bash composite" \
  --body "$(cat <<'EOF'
Node24 rewrite of the action. See MIGRATION.md.

Work remaining before undraft is tracked in docs/superpowers/plans/2026-09-03-upstream-parity-handover.md
(installer must move to GitHub Releases + .sha256 — the Proton versions.json manifest is latest-only and
does not match the schema this branch expects).

Closes #16 (superseded: the resolver logic #16 wanted in Go is implemented here in TypeScript).
Closes #17 (real-vault glob e2e added).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 1: `release.ts` — pure URL/version/hash helpers (TDD)

**Files:**
- Create: `src/installer/release.ts`
- Test: `tests/unit/release.test.ts`

**Interfaces:**
- Produces: `RELEASES_BASE: string`, `assetName(platform: Platform): string`, `downloadUrl(version: string, platform: Platform): string`, `checksumUrl(version: string, platform: Platform): string`, `assertValidVersion(version: string): void`, `parseExpectedHash(input: string): string`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/release.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RELEASES_BASE,
  assetName,
  downloadUrl,
  checksumUrl,
  assertValidVersion,
  parseExpectedHash,
} from '../../src/installer/release.ts'

test('assetName: windows is a zip, everything else a bare binary', () => {
  assert.equal(assetName('windows-x86_64'), 'pass-cli-windows-x86_64.zip')
  assert.equal(assetName('linux-x86_64'), 'pass-cli-linux-x86_64')
  assert.equal(assetName('macos-aarch64'), 'pass-cli-macos-aarch64')
})

test('downloadUrl/checksumUrl point at the GitHub release asset and its .sha256 sidecar', () => {
  assert.equal(RELEASES_BASE, 'https://github.com/protonpass/pass-cli/releases')
  assert.equal(
    downloadUrl('2.3.3', 'linux-x86_64'),
    'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-linux-x86_64',
  )
  assert.equal(
    checksumUrl('2.3.3', 'windows-x86_64'),
    'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-windows-x86_64.zip.sha256',
  )
})

test('assertValidVersion accepts MAJOR.MINOR.PATCH only', () => {
  assert.doesNotThrow(() => assertValidVersion('2.3.3'))
  for (const bad of ['v2.3.3', '2.3', '2.0.0-beta.1', '../../etc/passwd', '2.3.3; rm -rf /', 'latest', '']) {
    assert.throws(() => assertValidVersion(bad), /Invalid pass-cli version/, bad)
  }
})

test('parseExpectedHash accepts 64 hex chars (any case, surrounding whitespace) and lowercases', () => {
  const upper = 'B5B49A8B3FD0AF8830C0C1979F28EA0C90CCECE73F59023A8BCA8245D4B68DA9'
  assert.equal(parseExpectedHash(`  ${upper}\n`), upper.toLowerCase())
  for (const bad of ['deadbeef', 'zz'.repeat(32), '', `${upper}0`]) {
    assert.throws(() => parseExpectedHash(bad), /Invalid "hash" input/, bad)
  }
})
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test tests/unit/release.test.ts
```
Expected: FAIL — `Cannot find module '.../src/installer/release.ts'`.

- [ ] **Step 3: Implement the helpers**

`src/installer/release.ts`:

```ts
import type { Platform } from './platform.ts'
import type { InstallerSpec } from '../domain/installer-spec.ts'

/**
 * pass-cli binaries and their `.sha256` sidecars are published as GitHub
 * release assets. Proton's `versions.json` is NOT used: it describes only
 * the latest release, so it cannot verify a pinned version.
 */
export const RELEASES_BASE = 'https://github.com/protonpass/pass-cli/releases'

const VERSION_RE = /^\d+\.\d+\.\d+$/
const SHA256_RE = /^[0-9a-f]{64}$/i
/** A sidecar is ~100 bytes ("<hex>  <filename>"); anything larger is not a checksum file. */
const MAX_SIDECAR_BYTES = 1024

export interface HeadResponse {
  readonly statusCode: number
  readonly location: string | undefined
}

export interface TextResponse {
  readonly statusCode: number
  readonly body: string
}

/** Minimal HTTP surface so tests can inject canned responses. */
export interface ReleaseHttp {
  /** HEAD that does NOT follow redirects (we read the Location header). */
  head(url: string): Promise<HeadResponse>
  /** GET that follows redirects (release assets 302 to a CDN); body as UTF-8. */
  getText(url: string): Promise<TextResponse>
}

export function assetName(platform: Platform): string {
  return platform === 'windows-x86_64' ? `pass-cli-${platform}.zip` : `pass-cli-${platform}`
}

export function downloadUrl(version: string, platform: Platform): string {
  return `${RELEASES_BASE}/download/${version}/${assetName(platform)}`
}

export function checksumUrl(version: string, platform: Platform): string {
  return `${downloadUrl(version, platform)}.sha256`
}

/** Digits and dots only — the version is interpolated into a URL path. */
export function assertValidVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `Invalid pass-cli version "${version}": expected MAJOR.MINOR.PATCH (for example 2.3.3) or "latest".`,
    )
  }
}

/** Validate a caller-supplied expected digest. Returns lowercase hex. */
export function parseExpectedHash(input: string): string {
  const hash = input.trim()
  if (!SHA256_RE.test(hash)) {
    throw new Error('Invalid "hash" input: expected a 64-character hexadecimal SHA-256 digest.')
  }
  return hash.toLowerCase()
}

// resolveLatestVersion / fetchReleaseChecksum / resolveInstallerSpec are added in Task 2.
export type { InstallerSpec }
```

- [ ] **Step 4: Run to verify pass**

```bash
node --test tests/unit/release.test.ts && npm run typecheck && npm run lint
```
Expected: 4 pass; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/installer/release.ts tests/unit/release.test.ts
git commit -m "feat(installer): GitHub release URL, version and hash helpers

Groundwork for moving the installer off Proton's versions.json (latest-only,
schema mismatch) onto GitHub release assets + .sha256 sidecars.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `release.ts` — latest via redirect, sidecar fetch, `resolveInstallerSpec` (TDD); delete manifest

**Files:**
- Modify: `src/installer/release.ts`
- Test: `tests/unit/release.test.ts`
- Delete: `src/installer/manifest.ts`, `tests/unit/manifest.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers, `ReleaseHttp`.
- Produces: `resolveLatestVersion(http: ReleaseHttp): Promise<string>`, `fetchReleaseChecksum(version: string, platform: Platform, http: ReleaseHttp): Promise<string>`, `resolveInstallerSpec(versionInput: string, platform: Platform, hashInput: string, http: ReleaseHttp): Promise<InstallerSpec>`.

- [ ] **Step 1: Append the failing tests**

Append to `tests/unit/release.test.ts`:

```ts
import {
  resolveLatestVersion,
  fetchReleaseChecksum,
  resolveInstallerSpec,
  type ReleaseHttp,
} from '../../src/installer/release.ts'

const HASH = 'b5b49a8b3fd0af8830c0c1979f28ea0c90ccece73f59023a8bca8245d4b68da9'

function fakeHttp(overrides: Partial<ReleaseHttp> = {}): ReleaseHttp {
  return {
    async head() {
      return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases/tag/2.3.3' }
    },
    async getText(url) {
      if (url.endsWith('.sha256')) return { statusCode: 200, body: `${HASH}  pass-cli-linux-x86_64\n` }
      return { statusCode: 404, body: 'Not Found' }
    },
    ...overrides,
  }
}

test('resolveLatestVersion parses the version out of the 302 Location header', async () => {
  assert.equal(await resolveLatestVersion(fakeHttp()), '2.3.3')
  const withV = fakeHttp({
    async head() {
      return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases/tag/v2.4.0' }
    },
  })
  assert.equal(await resolveLatestVersion(withV), '2.4.0')
})

test('resolveLatestVersion fails closed on non-redirect, missing, or malformed Location', async () => {
  const cases: Array<Partial<ReleaseHttp>> = [
    { async head() { return { statusCode: 200, location: undefined } } },
    { async head() { return { statusCode: 302, location: undefined } } },
    { async head() { return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases' } } },
    { async head() { return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases/tag/../x' } } },
  ]
  for (const c of cases) {
    await assert.rejects(resolveLatestVersion(fakeHttp(c)), /latest pass-cli version|Invalid pass-cli version/)
  }
})

test('fetchReleaseChecksum reads the first token of "<hex>  <filename>" and lowercases it', async () => {
  const upper = fakeHttp({
    async getText() { return { statusCode: 200, body: `${HASH.toUpperCase()}  pass-cli-linux-x86_64` } },
  })
  assert.equal(await fetchReleaseChecksum('2.3.3', 'linux-x86_64', upper), HASH)
  const bare = fakeHttp({ async getText() { return { statusCode: 200, body: `${HASH}\n` } } })
  assert.equal(await fetchReleaseChecksum('2.3.3', 'linux-x86_64', bare), HASH)
})

test('fetchReleaseChecksum fails closed on 404, oversized, or non-hex body', async () => {
  const notFound = fakeHttp({ async getText() { return { statusCode: 404, body: 'Not Found' } } })
  await assert.rejects(
    fetchReleaseChecksum('2.1.0', 'linux-x86_64', notFound),
    /2\.1\.0\/pass-cli-linux-x86_64\.sha256 \(HTTP 404\).*unverified/s,
  )
  const huge = fakeHttp({ async getText() { return { statusCode: 200, body: 'a'.repeat(2048) } } })
  await assert.rejects(fetchReleaseChecksum('2.3.3', 'linux-x86_64', huge), /too large.*unverified/s)
  const html = fakeHttp({ async getText() { return { statusCode: 200, body: '<!DOCTYPE html><html>' } } })
  await assert.rejects(fetchReleaseChecksum('2.3.3', 'linux-x86_64', html), /did not contain a SHA-256.*unverified/s)
})

test('resolveInstallerSpec: pinned version + sidecar', async () => {
  const spec = await resolveInstallerSpec('2.3.3', 'linux-x86_64', '', fakeHttp())
  assert.deepEqual(spec, {
    version: '2.3.3',
    platform: 'linux-x86_64',
    url: 'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-linux-x86_64',
    sha256: HASH,
  })
})

test('resolveInstallerSpec: latest resolves through the redirect, then fetches that version’s sidecar', async () => {
  const seen: string[] = []
  const http = fakeHttp({
    async getText(url) {
      seen.push(url)
      return { statusCode: 200, body: `${HASH}  x` }
    },
  })
  const spec = await resolveInstallerSpec('latest', 'windows-x86_64', '', http)
  assert.equal(spec.version, '2.3.3')
  assert.equal(spec.url, 'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-windows-x86_64.zip')
  assert.deepEqual(seen, ['https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-windows-x86_64.zip.sha256'])
})

test('resolveInstallerSpec: a caller-supplied hash is used verbatim and the sidecar is never fetched', async () => {
  const http = fakeHttp({
    async getText() { throw new Error('sidecar must not be fetched when hash is supplied') },
  })
  const spec = await resolveInstallerSpec('2.3.3', 'linux-x86_64', HASH.toUpperCase(), http)
  assert.equal(spec.sha256, HASH)
})

test('resolveInstallerSpec: rejects malformed version and malformed hash before any network call', async () => {
  const http = fakeHttp({
    async head() { throw new Error('no network expected') },
    async getText() { throw new Error('no network expected') },
  })
  await assert.rejects(resolveInstallerSpec('2.1', 'linux-x86_64', '', http), /Invalid pass-cli version/)
  await assert.rejects(resolveInstallerSpec('2.3.3', 'linux-x86_64', 'nope', http), /Invalid "hash" input/)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test tests/unit/release.test.ts
```
Expected: FAIL — `resolveLatestVersion` etc. are not exported.

- [ ] **Step 3: Implement**

Replace the trailing comment + `export type { InstallerSpec }` line in `src/installer/release.ts` with:

```ts
/**
 * Resolve "latest" WITHOUT the GitHub REST API (rate-limited per IP; hosted
 * runners share IPs). GitHub answers `/releases/latest` with a 302 whose
 * Location ends in `/releases/tag/<version>`.
 */
export async function resolveLatestVersion(http: ReleaseHttp): Promise<string> {
  const url = `${RELEASES_BASE}/latest`
  const res = await http.head(url)
  const match = /\/releases\/tag\/v?([^/?#]+)$/.exec(res.location ?? '')
  const version = match?.[1]
  if (res.statusCode !== 302 || version === undefined) {
    throw new Error(
      `Could not determine the latest pass-cli version from ${url} (HTTP ${res.statusCode}). ` +
        'Pin pass-cli-version explicitly or retry.',
    )
  }
  assertValidVersion(version)
  return version
}

/** Fetch and parse the `.sha256` sidecar. Body is `<hex>` or `<hex>  <filename>`. */
export async function fetchReleaseChecksum(
  version: string,
  platform: Platform,
  http: ReleaseHttp,
): Promise<string> {
  const url = checksumUrl(version, platform)
  const res = await http.getText(url)
  if (res.statusCode !== 200) {
    throw new Error(
      `Could not fetch ${url} (HTTP ${res.statusCode}). ` +
        'Refusing to install an unverified binary. ' +
        'pass-cli releases before 2.1.2 are not published on GitHub Releases — see MIGRATION.md.',
    )
  }
  if (res.body.length > MAX_SIDECAR_BYTES) {
    throw new Error(`${url} is too large to be a checksum file. Refusing to install an unverified binary.`)
  }
  const hash = res.body.trim().split(/\s+/)[0] ?? ''
  if (!SHA256_RE.test(hash)) {
    throw new Error(`${url} did not contain a SHA-256 digest. Refusing to install an unverified binary.`)
  }
  return hash.toLowerCase()
}

/**
 * Turn the caller's inputs into one verified {version, url, sha256}.
 * Validation happens before any network call. The expected hash comes from
 * exactly one place: the `hash` input when given, otherwise the sidecar.
 */
export async function resolveInstallerSpec(
  versionInput: string,
  platform: Platform,
  hashInput: string,
  http: ReleaseHttp,
): Promise<InstallerSpec> {
  const suppliedHash = hashInput.trim() ? parseExpectedHash(hashInput) : null
  if (versionInput !== 'latest') assertValidVersion(versionInput)

  const version = versionInput === 'latest' ? await resolveLatestVersion(http) : versionInput
  const sha256 = suppliedHash ?? (await fetchReleaseChecksum(version, platform, http))
  return { version, platform, url: downloadUrl(version, platform), sha256 }
}
```

- [ ] **Step 4: Delete the manifest module and its test**

```bash
git rm src/installer/manifest.ts tests/unit/manifest.test.ts
```

- [ ] **Step 5: Run to verify pass**

```bash
node --test tests/unit/release.test.ts && npm run typecheck
```
Expected: release tests pass. **Typecheck FAILS** in `src/installer/install.ts` (imports `./manifest.ts`) — that is expected and fixed in Task 3. Do not commit a red typecheck: proceed straight to Task 3 and commit both together, **or** temporarily keep `manifest.ts` and delete it in Task 3. Recommended: do Task 3 now, one commit.

---

### Task 3: `install.ts` — wire to `release.ts`, pre-installed policy, HTTP adapter

**Files:**
- Modify: `src/installer/install.ts`
- Test: `tests/unit/install-policy.test.ts` (new)
- Existing: `tests/unit/verify-hash.test.ts` must keep passing.

**Interfaces:**
- Consumes: `resolveInstallerSpec`, `ReleaseHttp` from `release.ts`.
- Produces: `DEFAULT_PASS_CLI_VERSION = '2.3.3'`, `interface InstallOptions { version: string; hash: string; platform: string }`, `ensurePassCli(options: InstallOptions): Promise<void>`, `acceptsPreinstalled(versionOutput: string, requested: string): boolean`. `verifySha256` unchanged signature.

- [ ] **Step 1: Write the failing policy test**

`tests/unit/install-policy.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptsPreinstalled, DEFAULT_PASS_CLI_VERSION } from '../../src/installer/install.ts'

const MOCK_VERSION_OUTPUT = 'pass-cli 1.0.0 (mock)\n'

test('unset version accepts whatever pass-cli is already on PATH (install-cli-action interop)', () => {
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, ''), true)
})

test('latest accepts whatever pass-cli is already on PATH', () => {
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, 'latest'), true)
})

test('an explicit version must appear in --version output', () => {
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, '1.0.0'), true)
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, '2.3.3'), false)
})

test('the default is a pinned MAJOR.MINOR.PATCH, not latest', () => {
  assert.match(DEFAULT_PASS_CLI_VERSION, /^\d+\.\d+\.\d+$/)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test tests/unit/install-policy.test.ts
```
Expected: FAIL — `acceptsPreinstalled` not exported.

- [ ] **Step 3: Rewrite `src/installer/install.ts`**

Full replacement:

```ts
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as core from '@actions/core'
import { getExecOutput } from '@actions/exec'
import * as toolCache from '@actions/tool-cache'
import { HttpClient } from '@actions/http-client'
import { resolvePlatform, type Platform } from './platform.ts'
import { resolveInstallerSpec, type ReleaseHttp } from './release.ts'

const HTTP_USER_AGENT = 'load-secrets-proton-pass'

/**
 * Installed when the caller leaves `pass-cli-version` empty and nothing is
 * on PATH. Pinned (not "latest") for reproducible builds; bump deliberately
 * and re-run the real-vault e2e workflow.
 */
export const DEFAULT_PASS_CLI_VERSION = '2.3.3'

export interface InstallOptions {
  /** Raw `pass-cli-version` input: '' (unset), 'latest', or MAJOR.MINOR.PATCH. */
  readonly version: string
  /** Raw `hash` input; '' means fetch the release `.sha256` sidecar. */
  readonly hash: string
  /** Raw `platform` input; '' means auto-detect. */
  readonly platform: string
}

/**
 * Verify a downloaded file against an expected SHA-256 hex digest.
 * On mismatch the file is deleted before throwing so an unverified binary
 * can never be executed later. The actual digest of a potentially tampered
 * file is deliberately not included in the error message.
 */
export async function verifySha256(filePath: string, expectedHex: string): Promise<void> {
  const fileBytes = await fs.readFile(filePath)
  const actualHex = createHash('sha256').update(fileBytes).digest('hex')
  if (actualHex.toLowerCase() !== expectedHex.toLowerCase()) {
    await fs.rm(filePath, { force: true })
    throw new Error(
      'SHA-256 mismatch: the downloaded pass-cli binary does not match the expected checksum. Aborting.',
    )
  }
}

/**
 * Pre-installed acceptance policy. An unset or "latest" request accepts any
 * pass-cli already on PATH (e.g. from protonpass/install-cli-action). An
 * explicit version must appear in `pass-cli --version` output or we reinstall.
 */
export function acceptsPreinstalled(versionOutput: string, requested: string): boolean {
  if (requested === '' || requested === 'latest') return true
  return versionOutput.includes(requested)
}

/**
 * Ensure a pass-cli acceptable for the request is on PATH. Otherwise download
 * the GitHub release asset and refuse to proceed without a SHA-256 match
 * against either the caller's `hash` input or the release's `.sha256` sidecar.
 */
export async function ensurePassCli(options: InstallOptions): Promise<void> {
  const preinstalled = await installedVersion()
  if (preinstalled !== null) {
    if (acceptsPreinstalled(preinstalled, options.version)) {
      core.info(`pass-cli already installed: ${preinstalled}`)
      return
    }
    core.info(`Installed pass-cli (${preinstalled}) does not match requested (${options.version}), reinstalling`)
  }

  const requested = options.version === '' ? DEFAULT_PASS_CLI_VERSION : options.version
  const platform = resolvePlatform(options.platform)
  core.info(`Platform: ${platform}`)

  const spec = await resolveInstallerSpec(requested, platform, options.hash, releaseHttp())
  core.info(`Installing pass-cli ${spec.version} from ${spec.url}`)

  const downloadPath = await toolCache.downloadTool(spec.url)
  await verifySha256(downloadPath, spec.sha256)
  core.info('SHA-256 checksum verified')

  const cachedDir = await cacheBinary(downloadPath, spec.version, platform)
  core.addPath(cachedDir)
  core.info(`pass-cli ${spec.version} added to PATH`)
}

async function installedVersion(): Promise<string | null> {
  try {
    const result = await getExecOutput('pass-cli', ['--version'], {
      silent: true,
      ignoreReturnCode: true,
    })
    if (result.exitCode !== 0) return null
    return result.stdout.trim()
  } catch {
    return null
  }
}

async function cacheBinary(downloadPath: string, version: string, platform: Platform): Promise<string> {
  if (platform === 'windows-x86_64') {
    if (downloadPath.endsWith('.zip') || (await isZip(downloadPath))) {
      const extracted = await toolCache.extractZip(downloadPath)
      return toolCache.cacheDir(extracted, 'pass-cli', version)
    }
    return toolCache.cacheFile(downloadPath, 'pass-cli.exe', 'pass-cli', version)
  }

  await fs.chmod(downloadPath, 0o755)
  return toolCache.cacheFile(downloadPath, 'pass-cli', 'pass-cli', version)
}

async function isZip(filePath: string): Promise<boolean> {
  const ZIP_MAGIC = Buffer.from([0x50, 0x4b])
  const handle = await fs.open(filePath, 'r')
  try {
    const { buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0)
    return buffer.equals(ZIP_MAGIC)
  } finally {
    await handle.close()
  }
}

/**
 * Two clients: HEAD must NOT follow redirects (we read Location to learn the
 * latest tag); GET must follow them (release assets 302 to a CDN).
 */
function releaseHttp(): ReleaseHttp {
  const following = new HttpClient(HTTP_USER_AGENT)
  const nonFollowing = new HttpClient(HTTP_USER_AGENT, [], { allowRedirects: false })
  return {
    async head(url) {
      const res = await nonFollowing.head(url)
      await res.readBody()
      return { statusCode: res.message.statusCode ?? 0, location: res.message.headers.location }
    },
    async getText(url) {
      const res = await following.get(url)
      const body = await res.readBody()
      return { statusCode: res.message.statusCode ?? 0, body }
    },
  }
}
```

- [ ] **Step 4: Fix the one caller (temporary, finalized in Task 5)**

In `src/main.ts` change

```ts
    await ensurePassCli(inputs.passCliVersion)
```
to
```ts
    await ensurePassCli({ version: inputs.passCliVersion, hash: '', platform: '' })
```

- [ ] **Step 5: Verify unit + typecheck + lint, then build and run the full suite**

```bash
node --test tests/unit/install-policy.test.ts tests/unit/verify-hash.test.ts tests/unit/release.test.ts
npm run build:check
```
Expected: all pass (previous 92 − 6 manifest tests + 4 policy + 9 release ≈ 99). Integration + smoke still pass because the harness pins `pass-cli-version: 1.0.0` and the mock prints `pass-cli 1.0.0 (mock)`.

- [ ] **Step 6: Commit (includes the Task 2 deletions)**

```bash
git add src/installer tests/unit/release.test.ts tests/unit/install-policy.test.ts src/main.ts dist/
git commit -m "feat(installer)!: install from GitHub Releases + .sha256, drop versions.json

Proton's versions.json describes only the latest release (single object, not
the array this code expected), so every install failed closed with
'Unexpected versions.json schema' and pinning was impossible. Resolve the
version + expected hash from github.com/protonpass/pass-cli release assets
instead: 'latest' via the /releases/latest 302 redirect (no REST API, no
rate limit), pinned versions via <asset>.sha256. Default bumps 2.1.0 -> 2.3.3
(2.1.0 is not on GitHub Releases). Unset/latest now accept a pre-installed
pass-cli; an explicit version must still match or is reinstalled.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Inputs + `action.yml` — `hash`, `platform`, raw version, PAT env fallback (TDD)

**Files:**
- Modify: `src/inputs.ts`, `action.yml`
- Test: `tests/unit/inputs.test.ts` (new)

**Interfaces:**
- Produces: `ActionInputs` gains `passCliHash: string`, `platform: string`; `passCliVersion` is now the **raw** input (`''` when unset). `PAT_ENV_VAR = 'PROTON_PASS_PERSONAL_ACCESS_TOKEN'`. `readInputs(): ActionInputs` (throws when no PAT from either source).

- [ ] **Step 1: Write the failing tests**

`tests/unit/inputs.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readInputs, PAT_ENV_VAR } from '../../src/inputs.ts'

const INPUT_KEYS = [
  'INPUT_PERSONAL-ACCESS-TOKEN',
  'INPUT_ENV-TEMPLATE',
  'INPUT_PASS-CLI-VERSION',
  'INPUT_HASH',
  'INPUT_PLATFORM',
  'INPUT_MASK-VALUES',
  'INPUT_STRICT',
  'INPUT_OUTPUT-PATH',
  'INPUT_EXPORT-ENV',
  PAT_ENV_VAR,
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(INPUT_KEYS.map(k => [k, process.env[k]]))
  for (const k of INPUT_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of INPUT_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('PAT input wins over the environment variable', () => {
  process.env['INPUT_PERSONAL-ACCESS-TOKEN'] = 'pst_input::KEY'
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().pat, 'pst_input::KEY')
})

test('PAT falls back to PROTON_PASS_PERSONAL_ACCESS_TOKEN (upstream-compatible)', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().pat, 'pst_env::KEY')
})

test('no PAT anywhere is an actionable error naming both sources', () => {
  assert.throws(() => readInputs(), /personal-access-token.*PROTON_PASS_PERSONAL_ACCESS_TOKEN/s)
})

test('pass-cli-version is passed through raw: empty stays empty (installer applies the default)', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().passCliVersion, '')
  process.env['INPUT_PASS-CLI-VERSION'] = 'latest'
  assert.equal(readInputs().passCliVersion, 'latest')
})

test('hash and platform inputs are read raw and default to empty', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().passCliHash, '')
  assert.equal(readInputs().platform, '')
  process.env['INPUT_HASH'] = 'ABC'
  process.env['INPUT_PLATFORM'] = 'linux-aarch64'
  assert.equal(readInputs().passCliHash, 'ABC')
  assert.equal(readInputs().platform, 'linux-aarch64')
})

test('boolean defaults are unchanged: mask-values, strict, export-env all default true', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  const inputs = readInputs()
  assert.equal(inputs.maskValues, true)
  assert.equal(inputs.strict, true)
  assert.equal(inputs.exportEnv, true)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test tests/unit/inputs.test.ts
```
Expected: FAIL — `PAT_ENV_VAR` not exported; `passCliVersion` is `'2.1.0'` not `''`.

- [ ] **Step 3: Rewrite `src/inputs.ts`**

```ts
import * as core from '@actions/core'

/** Upstream protonpass/load-secret-action reads the PAT from this env var; we accept it as a fallback. */
export const PAT_ENV_VAR = 'PROTON_PASS_PERSONAL_ACCESS_TOKEN'

export interface ActionInputs {
  readonly pat: string
  readonly envTemplate: string
  /** Raw `pass-cli-version`: '' (unset), 'latest', or MAJOR.MINOR.PATCH. The installer applies the default. */
  readonly passCliVersion: string
  /** Raw `hash`: '' means fetch the release .sha256 sidecar. */
  readonly passCliHash: string
  /** Raw `platform`: '' means auto-detect. */
  readonly platform: string
  readonly maskValues: boolean
  readonly strict: boolean
  readonly outputPath: string
  readonly exportEnv: boolean
}

/**
 * Read and validate action inputs. The PAT is registered with the log
 * masker before this function returns — no code path sees it unmasked.
 * Boolean inputs follow the bash action's semantics: empty means the
 * documented default, anything other than the string "true" means false.
 */
export function readInputs(): ActionInputs {
  return {
    pat: readPat(),
    envTemplate: core.getInput('env-template'),
    passCliVersion: core.getInput('pass-cli-version'),
    passCliHash: core.getInput('hash'),
    platform: core.getInput('platform'),
    maskValues: booleanInput('mask-values', true),
    strict: booleanInput('strict', true),
    outputPath: core.getInput('output-path'),
    exportEnv: booleanInput('export-env', true),
  }
}

function readPat(): string {
  const pat = core.getInput('personal-access-token') || process.env[PAT_ENV_VAR] || ''
  if (pat === '') {
    throw new Error(
      `No Proton Pass token: set the personal-access-token input or the ${PAT_ENV_VAR} environment variable.`,
    )
  }
  core.setSecret(pat)
  return pat
}

function booleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name)
  if (raw === '') return defaultValue
  return raw.toLowerCase() === 'true'
}
```

- [ ] **Step 4: Update `action.yml` inputs**

Replace the `personal-access-token` and `pass-cli-version` blocks, and add `hash` + `platform` after `pass-cli-version`:

```yaml
  personal-access-token:
    description: 'Proton Pass Personal Access Token (`pst_xxxx::TOKENKEY`, from `pass-cli pat create`). Optional when the step sets the PROTON_PASS_PERSONAL_ACCESS_TOKEN environment variable instead (compatible with protonpass/load-secret-action).'
    required: false
  pass-cli-version:
    description: 'pass-cli version to install: MAJOR.MINOR.PATCH or `latest`. Leave empty (default) to install 2.3.3, or to accept any pass-cli already on PATH (e.g. from protonpass/install-cli-action). An explicit version is enforced: a different pre-installed pass-cli is replaced. Versions before 2.1.2 are not available.'
    required: false
    default: ''
  hash:
    description: 'Expected SHA-256 (64 hex chars) of the downloaded pass-cli binary. When empty the hash is fetched from the official `.sha256` release asset. Verification is mandatory either way; a mismatch fails the step.'
    required: false
    default: ''
  platform:
    description: 'Target platform, auto-detected when empty. One of: linux-x86_64, linux-aarch64, macos-x86_64, macos-aarch64, windows-x86_64.'
    required: false
    default: ''
```

- [ ] **Step 5: Run to verify pass**

```bash
node --test tests/unit/inputs.test.ts && npm run typecheck && npm run lint
```
Expected: 6 pass; clean. (`core.setSecret` prints `::add-mask::…` lines to stdout during the test — harmless.)

- [ ] **Step 6: Commit**

```bash
git add src/inputs.ts action.yml tests/unit/inputs.test.ts
git commit -m "feat(inputs): hash + platform inputs, raw pass-cli-version, PAT env fallback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Wire `main.ts`; integration tests for unset version + PAT via env

**Files:**
- Modify: `src/main.ts`
- Test: `tests/integration/install.integration.test.ts` (new)

**Interfaces:**
- Consumes: `ActionInputs.passCliVersion|passCliHash|platform` (Task 4), `ensurePassCli(InstallOptions)` (Task 3).

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/install.integration.test.ts`:

```ts
// Runs the BUILT dist/index.js against the mock pass-cli (already on PATH).
// Covers the pre-installed acceptance policy and the PAT env fallback.
// `npm run build` first — integration tests execute dist/, not src/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAction, MOCK_PAT } from '../helpers/run-action.ts'

const URI = 'pass://GithubActions/load-secrets-proton-pass-test/Password'

test('unset pass-cli-version accepts the pre-installed CLI without touching the network', async () => {
  const result = await runAction({ env: { DB_PASSWORD: URI }, inputs: { 'pass-cli-version': '' } })
  assert.equal(result.exitCode, 0, result.stdout)
  assert.match(result.stdout, /pass-cli already installed: pass-cli 1\.0\.0 \(mock\)/)
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password\n')
})

test('latest accepts the pre-installed CLI', async () => {
  const result = await runAction({ env: { DB_PASSWORD: URI }, inputs: { 'pass-cli-version': 'latest' } })
  assert.equal(result.exitCode, 0, result.stdout)
  assert.match(result.stdout, /already installed/)
})

test('PAT can come from PROTON_PASS_PERSONAL_ACCESS_TOKEN when the input is empty', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: URI, PROTON_PASS_PERSONAL_ACCESS_TOKEN: MOCK_PAT },
    inputs: { 'personal-access-token': '' },
  })
  assert.equal(result.exitCode, 0, result.stdout)
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password\n')
  assert.ok(!result.stdout.includes(MOCK_PAT), 'PAT must never appear in logs')
})

test('no PAT from either source fails with a message naming both', async () => {
  const result = await runAction({ env: { DB_PASSWORD: URI }, inputs: { 'personal-access-token': '' } })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.stdout, /personal-access-token.*PROTON_PASS_PERSONAL_ACCESS_TOKEN/s)
  assert.ok(!('DB_PASSWORD' in result.env))
})
```

- [ ] **Step 2: Build and run to verify failure**

```bash
npm run build && node --test tests/integration/install.integration.test.ts
```
Expected: the first two tests FAIL (installer still receives `hash: ''`/`platform: ''` literals but `passCliVersion` `''` now means "unset" — the mock is accepted, **so these may already pass**; the PAT-env test FAILS until `main.ts` is rebuilt with Task 4's inputs — it was built in Task 3 before Task 4). If everything passes already, that is fine: proceed.

- [ ] **Step 3: Finalize `main.ts`**

Replace the temporary call from Task 3 with:

```ts
    await ensurePassCli({
      version: inputs.passCliVersion,
      hash: inputs.passCliHash,
      platform: inputs.platform,
    })
```

- [ ] **Step 4: Build, run everything**

```bash
npm run build:check
```
Expected: all green (≈ 109 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/integration/install.integration.test.ts dist/
git commit -m "feat: wire hash/platform inputs; integration tests for preinstalled policy and PAT env

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: CI smoke — exercise the unset-version path

**Files:**
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Remove the explicit pin from three smoke jobs**

In `smoke-glob`, `smoke-template`, and `smoke-multiline`, delete the line

```yaml
          pass-cli-version: "1.0.0"
```

Leave `smoke` as is (it keeps `pass-cli-version: "1.0.0"` and the comment `# matches the mock's --version output`) so the explicit-match branch is exercised too. Add this comment above the `smoke-glob` job:

```yaml
  # No pass-cli-version here on purpose: exercises the "unset accepts the
  # pre-installed CLI" path (install-cli-action interop).
```

- [ ] **Step 2: Validate YAML and run one smoke locally through the runner simulator**

```bash
node -e "require('node:fs').readFileSync('.github/workflows/test.yml','utf8')" && npx @redwoodjs/agent-ci run --workflow tests/test-workflow.yml
```
Expected: simulator run green.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: smoke the unset pass-cli-version path against the pre-installed mock

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Real-vault e2e workflow (replaces `load-secrets.yml`; closes #17)

**Files:**
- Create: `.github/workflows/e2e-real.yml`
- Delete: `.github/workflows/load-secrets.yml`

This is the only job that runs the **real installer** (no mock on PATH), so it is the regression test for the P0. The repo secret `PROTON_PASS_PERSONAL_ACCESS_TOKEN` already exists (used by `load-secrets.yml`) and has read access to vault `GithubActions`, item `load-secrets-proton-pass-test` (fields include `Email`, `Password`).

- [ ] **Step 1: Write the workflow**

`.github/workflows/e2e-real.yml`:

```yaml
name: E2E (real Proton Pass)

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
  schedule:
    - cron: '17 6 * * 1' # weekly — catches upstream pass-cli release/asset changes

jobs:
  e2e:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    env:
      # `secrets` is not available in job-level `if`; gate steps on this instead.
      # Forks and dependabot have no secret -> every step below is skipped.
      HAS_PAT: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN != '' }}
    steps:
      - uses: actions/checkout@v6

      - name: Skipped (no PAT available)
        if: env.HAS_PAT != 'true'
        run: echo "PROTON_PASS_PERSONAL_ACCESS_TOKEN not available in this context; skipping real-vault e2e."

      # No mock on PATH: exercises the real GitHub release download + .sha256 verification
      # with the pinned default version.
      - name: Load secrets (literal + glob, default pass-cli)
        if: env.HAS_PAT == 'true'
        id: secrets
        uses: ./
        with:
          personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
        env:
          E2E_EMAIL: "pass://GithubActions/load-secrets-proton-pass-test/Email"
          E2E_ALL: "pass://GithubActions/load-secrets-proton-pass-test/*"

      - name: Assert literal resolved (env + step output)
        if: env.HAS_PAT == 'true'
        shell: bash
        env:
          OUT_EMAIL: ${{ steps.secrets.outputs.E2E_EMAIL }}
        run: |
          [[ -n "${E2E_EMAIL%$'\n'}" ]] || { echo "FAIL: E2E_EMAIL env empty"; exit 1; }
          [[ -n "${OUT_EMAIL%$'\n'}" ]] || { echo "FAIL: E2E_EMAIL step output empty"; exit 1; }
          echo "E2E_EMAIL resolved (masked): $E2E_EMAIL"

      - name: Assert glob expanded (issue #17)
        if: env.HAS_PAT == 'true'
        shell: bash
        env:
          RESOLVED_KEYS: ${{ steps.secrets.outputs.resolved-keys }}
        run: |
          echo "resolved-keys: $RESOLVED_KEYS"
          [[ "$RESOLVED_KEYS" == *"E2E_EMAIL"* ]] || { echo "FAIL: E2E_EMAIL missing from resolved-keys"; exit 1; }
          [[ "$RESOLVED_KEYS" == *"E2E_ALL_"* ]] || { echo "FAIL: glob produced no E2E_ALL_* keys"; exit 1; }

      # Second invocation: an explicit, different version must trigger a reinstall
      # (exercises the explicit-version branch + a second real download).
      - name: Reinstall on explicit version mismatch
        if: env.HAS_PAT == 'true'
        uses: ./
        with:
          personal-access-token: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
          pass-cli-version: "2.3.2"
        env:
          E2E_AGAIN: "pass://GithubActions/load-secrets-proton-pass-test/Email"

      - name: Assert reinstalled version is the requested one
        if: env.HAS_PAT == 'true'
        shell: bash
        run: |
          v="$(pass-cli --version)"
          echo "pass-cli --version: $v"
          [[ "$v" == *"2.3.2"* ]] || { echo "FAIL: expected pass-cli 2.3.2 on PATH"; exit 1; }
          [[ -n "${E2E_AGAIN%$'\n'}" ]] || { echo "FAIL: E2E_AGAIN empty after reinstall"; exit 1; }
```

- [ ] **Step 2: Delete the old workflow**

```bash
git rm .github/workflows/load-secrets.yml
```

- [ ] **Step 3: Commit and push; watch the run**

```bash
git add .github/workflows/e2e-real.yml
git commit -m "ci: real-vault e2e on 3 OS with real installer, literal + glob assertions

Replaces load-secrets.yml (which only echoed). Gated on secret presence via
job env so forks skip cleanly. Closes #17.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
gh run watch --exit-status "$(gh run list --workflow 'E2E (real Proton Pass)' --branch feat/typescript-node24-rewrite --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: 3/3 OS green. If Windows fails on the `pass-cli --version` step, the extracted zip's binary is `pass-cli.exe` inside the cached dir — `addPath` already covers it; check the job log for the actual PATH entry before changing code.

**If the e2e reveals that pass-cli 2.3.x changed `item view` output or `inject` behavior vs 2.1.0**, stop and report — do not paper over it in the mock. Update `docs/CLI-VERIFICATION.md` with what was observed.

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`, `MIGRATION.md`, `CLAUDE.md`, `docs/CLI-VERIFICATION.md`

- [ ] **Step 1: README — Inputs table**

Replace the `pass-cli-version` row and add `hash` + `platform` rows; loosen `personal-access-token`:

```markdown
| `personal-access-token` | No* | | Proton Pass PAT (`pst_xxxx::TOKENKEY`). *Required unless the step sets the `PROTON_PASS_PERSONAL_ACCESS_TOKEN` env var (upstream-compatible). |
| `pass-cli-version` | No | `''` → `2.3.3` | `MAJOR.MINOR.PATCH` or `latest`. Empty installs the pinned default **or** accepts any `pass-cli` already on PATH (e.g. from `protonpass/install-cli-action`). An explicit version is enforced. Minimum `2.1.2`. |
| `hash` | No | `''` | Expected SHA-256 of the `pass-cli` download. Empty → fetched from the release's official `.sha256` asset. Always verified. |
| `platform` | No | auto | `linux-x86_64`, `linux-aarch64`, `macos-x86_64`, `macos-aarch64`, `windows-x86_64`. |
```

- [ ] **Step 2: README — add a "Pin the CLI version and hash" usage example** after "Environment variables (default)":

````markdown
### Pin the CLI version and hash

```yaml
- uses: gizmodlabs/load-secrets-proton-pass@v2
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
````

- [ ] **Step 3: README — add "Using with protonpass/install-cli-action"** after the pin example:

````markdown
### Using with `protonpass/install-cli-action`

If `pass-cli` is already on PATH and you leave `pass-cli-version` empty, the action uses it as-is.

```yaml
- uses: protonpass/install-cli-action@v1
  with:
    version: "2.3.3"
- uses: gizmodlabs/load-secrets-proton-pass@v2
  env:
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: ${{ secrets.PROTON_PASS_PERSONAL_ACCESS_TOKEN }}
    API_KEY: "pass://Production/Stripe/secret-key"
```
````

- [ ] **Step 4: README — keep consumer `uses:` lines on `@v1`, and fix the `versions.json` mention**

> User override (2026-09-03): do not change this repository's consumer examples
> to `@v2`; keep `uses: gizmodlabs/load-secrets-proton-pass@v1`.

```bash
grep -n '@v1' README.md examples/*.yml
```
Leave each `uses: gizmodlabs/load-secrets-proton-pass@v1` unchanged. In the Inputs table the old text "any version listed at proton.me/download/pass-cli/versions.json" is gone (Step 1). Add to the "Requirements" section: `pass-cli` ≥ 2.1.2 (GitHub Releases).

- [ ] **Step 5: MIGRATION.md — "New in v2" additions and "Behavior changes"**

Under **New in v2**, replace the "Fail-closed installer" bullet with:

```markdown
- **Fail-closed installer, sourced from GitHub Releases.** v1 piped Proton's
  `install.sh` to bash, unverified. v2 downloads
  `github.com/protonpass/pass-cli` release assets and refuses to run a binary
  whose SHA-256 does not match the release's `.sha256` asset (or your `hash`
  input). Proton's `versions.json` is no longer used: it describes only the
  latest release, so it cannot verify a pinned version.
- **`hash` and `platform` inputs** (same names and semantics as
  `protonpass/load-secret-action` / `protonpass/install-cli-action`).
- **PAT via environment.** `PROTON_PASS_PERSONAL_ACCESS_TOKEN` on the step is
  accepted when the `personal-access-token` input is empty, so upstream
  workflows are drop-in.
- **Pre-installed CLI is respected.** With `pass-cli-version` unset (or
  `latest`), a `pass-cli` already on PATH — e.g. from
  `protonpass/install-cli-action` — is used as-is.
```

Under **Behavior changes to be aware of**, add:

```markdown
- **Default `pass-cli` is 2.3.3 (was 2.1.0), minimum 2.1.2.** Releases before
  2.1.2 are not published on GitHub Releases and cannot be verified, so
  `pass-cli-version: 2.1.0` now fails with an explicit error. Pin `2.1.2` or
  newer, or leave the input empty.
- **An explicit `pass-cli-version` is enforced.** If a different `pass-cli` is
  already on PATH it is replaced. Leave the input empty to accept whatever is
  installed.
```

- [ ] **Step 6: CLAUDE.md — installer bullet**

Replace the `src/installer/` bullet under Architecture with:

```markdown
- `src/installer/` — platform detection (5 targets incl. `windows-x86_64`); **GitHub Releases** as the only source: `release.ts` builds asset URLs, resolves `latest` via the `/releases/latest` 302 `Location` (no REST API → no rate limit), and takes the expected SHA-256 from the caller's `hash` input or the asset's `.sha256` sidecar; `install.ts` downloads, **fail-closed verifies** (mismatch deletes the file; no expected hash ⇒ abort), caches, `addPath`. `DEFAULT_PASS_CLI_VERSION` (pinned) applies when the input is empty. Pre-installed policy: unset/`latest` accept any `pass-cli` on PATH (this is how tests inject the mock); explicit versions must match `--version` output or are reinstalled. Proton's `versions.json` is NOT used — it is latest-only.
```

Also update the "Common commands" note for the real e2e: replace "Full workflow simulation" line's neighbor with a mention that `.github/workflows/e2e-real.yml` is the only job that exercises the real installer.

- [ ] **Step 7: docs/CLI-VERIFICATION.md**

Add under "Verified Commands": the version the e2e ran against (`2.3.3`, from the Task 7 job log), and note any output differences observed vs 2.1.0. Add under "Sources": `https://github.com/protonpass/pass-cli/releases` (assets + `.sha256`) and the observation that `https://proton.me/download/pass-cli/versions.json` is a single latest-only object (`formatVersion: 1`).

- [ ] **Step 8: Commit**

```bash
git add README.md MIGRATION.md CLAUDE.md docs/CLI-VERIFICATION.md examples/
git commit -m "docs: GitHub Releases installer, hash/platform inputs, PAT env fallback, v2 refs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Final verification, undraft, release checklist

- [ ] **Step 1: Clean-room gate**

```bash
rm -rf node_modules dist/*.js && npm ci && npm run build:check && git status --short
```
Expected: green; `git status` shows **no** changes (dist committed and fresh; no lockfile drift).

- [ ] **Step 2: Manual smoke of the real installer on this machine (no mock, real network)**

```bash
cd "$(mktemp -d)" && export RUNNER_TEMP="$PWD" RUNNER_TOOL_CACHE="$PWD/tool-cache" GITHUB_ENV="$PWD/env" GITHUB_OUTPUT="$PWD/out" GITHUB_PATH="$PWD/path" && mkdir -p tool-cache && : > env && : > out && : > path
INPUT_PERSONAL-ACCESS-TOKEN=invalid::x PATH="/usr/bin:/bin" node /Users/martin/workspace/load-secrets-proton-pass/dist/index.js
```
Expected log: `Platform: macos-aarch64`, `Installing pass-cli 2.3.3 from https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-macos-aarch64`, `SHA-256 checksum verified`, `pass-cli 2.3.3 added to PATH`, then a login failure (invalid PAT) — the installer path is proven. (Setting `INPUT_PERSONAL-ACCESS-TOKEN` with a hyphen needs `env 'INPUT_PERSONAL-ACCESS-TOKEN=invalid::x' node …` in zsh.)

- [ ] **Step 3: CI green on the PR**

```bash
gh pr checks --watch
```
Expected: `check` ×3, `dist-freshness`, `smoke*` ×12, `E2E (real Proton Pass)` ×3 all green.

- [ ] **Step 4: Undraft, request review**

```bash
gh pr ready
gh pr edit --add-label "breaking-change" 2>/dev/null || true
```

- [ ] **Step 5: Release (after merge to `main`)**

```bash
git checkout main && git pull
git tag v2.0.0 && git push origin v2.0.0   # release.yml packages, attests, and moves the floating `v2` tag
```
`v1` stays pointing at the bash action; existing `@v1` consumers are unaffected until they opt into `@v2` (MIGRATION.md).

---

## Definition of done

- [ ] `npm run build:check` green locally on macOS; CI `check` green on ubuntu/macos/windows.
- [ ] `dist-freshness` green.
- [ ] `E2E (real Proton Pass)` green on 3 OS: real download, SHA-256 verified, literal + glob resolved, reinstall on explicit mismatch.
- [ ] `resolveInstallerSpec` has **zero** references to `versions.json`; `grep -rn versions.json src/` returns nothing.
- [ ] Consumer examples in `README.md` and `examples/` still use `gizmodlabs/load-secrets-proton-pass@v1` per the user override.
- [ ] Issues #16 and #17 closed by the PR.
- [ ] `package-lock.json` tracked, `pnpm-lock.yaml` absent.

## Self-review notes (already applied)

- Spec coverage: every "Adopt/Adapt" row in the comparison table maps to a task (1–7); every "Reject" row is documented in MIGRATION/CLAUDE.md language via Task 8.
- Type consistency: `InstallOptions{version,hash,platform}` (Task 3) ⇄ `ActionInputs{passCliVersion,passCliHash,platform}` (Task 4) ⇄ `main.ts` wiring (Task 5). `ReleaseHttp{head,getText}` (Task 1) ⇄ `releaseHttp()` adapter (Task 3) ⇄ `fakeHttp` (Task 2 tests).
- Test-count arithmetic in Task 3/5 is approximate; the assertion that matters is `fail 0`.
