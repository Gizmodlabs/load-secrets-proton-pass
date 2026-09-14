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
}

/**
 * Read and validate action inputs. The PAT is registered with the log
 * masker before this function returns — no code path sees it unmasked.
 * Boolean inputs follow the bash action's semantics: empty means the
 * documented default, anything other than the string "true" means false.
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

function booleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name)
  if (raw === '') return defaultValue
  return raw.toLowerCase() === 'true'
}
