import * as core from '@actions/core'

export interface ActionInputs {
  readonly pat: string
  readonly envTemplate: string
  readonly passCliVersion: string
  readonly maskValues: boolean
  readonly strict: boolean
  readonly outputPath: string
  readonly exportEnv: boolean
}

const DEFAULT_PASS_CLI_VERSION = '2.1.0'

/**
 * Read and validate action inputs. The PAT is registered with the log
 * masker before this function returns — no code path sees it unmasked.
 * Boolean inputs follow the bash action's semantics: empty means the
 * documented default, anything other than the string "true" means false.
 */
export function readInputs(): ActionInputs {
  const pat = core.getInput('personal-access-token', { required: true })
  core.setSecret(pat)

  return {
    pat,
    envTemplate: core.getInput('env-template'),
    passCliVersion: core.getInput('pass-cli-version') || DEFAULT_PASS_CLI_VERSION,
    maskValues: booleanInput('mask-values', true),
    strict: booleanInput('strict', true),
    outputPath: core.getInput('output-path'),
    exportEnv: booleanInput('export-env', true),
  }
}

function booleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name)
  if (raw === '') return defaultValue
  return raw.toLowerCase() === 'true'
}
