import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMockPassCli } from './mock-cli.ts'
import { readFileCommands } from './file-commands.ts'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN_BUNDLE = join(PROJECT_ROOT, 'dist', 'index.js')
const CLEANUP_BUNDLE = join(PROJECT_ROOT, 'dist', 'cleanup.js')

export const MOCK_PAT = 'pst_mock::TOKENKEY'

export interface RunActionOptions {
  /** Extra env vars visible to the action (e.g. pass:// references). */
  readonly env?: Record<string, string>
  /** Action inputs by their action.yml names (e.g. 'mask-values'). */
  readonly inputs?: Record<string, string>
  /** Extra env for the mock CLI (failure injection). */
  readonly mockEnv?: Record<string, string>
}

export interface ActionRunResult {
  readonly exitCode: number
  readonly stdout: string
  /** Parsed $GITHUB_ENV file commands. */
  readonly env: Record<string, string>
  /** Parsed $GITHUB_OUTPUT file commands. */
  readonly output: Record<string, string>
}

/**
 * Run the built dist/index.js end-to-end against the mock pass-cli, the way
 * the GitHub runner would: inputs via INPUT_* env vars, results captured
 * from temp $GITHUB_ENV / $GITHUB_OUTPUT files. Base env is scrubbed of any
 * stray pass:// values so only the test's own references are scanned.
 */
export async function runAction(options: RunActionOptions = {}): Promise<ActionRunResult> {
  const mock = installMockPassCli()
  const scratch = mkdtempSync(join(tmpdir(), 'run-action-'))
  const githubEnvFile = join(scratch, 'github-env')
  const githubOutputFile = join(scratch, 'github-output')
  writeFileSync(githubEnvFile, '')
  writeFileSync(githubOutputFile, '')

  try {
    const childEnv = buildChildEnv(mock.binDir, scratch, githubEnvFile, githubOutputFile, options)
    const { exitCode, stdout } = await spawnNode(MAIN_BUNDLE, childEnv)
    return {
      exitCode,
      stdout,
      env: readFileCommands(githubEnvFile),
      output: readFileCommands(githubOutputFile),
    }
  } finally {
    mock.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Run dist/cleanup.js (the post entry) with optional saved state. */
export async function runCleanup(state: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string }> {
  const mock = installMockPassCli()
  try {
    const env = scrubbedBaseEnv()
    env['PATH'] = `${mock.binDir}${delimiter}${env['PATH'] ?? ''}`
    for (const [key, value] of Object.entries(state)) {
      env[`STATE_${key}`] = value
    }
    return await spawnNode(CLEANUP_BUNDLE, env)
  } finally {
    mock.cleanup()
  }
}

function buildChildEnv(
  mockBinDir: string,
  scratch: string,
  githubEnvFile: string,
  githubOutputFile: string,
  options: RunActionOptions,
): Record<string, string> {
  const env = scrubbedBaseEnv()
  env['PATH'] = `${mockBinDir}${delimiter}${env['PATH'] ?? ''}`
  env['GITHUB_ENV'] = githubEnvFile
  env['GITHUB_OUTPUT'] = githubOutputFile
  env['RUNNER_TEMP'] = scratch

  const inputs: Record<string, string> = {
    'personal-access-token': MOCK_PAT,
    'pass-cli-version': '1.0.0',
    ...options.inputs,
  }
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value
  }
  Object.assign(env, options.mockEnv ?? {}, options.env ?? {})
  return env
}

/** process.env minus anything that parses as a pass:// reference. */
function scrubbedBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (value.startsWith('pass://')) continue
    if (key.startsWith('INPUT_') || key.startsWith('STATE_')) continue
    if (key === 'GITHUB_ENV' || key === 'GITHUB_OUTPUT' || key === 'GITHUB_STATE') continue
    env[key] = value
  }
  return env
}

function spawnNode(script: string, env: Record<string, string>): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stdout += chunk))
    child.on('error', reject)
    child.on('close', code => resolve({ exitCode: code ?? -1, stdout }))
  })
}
