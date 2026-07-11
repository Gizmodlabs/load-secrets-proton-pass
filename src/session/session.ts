import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import { runPassCli, type CliRunner } from '../pass-cli.ts'

/**
 * Name of the file (inside the session dir) recording which PAT the current
 * pass-cli session was minted from. Holds a SHA-256 of the token — never the
 * token itself.
 */
export const PAT_FINGERPRINT_FILE = '.pat-fingerprint'

/** State key used to hand the session dir to the post-job cleanup entry. */
export const SESSION_DIR_STATE_KEY = 'session-dir'

const OWNER_ONLY_DIR = 0o700
const OWNER_ONLY_FILE = 0o600

/**
 * Ensure an authenticated pass-cli session bound to this exact PAT.
 *
 * A session is reused only when `pass-cli info` succeeds AND the recorded
 * PAT fingerprint matches the supplied token. Any valid session minted from
 * a different (or unknown) PAT is logged out and replaced — secrets are
 * never resolved against a session that does not match the token we were
 * handed.
 *
 * Returns the session directory (also saved to action state for cleanup).
 */
export async function establishSession(pat: string, runner: CliRunner = runPassCli): Promise<string> {
  const sessionDir = prepareSessionDir()
  exportSessionEnv(sessionDir)

  const fingerprint = patFingerprint(pat)
  const probe = await runner(['info'])

  if (probe.exitCode === 0 && recordedFingerprint(sessionDir) === fingerprint) {
    core.info('pass-cli session already active for this token, skipping login')
    core.saveState(SESSION_DIR_STATE_KEY, sessionDir)
    return sessionDir
  }

  if (probe.exitCode === 0) {
    core.info('Existing pass-cli session does not match the supplied token, replacing it')
    await runner(['logout'])
  }

  core.info('Logging in to Proton Pass...')
  const login = await runner(['login'], { PROTON_PASS_PERSONAL_ACCESS_TOKEN: pat })
  if (login.exitCode !== 0) {
    throw new Error(
      `pass-cli login failed (exit code ${login.exitCode}). ` +
        'Check that the personal access token is valid, unexpired, and has vault access.',
    )
  }

  const verify = await runner(['info'])
  if (verify.exitCode !== 0) {
    throw new Error(
      'Proton Pass authentication failed: login succeeded but the session probe did not. ' +
        'Check that the PAT resolved to a working session.',
    )
  }

  writeFileSync(join(sessionDir, PAT_FINGERPRINT_FILE), fingerprint, { mode: OWNER_ONLY_FILE })
  core.info('Authenticated with Proton Pass')
  core.saveState(SESSION_DIR_STATE_KEY, sessionDir)
  return sessionDir
}

export function patFingerprint(pat: string): string {
  return createHash('sha256').update(pat).digest('hex')
}

function prepareSessionDir(): string {
  const configured = process.env.PROTON_PASS_SESSION_DIR
  if (configured) {
    rejectSymlink(configured)
    mkdirSync(configured, { recursive: true, mode: OWNER_ONLY_DIR })
    chmodSync(configured, OWNER_ONLY_DIR)
    return configured
  }
  const base = process.env.RUNNER_TEMP || tmpdir()
  return mkdtempSync(join(base, 'proton-pass-session-'))
}

function rejectSymlink(dir: string): void {
  let stat
  try {
    stat = lstatSync(dir)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`PROTON_PASS_SESSION_DIR is a symbolic link, refusing to use it: ${dir}`)
  }
}

function exportSessionEnv(sessionDir: string): void {
  process.env.PROTON_PASS_SESSION_DIR = sessionDir
  core.exportVariable('PROTON_PASS_SESSION_DIR', sessionDir)
  process.env.PROTON_PASS_KEY_PROVIDER = 'fs'
  core.exportVariable('PROTON_PASS_KEY_PROVIDER', 'fs')
}

function recordedFingerprint(sessionDir: string): string | null {
  try {
    return readFileSync(join(sessionDir, PAT_FINGERPRINT_FILE), 'utf8').trim()
  } catch {
    return null
  }
}
