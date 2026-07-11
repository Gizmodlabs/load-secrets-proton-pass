import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as core from '@actions/core'
import { getExecOutput } from '@actions/exec'
import * as toolCache from '@actions/tool-cache'
import { HttpClient } from '@actions/http-client'
import { resolvePlatform, type Platform } from './platform.ts'
import { resolveInstallerSpec, VERSIONS_MANIFEST_URL } from './manifest.ts'

const HTTP_USER_AGENT = 'load-secrets-proton-pass'

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
      'SHA-256 mismatch: the downloaded pass-cli binary does not match the checksum in versions.json. Aborting.',
    )
  }
}

/**
 * Ensure a pass-cli matching the requested version is on PATH.
 * Skips installation when a matching binary is already present (this is how
 * tests pre-install the mock). Otherwise downloads from the URL listed in
 * versions.json and refuses to proceed without a successful SHA-256 check.
 */
export async function ensurePassCli(versionInput: string, platformInput = ''): Promise<void> {
  const preinstalled = await installedVersion()
  if (preinstalled !== null) {
    if (versionInput === 'latest' || preinstalled.includes(versionInput)) {
      core.info(`pass-cli already installed: ${preinstalled}`)
      return
    }
    core.info(
      `Installed pass-cli (${preinstalled}) does not match requested (${versionInput}), reinstalling`,
    )
  }

  const platform = resolvePlatform(platformInput)
  core.info(`Platform: ${platform}`)

  const spec = await resolveInstallerSpec(versionInput, platform, fetchJson)
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

async function cacheBinary(
  downloadPath: string,
  version: string,
  platform: Platform,
): Promise<string> {
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

async function fetchJson(url: string): Promise<unknown> {
  const client = new HttpClient(HTTP_USER_AGENT)
  try {
    const response = await client.getJson<unknown>(url)
    if (response.statusCode !== 200 || response.result === null) {
      throw new Error(`HTTP ${response.statusCode} from ${url}`)
    }
    return response.result
  } finally {
    client.dispose()
  }
}

/** Exported for error messages and docs. */
export { VERSIONS_MANIFEST_URL }
