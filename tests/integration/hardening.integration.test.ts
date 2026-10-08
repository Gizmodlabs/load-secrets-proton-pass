// Outputs-only mode (export-env: false leaves nothing behind for later steps)
// and agent-token audit reasons, end to end through dist/index.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction } from '../helpers/run-action.ts'

const DB_PASSWORD_URI = 'pass://GithubActions/load-secrets-proton-pass-test/Password'

/** Scratch dir per test, removed afterwards. */
async function withScratch(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hardening-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface CliCall {
  readonly args: string[]
  readonly reason: string | null
  readonly sessionDir: string | null
}

/** Every pass-cli invocation the mock saw, in order. */
function cliCalls(logPath: string): CliCall[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as CliCall)
}

/** Commands run after the last secret read: what the step did once it had the values. */
function callsAfterReads(calls: CliCall[]): string[] {
  const lastRead = calls.findLastIndex(call => call.args[0] === 'item' || call.args[0] === 'inject')
  return calls.slice(lastRead + 1).map(call => call.args[0] ?? '')
}

/** Values of every `::save-state name=<name>::` command, in order. */
function savedStates(stdout: string, name: string): string[] {
  return [...stdout.matchAll(new RegExp(`^::save-state name=${name}::(.*)$`, 'gm'))].map(match => match[1] ?? '')
}

test('outputs-only: secrets reach step outputs only, and the session ends with the step', () =>
  withScratch(async dir => {
    const callLog = join(dir, 'calls.jsonl')
    const result = await runAction({
      env: { DB_PASSWORD: DB_PASSWORD_URI, RUNNER_TEMP: dir },
      inputs: { 'export-env': 'false' },
      mockEnv: { MOCK_PASS_CLI_CALL_LOG: callLog },
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.output['DB_PASSWORD'], 'mock-real-password')
    assert.deepEqual(result.env, {}, 'nothing exported to later steps: no secret, no session dir, no key provider')

    const calls = cliCalls(callLog)
    assert.deepEqual(callsAfterReads(calls), ['logout'], 'logged out before the step finished')
    assert.ok(calls.at(-1)?.sessionDir?.startsWith(join(dir, 'proton-pass-session-')), 'of the session it created')
    assert.deepEqual(
      readdirSync(dir).filter(name => name.startsWith('proton-pass-session-')),
      [],
      'session dir (and its fs key) deleted',
    )
    assert.equal(savedStates(result.stdout, 'session-dir').at(-1), '', 'post step has nothing left to do')
  }))

test('outputs-only: the session still ends when strict mode fails the step', () =>
  withScratch(async dir => {
    const callLog = join(dir, 'calls.jsonl')
    const result = await runAction({
      env: { MISSING: 'pass://GithubActions/Does-Not-Exist/password', RUNNER_TEMP: dir },
      inputs: { 'export-env': 'false' },
      mockEnv: { MOCK_PASS_CLI_CALL_LOG: callLog },
    })
    assert.equal(result.exitCode, 1)
    assert.deepEqual(callsAfterReads(cliCalls(callLog)), ['logout'], 'logged out despite the failure')
  }))

test('outputs-only: a caller-provided session dir is left for the post step', () =>
  withScratch(async dir => {
    const callLog = join(dir, 'calls.jsonl')
    // Already there, as when install-cli-action or an earlier step set it up.
    const sessionDir = join(dir, 'shared-session')
    mkdirSync(sessionDir)
    const result = await runAction({
      env: { DB_PASSWORD: DB_PASSWORD_URI, PROTON_PASS_SESSION_DIR: sessionDir },
      inputs: { 'export-env': 'false' },
      mockEnv: { MOCK_PASS_CLI_CALL_LOG: callLog },
    })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(callsAfterReads(cliCalls(callLog)), [], 'no early logout of a session the caller shares')
    assert.ok(existsSync(sessionDir))
    assert.equal(savedStates(result.stdout, 'session-dir').at(-1), sessionDir, 'the post step still cleans it')
  }))

test('default mode still shares the session with later steps until the post step', () =>
  withScratch(async dir => {
    const callLog = join(dir, 'calls.jsonl')
    const result = await runAction({
      env: { DB_PASSWORD: DB_PASSWORD_URI },
      mockEnv: { MOCK_PASS_CLI_CALL_LOG: callLog },
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.env['DB_PASSWORD'], 'mock-real-password')
    assert.ok(result.env['PROTON_PASS_SESSION_DIR'])
    assert.equal(result.env['PROTON_PASS_KEY_PROVIDER'], 'fs')
    assert.deepEqual(callsAfterReads(cliCalls(callLog)), [], 'logout waits for the post step')
  }))

test('a mistyped export-env fails the step before anything is exported', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: DB_PASSWORD_URI },
    inputs: { 'export-env': 'no' },
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /::error::Input 'export-env' must be true or false, got 'no'\./)
  assert.deepEqual(result.env, {})
  assert.deepEqual(result.output, {})
})

