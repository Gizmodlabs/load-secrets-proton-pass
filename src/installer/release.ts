import type { Platform } from './platform.ts'
import type { InstallerSpec } from '../domain/installer-spec.ts'

/**
 * pass-cli binaries and their `.sha256` sidecars are published as GitHub
 * release assets. The latest-only Proton download manifest cannot verify a
 * pinned version, so it is deliberately not part of the install path.
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
