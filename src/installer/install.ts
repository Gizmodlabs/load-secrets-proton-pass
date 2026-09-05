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
