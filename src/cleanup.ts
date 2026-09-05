import { promises as fs } from 'node:fs'
import * as core from '@actions/core'
import { runPassCli } from './pass-cli.ts'
import { SESSION_DIR_STATE_KEY } from './session/session.ts'

/**
 * Post-job cleanup entry point. Always runs (action.yml `post:`), regardless
 * of job outcome. Logs the session out and removes session state; failures
 * here are warnings — cleanup must never fail the job.
 */
export async function cleanup(): Promise<void> {
  await logout()
  await removeSessionDir()
  core.info('Proton Pass session cleaned up')
}

async function logout(): Promise<void> {
  try {
    const result = await runPassCli(['logout'])
    if (result.exitCode !== 0) {
      core.warning(`pass-cli logout exited with code ${result.exitCode} (continuing)`)
    }
  } catch (err) {
    core.warning(`pass-cli logout failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function removeSessionDir(): Promise<void> {
  const sessionDir = core.getState(SESSION_DIR_STATE_KEY)
  if (!sessionDir) return
  try {
    await fs.rm(sessionDir, { recursive: true, force: true })
  } catch (err) {
    core.warning(`Could not remove session dir: ${err instanceof Error ? err.message : String(err)}`)
  }
}

void cleanup()
