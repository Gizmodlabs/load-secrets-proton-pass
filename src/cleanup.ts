import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as core from '@actions/core'
import { runPassCli } from './pass-cli.ts'
import { PAT_FINGERPRINT_FILE, SESSION_DIR_OWNED_STATE_KEY, SESSION_DIR_STATE_KEY } from './session/session.ts'

/**
 * Post-job cleanup entry point. Always runs (action.yml `post:`), regardless
 * of job outcome. Logs the session out and removes session state; failures
 * here are warnings — cleanup must never fail the job.
 */
export async function cleanup(): Promise<void> {
  const sessionDir = core.getState(SESSION_DIR_STATE_KEY)
  if (!sessionDir) {
    core.info('No Proton Pass session state was saved; skipping cleanup')
    return
  }

  const owned = core.getState(SESSION_DIR_OWNED_STATE_KEY) === 'true'
  await logout(sessionDir)
  await removeSessionDir(sessionDir, owned)
  core.info('Proton Pass session cleaned up')
}

async function logout(sessionDir: string): Promise<void> {
  try {
    const result = await runPassCli(['logout'], {
      PROTON_PASS_SESSION_DIR: sessionDir,
      PROTON_PASS_KEY_PROVIDER: 'fs',
    })
    if (result.exitCode !== 0) {
      core.warning(`pass-cli logout exited with code ${result.exitCode} (continuing)`)
    }
  } catch (err) {
    core.warning(`pass-cli logout failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function removeSessionDir(sessionDir: string, owned: boolean): Promise<void> {
  try {
    if (owned) {
      await fs.rm(sessionDir, { recursive: true, force: true })
      return
    }
    await fs.rm(join(sessionDir, PAT_FINGERPRINT_FILE), { force: true })
  } catch (err) {
    core.warning(`Could not remove Proton Pass session state: ${err instanceof Error ? err.message : String(err)}`)
  }
}

void cleanup()
