import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, chmodSync, mkdtempSync, readFileSync, writeFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import { runPassCli, stderrDetail, type CliRunner } from '../pass-cli.ts'

/**
 * Name of the file (inside the session dir) recording which PAT the current
 * pass-cli session was minted from. Holds a SHA-256 of the token — never the
 * token itself.
 */
export const PAT_FINGERPRINT_FILE = '.pat-fingerprint'

/** State key used to hand the session dir to the post-job cleanup entry. */
export const SESSION_DIR_STATE_KEY = 'session-dir'
/** Whether this action invocation created the session directory. */
export const SESSION_DIR_OWNED_STATE_KEY = 'session-dir-owned'

const OWNER_ONLY_DIR = 0o700
const OWNER_ONLY_FILE = 0o600

export interface Session {
  readonly dir: string
  /** This invocation created the directory, so it may delete it. */
  readonly owned: boolean
}

export interface SessionOptions {
  /**
   * Export PROTON_PASS_SESSION_DIR and PROTON_PASS_KEY_PROVIDER to later
   * steps, so their own pass-cli calls (and a later invocation of this
   * action) reuse the session. Off in outputs-only mode, where nothing the
   * step sets up may outlive it.
   */
  readonly shareWithLaterSteps: boolean
}

/**
 * Ensure an authenticated pass-cli session bound to this exact PAT.
 *
 * A session is reused only when `pass-cli info` succeeds AND the recorded
 * PAT fingerprint matches the supplied token. Any valid session minted from
 * a different (or unknown) PAT is logged out and replaced — secrets are
 * never resolved against a session that does not match the token we were
 * handed.
 *
 * The session directory is saved to action state for cleanup before login.
 */
export async function establishSession(
  pat: string,
  runner: CliRunner = runPassCli,
  options: SessionOptions = { shareWithLaterSteps: true },
): Promise<Session> {
  const session = prepareSessionDir()
  const sessionDir = session.dir
  // Save cleanup state before authentication. A successful login followed by
  // a failed probe must still be able to clean up the directory it created.
  core.saveState(SESSION_DIR_STATE_KEY, sessionDir)
  core.saveState(SESSION_DIR_OWNED_STATE_KEY, String(session.owned))
  pointPassCliAt(sessionDir, options.shareWithLaterSteps)

  const fingerprint = patFingerprint(pat)
  const probe = await runner(['info'])

  if (probe.exitCode === 0 && recordedFingerprint(sessionDir) === fingerprint) {
    core.info('pass-cli session already active for this token, skipping login')
    return session
  }

  if (probe.exitCode === 0) {
    core.info('Existing pass-cli session does not match the supplied token, replacing it')
    await runner(['logout'])
  }

  core.info('Logging in to Proton Pass...')
  const login = await runner(['login'], { PROTON_PASS_PERSONAL_ACCESS_TOKEN: pat })
  if (login.exitCode !== 0) {
    const detail = stderrDetail(login)
    throw new Error(
      `pass-cli login failed (exit code ${login.exitCode}${detail ? `: ${detail}` : ''}). ` +
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
  return session
}

/**
 * Log out, then remove what this invocation created: the whole directory
 * when it made it, else only the fingerprint, so a caller-provided directory
 * survives. Never throws: a failed cleanup is a warning, not a failed job.
 */
export async function closeSession(session: Session, runner: CliRunner = runPassCli): Promise<void> {
  try {
    const result = await runner(['logout'], {
      PROTON_PASS_SESSION_DIR: session.dir,
      PROTON_PASS_KEY_PROVIDER: 'fs',
    })
    if (result.exitCode !== 0) {
      core.warning(`pass-cli logout exited with code ${result.exitCode} (continuing)`)
    }
  } catch (err) {
    core.warning(`pass-cli logout failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    if (session.owned) {
      await fs.rm(session.dir, { recursive: true, force: true })
      return
    }
    await fs.rm(join(session.dir, PAT_FINGERPRINT_FILE), { force: true })
  } catch (err) {
    core.warning(`Could not remove Proton Pass session state: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * End the session before the step finishes (outputs-only mode) and clear the
 * saved state, so the post step finds nothing left to do.
 */
export async function endSessionNow(session: Session, runner: CliRunner = runPassCli): Promise<void> {
  await closeSession(session, runner)
  core.saveState(SESSION_DIR_STATE_KEY, '')
  core.info('Proton Pass session ended; later steps cannot use it')
}

export function patFingerprint(pat: string): string {
  return createHash('sha256').update(pat).digest('hex')
}

function prepareSessionDir(): Session {
  const configured = process.env.PROTON_PASS_SESSION_DIR
  if (configured) {
    rejectSymlink(configured)
    const existed = directoryExists(configured)
    mkdirSync(configured, { recursive: true, mode: OWNER_ONLY_DIR })
    chmodSync(configured, OWNER_ONLY_DIR)
    return { dir: configured, owned: !existed }
  }
  const base = process.env.RUNNER_TEMP || tmpdir()
  return { dir: mkdtempSync(join(base, 'proton-pass-session-')), owned: true }
}

function directoryExists(dir: string): boolean {
  try {
    lstatSync(dir)
    return true
  } catch {
    return false
  }
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

/** This process's pass-cli calls always use the session; later steps only when shared. */
function pointPassCliAt(sessionDir: string, shareWithLaterSteps: boolean): void {
  process.env.PROTON_PASS_SESSION_DIR = sessionDir
  process.env.PROTON_PASS_KEY_PROVIDER = 'fs'
  if (!shareWithLaterSteps) return
  core.exportVariable('PROTON_PASS_SESSION_DIR', sessionDir)
  core.exportVariable('PROTON_PASS_KEY_PROVIDER', 'fs')
}

function recordedFingerprint(sessionDir: string): string | null {
  try {
    return readFileSync(join(sessionDir, PAT_FINGERPRINT_FILE), 'utf8').trim()
  } catch {
    return null
  }
}
