import type { Platform } from './platform.ts'
import type { InstallerSpec } from '../domain/installer-spec.ts'

export const VERSIONS_MANIFEST_URL = 'https://proton.me/download/pass-cli/versions.json'

export type FetchJson = (url: string) => Promise<unknown>

interface ManifestAsset {
  readonly url: string
  readonly hash: string
}

interface ManifestVersion {
  readonly version: string
  readonly assets: ReadonlyMap<Platform, ManifestAsset>
}

/**
 * Resolve the version input (`latest` or a pinned version) into a concrete
 * {version, url, sha256} for the given platform.
 *
 * Fails closed at every step: an unreachable manifest, an unknown version,
 * a missing platform entry, or a missing hash all abort the install. No
 * unverified binary is ever produced from this path.
 */
export async function resolveInstallerSpec(
  versionInput: string,
  platform: Platform,
  fetchJson: FetchJson,
): Promise<InstallerSpec> {
  const manifest = await fetchManifest(fetchJson)
  const versions = parseManifest(manifest)

  const entry = selectVersion(versions, versionInput)
  const asset = entry.assets.get(platform)
  if (!asset) {
    throw new Error(
      `versions.json has no download for platform "${platform}" at pass-cli ${entry.version}. ` +
        `Refusing to install an unverifiable binary.`,
    )
  }
  if (!asset.hash) {
    throw new Error(
      `versions.json is missing the SHA-256 hash for pass-cli ${entry.version} (${platform}). ` +
        `Refusing to install an unverifiable binary.`,
    )
  }

  return { version: entry.version, platform, url: asset.url, sha256: asset.hash }
}

async function fetchManifest(fetchJson: FetchJson): Promise<unknown> {
  try {
    return await fetchJson(VERSIONS_MANIFEST_URL)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not fetch ${VERSIONS_MANIFEST_URL} to verify the pass-cli download: ${detail}. ` +
        `Refusing to install an unverified binary.`,
    )
  }
}

function parseManifest(manifest: unknown): ManifestVersion[] {
  const versionList = (manifest as { passCliVersions?: unknown })?.passCliVersions
  if (!Array.isArray(versionList) || versionList.length === 0) {
    throw new Error(
      'Unexpected versions.json schema: expected a non-empty "passCliVersions" array. ' +
        'Refusing to install an unverifiable binary.',
    )
  }
  return versionList.map(parseVersionEntry).filter((entry): entry is ManifestVersion => entry !== null)
}

function parseVersionEntry(raw: unknown): ManifestVersion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, urls } = raw as { version?: unknown; urls?: unknown }
  if (typeof version !== 'string' || typeof urls !== 'object' || urls === null) return null

  const assets = new Map<Platform, ManifestAsset>()
  for (const [os, archMap] of Object.entries(urls as Record<string, unknown>)) {
    if (typeof archMap !== 'object' || archMap === null) continue
    for (const [arch, asset] of Object.entries(archMap as Record<string, unknown>)) {
      const parsed = parseAsset(asset)
      if (parsed) assets.set(`${os}-${arch}` as Platform, parsed)
    }
  }
  return { version, assets }
}

function parseAsset(raw: unknown): ManifestAsset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { url, hash } = raw as { url?: unknown; hash?: unknown }
  if (typeof url !== 'string' || url.length === 0) return null
  return { url, hash: typeof hash === 'string' ? hash : '' }
}

function selectVersion(versions: ManifestVersion[], versionInput: string): ManifestVersion {
  if (versionInput !== 'latest') {
    const match = versions.find(entry => entry.version === versionInput)
    if (!match) {
      const known = versions.map(entry => entry.version).join(', ')
      throw new Error(
        `pass-cli version "${versionInput}" not found in versions.json (known: ${known}).`,
      )
    }
    return match
  }

  const sorted = [...versions].sort((a, b) => compareSemver(b.version, a.version))
  const newest = sorted[0]
  if (!newest) {
    throw new Error('versions.json lists no usable pass-cli versions.')
  }
  return newest
}

function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  const length = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
