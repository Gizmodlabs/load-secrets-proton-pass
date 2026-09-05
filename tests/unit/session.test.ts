import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { establishSession, PAT_FINGERPRINT_FILE } from '../../src/session/session.ts'
import type { CliResult, CliRunner } from '../../src/pass-cli.ts'

const PAT = 'pst_unit-test-token::KEY'
const OTHER_PAT = 'pst_other-token::KEY'

interface FakeCall {
  args: string[]
  extraEnv: Record<string, string> | undefined
}

function fakeRunner(responses: { info?: number[]; login?: number; logout?: number }) {
  const calls: FakeCall[] = []
  const infoQueue = [...(responses.info ?? [0])]
  const runner: CliRunner = async (args, extraEnv): Promise<CliResult> => {
    calls.push({ args, extraEnv })
    const command = args[0]
    let exitCode = 0
    if (command === 'info') exitCode = infoQueue.shift() ?? 0
    if (command === 'login') exitCode = responses.login ?? 0
    if (command === 'logout') exitCode = responses.logout ?? 0
    return { exitCode, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

const commandsOf = (calls: FakeCall[]) => calls.map(call => call.args[0])

let sessionDir: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'session-test-'))
  savedEnv = {
    PROTON_PASS_SESSION_DIR: process.env.PROTON_PASS_SESSION_DIR,
    PROTON_PASS_KEY_PROVIDER: process.env.PROTON_PASS_KEY_PROVIDER,
    GITHUB_ENV: process.env.GITHUB_ENV,
    GITHUB_STATE: process.env.GITHUB_STATE,
  }
  process.env.PROTON_PASS_SESSION_DIR = sessionDir
  const scratch = mkdtempSync(join(tmpdir(), 'session-test-gh-'))
  process.env.GITHUB_ENV = join(scratch, 'env')
  process.env.GITHUB_STATE = join(scratch, 'state')
  writeFileSync(process.env.GITHUB_ENV, '')
  writeFileSync(process.env.GITHUB_STATE, '')
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(sessionDir, { recursive: true, force: true })
})

test('logs in fresh when no session exists and records the PAT fingerprint', async () => {
  const { runner, calls } = fakeRunner({ info: [1, 0] })
  await establishSession(PAT, runner)

  assert.deepEqual(commandsOf(calls), ['info', 'login', 'info'])
  const loginCall = calls[1]
  assert.ok(loginCall)
  assert.equal(loginCall.extraEnv?.PROTON_PASS_PERSONAL_ACCESS_TOKEN, PAT)

  const fingerprint = readFileSync(join(sessionDir, PAT_FINGERPRINT_FILE), 'utf8')
  assert.equal(fingerprint, createHash('sha256').update(PAT).digest('hex'))
})

test('reuses the session when it is valid and bound to the same PAT', async () => {
  const expected = createHash('sha256').update(PAT).digest('hex')
  writeFileSync(join(sessionDir, PAT_FINGERPRINT_FILE), expected)

  const { runner, calls } = fakeRunner({ info: [0] })
  await establishSession(PAT, runner)

  assert.deepEqual(commandsOf(calls), ['info'])
})

test('forces logout + fresh login when the existing session belongs to a different PAT', async () => {
  const otherFingerprint = createHash('sha256').update(OTHER_PAT).digest('hex')
  writeFileSync(join(sessionDir, PAT_FINGERPRINT_FILE), otherFingerprint)

  const { runner, calls } = fakeRunner({ info: [0, 0] })
  await establishSession(PAT, runner)

  assert.deepEqual(commandsOf(calls), ['info', 'logout', 'login', 'info'])
  const fingerprint = readFileSync(join(sessionDir, PAT_FINGERPRINT_FILE), 'utf8')
  assert.equal(fingerprint, createHash('sha256').update(PAT).digest('hex'))
})

test('forces fresh login when a session exists but no fingerprint is recorded', async () => {
  const { runner, calls } = fakeRunner({ info: [0, 0] })
  await establishSession(PAT, runner)
  assert.deepEqual(commandsOf(calls), ['info', 'logout', 'login', 'info'])
})

test('fails with an actionable message (never the PAT) when login fails', async () => {
  const { runner } = fakeRunner({ info: [1], login: 1 })
  await assert.rejects(establishSession(PAT, runner), (err: Error) => {
    assert.match(err.message, /login failed/)
    assert.ok(!err.message.includes(PAT), 'PAT must never appear in error messages')
    return true
  })
})

test('fails when login succeeds but the session probe still fails', async () => {
  const { runner } = fakeRunner({ info: [1, 1], login: 0 })
  await assert.rejects(establishSession(PAT, runner), /authentication failed/i)
})

test('rejects a symlinked PROTON_PASS_SESSION_DIR', async () => {
  const realDir = mkdtempSync(join(tmpdir(), 'session-test-real-'))
  const linkPath = join(mkdtempSync(join(tmpdir(), 'session-test-link-')), 'link')
  symlinkSync(realDir, linkPath)
  process.env.PROTON_PASS_SESSION_DIR = linkPath

  const { runner } = fakeRunner({})
  await assert.rejects(establishSession(PAT, runner), /symbolic link/)
  rmSync(realDir, { recursive: true, force: true })
})

test('creates a session dir under RUNNER_TEMP when none is configured', async () => {
  delete process.env.PROTON_PASS_SESSION_DIR
  const runnerTemp = mkdtempSync(join(tmpdir(), 'session-test-rt-'))
  process.env.RUNNER_TEMP = runnerTemp
  try {
    const { runner } = fakeRunner({ info: [1, 0] })
    const dir = await establishSession(PAT, runner)
    assert.ok(dir.startsWith(runnerTemp), `expected ${dir} under ${runnerTemp}`)
    assert.equal(process.env.PROTON_PASS_SESSION_DIR, dir)
    assert.equal(process.env.PROTON_PASS_KEY_PROVIDER, 'fs')
  } finally {
    delete process.env.RUNNER_TEMP
    rmSync(runnerTemp, { recursive: true, force: true })
  }
})

test('creates the configured session dir when it does not exist yet', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'session-test-parent-'))
  const configured = join(parent, 'nested', 'session')
  process.env.PROTON_PASS_SESSION_DIR = configured
  mkdirSync(join(parent, 'nested'), { recursive: true })
  try {
    const { runner } = fakeRunner({ info: [1, 0] })
    const dir = await establishSession(PAT, runner)
    assert.equal(dir, configured)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
