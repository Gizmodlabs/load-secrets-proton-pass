import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { installMockPassCli } from './mock-cli.ts'
import { readFileCommands } from './file-commands.ts'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN_BUNDLE = join(PROJECT_ROOT, 'dist', 'index.js')
const CLEANUP_BUNDLE = join(PROJECT_ROOT, 'dist', 'cleanup.js')

export const MOCK_PAT = 'pst_mock::TOKENKEY'

export interface RunActionOptions {
  readonly env?: Record<string, string>
  readonly inputs?: Record<string, string>
  readonly mockEnv?: Record<string, string>
}

export interface ActionRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly env: Record<string, string>
  readonly output: Record<string, string>
  readonly state: Record<string, string>
}

export async function runAction(options: RunActionOptions = {}): Promise<ActionRunResult> {
  const job = createJob(options)
  try {
    return await runMain(job)
  } finally {
    job.dispose()
  }
}

export async function runActionLifecycle(t: TestContext, options: RunActionOptions = {}) {
  const job = createJob(options)
  t.after(job.dispose)
  const main = await runMain(job)
  const sessionDirExistedAfterMain = existsSync(job.sessionDir)
  const postEnv = { ...job.env, ...main.env }
  for (const [name, value] of Object.entries(main.state)) postEnv[`STATE_${name}`] = value
  const post = await spawnNode(CLEANUP_BUNDLE, postEnv)
  return {
    main,
    post,
    sessionDir: job.sessionDir,
    sessionDirExistedAfterMain,
    authCalls: readFileSync(job.authLog, 'utf8').trim().split('\n').filter(Boolean),
  }
}

function createJob(options: RunActionOptions) {
  const scratch = mkdtempSync(join(tmpdir(), 'run-action-'))
  const mock = installMockPassCli()
  const envFile = join(scratch, 'github-env')
  const outputFile = join(scratch, 'github-output')
  const stateFile = join(scratch, 'github-state')
  const pathFile = join(scratch, 'github-path')
  const authLog = join(scratch, 'auth-calls')
  const sessionDir = join(scratch, 'session')
  for (const file of [envFile, outputFile, stateFile, pathFile, authLog]) writeFileSync(file, '')

  const env = scrubbedBaseEnv()
  const inputs = {
    'personal-access-token': MOCK_PAT,
    'pass-cli-version': '1.0.0',
    ...options.inputs,
  }
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value
  }
  Object.assign(env, options.mockEnv, options.env)
  env['PATH'] = `${mock.binDir}${delimiter}${env['PATH'] ?? ''}`
  env['GITHUB_ENV'] = envFile
  env['GITHUB_OUTPUT'] = outputFile
  env['GITHUB_STATE'] = stateFile
  env['GITHUB_PATH'] = pathFile
  env['RUNNER_TEMP'] = scratch
  env['PROTON_PASS_SESSION_DIR'] = sessionDir
  env['MOCK_PASS_CLI_AUTH_LOG'] = authLog

  return {
    env, envFile, outputFile, stateFile, sessionDir, authLog,
    dispose() {
      mock.cleanup()
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

async function runMain(job: ReturnType<typeof createJob>): Promise<ActionRunResult> {
  const result = await spawnNode(MAIN_BUNDLE, job.env)
  return {
    ...result,
    env: readFileCommands(job.envFile),
    output: readFileCommands(job.outputFile),
    state: readFileCommands(job.stateFile),
  }
}

function scrubbedBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value.startsWith('pass://')) continue
    const upperKey = key.toUpperCase()
    if (/^(INPUT_|STATE_|PROTON_PASS_|MOCK_PASS_CLI_)/.test(upperKey)) continue
    if (['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_PATH'].includes(upperKey)) continue
    env[process.platform === 'win32' && upperKey === 'PATH' ? 'PATH' : key] = value
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
