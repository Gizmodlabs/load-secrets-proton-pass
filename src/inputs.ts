import * as core from '@actions/core'

/** Upstream protonpass/load-secret-action reads the PAT from this env var; we accept it as a fallback. */
export const PAT_ENV_VAR = 'PROTON_PASS_PERSONAL_ACCESS_TOKEN'

export interface ActionInputs {
  readonly pat: string
  readonly envTemplate: string
  /** Raw `pass-cli-version`: '' (unset), 'latest', or MAJOR.MINOR.PATCH. The installer applies the default. */
  readonly passCliVersion: string
  /** Raw `hash`: '' means fetch the release .sha256 sidecar. */
  readonly passCliHash: string
  /** Raw `platform`: '' means auto-detect. */
  readonly platform: string
  readonly maskValues: boolean
  readonly strict: boolean
  readonly outputPath: string
  readonly exportEnv: boolean
  /** Raw `agent-reason`: '' means derive one (see domain/agent-reason.ts). */
  readonly agentReason: string
}

/**
 * Read and validate action inputs. The PAT is registered with the log
 * masker before this function returns — no code path sees it unmasked.
 */
export function readInputs(): ActionInputs {
  return {
    pat: readPat(),
    envTemplate: core.getInput('env-template'),
    passCliVersion: core.getInput('pass-cli-version'),
    passCliHash: core.getInput('hash'),
    platform: core.getInput('platform'),
    maskValues: booleanInput('mask-values', true),
    strict: booleanInput('strict', true),
    outputPath: core.getInput('output-path'),
    exportEnv: booleanInput('export-env', true),
    agentReason: core.getInput('agent-reason'),
  }
}

function readPat(): string {
  const pat = core.getInput('personal-access-token') || process.env[PAT_ENV_VAR] || ''
  if (pat === '') {
    throw new Error(
      `No Proton Pass token: set the personal-access-token input or the ${PAT_ENV_VAR} environment variable.`,
    )
  }
  core.setSecret(pat)
  return pat
}

/**
 * Empty means the documented default; `true` and `false` match in any case.
 * Anything else fails the step, because no guess is safe for every input:
 * falling back to `false` would let `mask-values: yes` unmask secrets, and
 * falling back to the default would let `export-env: no` export them.
 */
function booleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name)
  if (raw === '') return defaultValue
  const normalized = raw.toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`Input '${name}' must be true or false, got '${raw}'.`)
}
