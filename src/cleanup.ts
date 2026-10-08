import * as core from '@actions/core'
import { closeSession, SESSION_DIR_OWNED_STATE_KEY, SESSION_DIR_STATE_KEY } from './session/session.ts'

/**
 * Post-job cleanup entry point. Always runs (action.yml `post:`), regardless
 * of job outcome. Logs the session out and removes session state; failures
 * here are warnings — cleanup must never fail the job.
 */
export async function cleanup(): Promise<void> {
  const dir = core.getState(SESSION_DIR_STATE_KEY)
  if (!dir) {
    // Nothing was started, or outputs-only mode already ended the session.
    core.info('No Proton Pass session left to clean up; skipping cleanup')
    return
  }

  await closeSession({ dir, owned: core.getState(SESSION_DIR_OWNED_STATE_KEY) === 'true' })
  core.info('Proton Pass session cleaned up')
}

void cleanup()
