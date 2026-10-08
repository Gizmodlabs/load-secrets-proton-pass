import * as core from '@actions/core'
import { readInputs } from './inputs.ts'
import { ensurePassCli } from './installer/install.ts'
import { endSessionNow, establishSession, type Session } from './session/session.ts'
import { findSecretRefs } from './resolver/env-scan.ts'
import { resolveSecrets } from './resolver/resolver.ts'
import { exportSecrets, resolvedKeysCsv } from './export/exporter.ts'
import { injectTemplate } from './template/inject.ts'
import { formatFailure } from './domain/resolution.ts'
import { agentReasonContext } from './domain/agent-reason.ts'
import type { ResolutionReport } from './domain/resolution.ts'

const RESOLVED_KEYS_OUTPUT = 'resolved-keys'

/**
 * Main action flow:
 * install-cli -> verify-sha256 -> login(session, pat)
 *   -> resolve(secrets|glob) -> export(output | env) -> template -> done.
 * The post entry (cleanup.ts) logs out regardless of what happens here.
 *
 * With export-env false the step leaves nothing behind for later steps: no
 * secret env vars, and no live session they could read the vault through.
 * The session is not exported and ends before the step does. A session dir
 * the caller provided is theirs to share, so it stays for the post step.
 */
export async function run(): Promise<void> {
  let stepScopedSession: Session | undefined
  try {
    const inputs = readInputs()

    await ensurePassCli({
      version: inputs.passCliVersion,
      hash: inputs.passCliHash,
      platform: inputs.platform,
    })
    const session = await establishSession(inputs.pat, undefined, { shareWithLaterSteps: inputs.exportEnv })
    if (!inputs.exportEnv && session.owned) stepScopedSession = session

    const annotate = inputs.strict ? core.error : core.warning
    const agentReason = agentReasonContext(inputs.agentReason, process.env)
    const refs = findSecretRefs(process.env)
    if (refs.length === 0) core.info('No pass:// references found in environment variables')

    const report = await resolveSecrets(refs, { annotate, agentReason })
    exportSecrets(report.resolved, { maskValues: inputs.maskValues, exportEnv: inputs.exportEnv })

    // Written before any strict-mode failure so downstream `if: always()`
    // steps can still inspect what did resolve.
    core.setOutput(RESOLVED_KEYS_OUTPUT, resolvedKeysCsv(report.resolved))

    if (!reportFailures(report, inputs.strict, annotate)) return
    core.info(`Resolved ${report.resolved.length} secret(s) from Proton Pass`)

    if (inputs.envTemplate) {
      await injectTemplate({
        templatePath: inputs.envTemplate,
        outputPathInput: inputs.outputPath,
        maskValues: inputs.maskValues,
        agentReason,
      })
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  } finally {
    if (stepScopedSession) await endSessionNow(stepScopedSession)
  }
}

/** Returns false when strict mode failed the step (caller must stop). */
function reportFailures(
  report: ResolutionReport,
  strict: boolean,
  annotate: (message: string) => void,
): boolean {
  if (report.failures.length === 0) return true

  annotate(`Failed to resolve ${report.failures.length} secret(s):`)
  for (const failure of report.failures) {
    annotate(`  ${formatFailure(failure)}`)
  }

  if (strict) {
    core.setFailed(
      `Failed to resolve ${report.failures.length} secret(s). See the report above (names and URIs only).`,
    )
    return false
  }

  core.info(`Continuing despite ${report.failures.length} unresolved secret(s) (strict=false)`)
  return true
}