const RUN_CONTEXT = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/api',
  GITHUB_RUN_ID: '1001',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW: 'Deploy',
  GITHUB_RUN_NUMBER: '7',
  GITHUB_REF_NAME: 'main',
  GITHUB_ACTOR: 'octocat',
}
const RUN_DESCRIPTION =
  'GitHub Actions run https://github.com/acme/api/actions/runs/1001/attempts/1 ' +
  '(workflow "Deploy" #7, ref main, actor octocat)'

/** Reasons the mock received on secret reads, keyed by the pass-cli command line. */
function readReasons(logPath: string): Array<[string, string | null]> {
  return cliCalls(logPath)
    .filter(call => call.args[0] === 'item' || call.args[0] === 'inject')
    .map(call => [call.args.join(' '), call.reason])
}

test('agent token: every read and the template render carry an audit reason for this run', () =>
  withScratch(async dir => {
    const callLog = join(dir, 'calls.jsonl')
    const templatePath = join(dir, 'app.env.template')
    writeFileSync(templatePath, `DB_PASSWORD={{ ${DB_PASSWORD_URI} }}\n`)
    const result = await runAction({
      env: { ...RUN_CONTEXT, DB_PASSWORD: DB_PASSWORD_URI, LOGIN: 'pass://GithubActions/multi-field-item/*' },
      inputs: { 'env-template': templatePath },
      mockEnv: { MOCK_PASS_CLI_AGENT: 'true', MOCK_PASS_CLI_CALL_LOG: callLog },
    })
    assert.equal(result.exitCode, 0, result.stdout)

    const reasons = readReasons(callLog)
    assert.deepEqual(reasons.find(([args]) => args === `item view -- ${DB_PASSWORD_URI}`), [
      `item view -- ${DB_PASSWORD_URI}`,
      `load DB_PASSWORD: ${RUN_DESCRIPTION}`,
    ])
    assert.deepEqual(reasons.find(([args]) => args.startsWith('item view --output json')), [
      'item view --output json -- pass://GithubActions/multi-field-item',
      `list fields to load LOGIN_*: ${RUN_DESCRIPTION}`,
    ])
    assert.deepEqual(reasons.find(([args]) => args.startsWith('inject')), [
      `inject --force -i ${templatePath} -o ${join(dir, 'app.env')}`,
      `render ${templatePath}: ${RUN_DESCRIPTION}`,
    ])
    assert.ok(reasons.every(([, reason]) => reason !== null && Array.from(reason).length <= 300))
  }))

test('agent token: the agent-reason input replaces the run description', () =>
  withScratch(async dir => {
    const callLog = join(dir, 'calls.jsonl')
    const result = await runAction({
      env: { ...RUN_CONTEXT, DB_PASSWORD: DB_PASSWORD_URI },
      inputs: { 'agent-reason': 'Nightly production deploy' },
      mockEnv: { MOCK_PASS_CLI_AGENT: 'true', MOCK_PASS_CLI_CALL_LOG: callLog },
    })
    assert.equal(result.exitCode, 0, result.stdout)
    assert.deepEqual(readReasons(callLog), [
      [`item view -- ${DB_PASSWORD_URI}`, 'load DB_PASSWORD: Nightly production deploy'],
    ])
  }))
