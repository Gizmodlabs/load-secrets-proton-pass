// Runs the BUILT dist/index.js against the mock pass-cli (already on PATH).
// Covers the pre-installed acceptance policy and the PAT env fallback.
// `npm run build` first — integration tests execute dist/, not src/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction, MOCK_PAT } from '../helpers/run-action.ts'

const URI = 'pass://GithubActions/load-secrets-proton-pass-test/Password'

test('unset pass-cli-version accepts the pre-installed CLI without touching the network', async () => {
  const result = await runAction({ env: { DB_PASSWORD: URI }, inputs: { 'pass-cli-version': '' } })
  assert.equal(result.exitCode, 0, result.stdout)
  assert.match(result.stdout, /pass-cli already installed: pass-cli 1\.0\.0 \(mock\)/)
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password')
})

test('latest accepts the pre-installed CLI', async () => {
  const result = await runAction({ env: { DB_PASSWORD: URI }, inputs: { 'pass-cli-version': 'latest' } })
  assert.equal(result.exitCode, 0, result.stdout)
  assert.match(result.stdout, /already installed/)
})

test('PAT can come from PROTON_PASS_PERSONAL_ACCESS_TOKEN when the input is empty', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: URI, PROTON_PASS_PERSONAL_ACCESS_TOKEN: MOCK_PAT },
    inputs: { 'personal-access-token': '' },
  })
  assert.equal(result.exitCode, 0, result.stdout)
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password')
  assert.ok(
    result.stdout.includes(`::add-mask::${MOCK_PAT}`),
    'PAT from the environment must be registered with the runner masker',
  )
})

test('no PAT from either source fails with a message naming both', async () => {
  const result = await runAction({ env: { DB_PASSWORD: URI }, inputs: { 'personal-access-token': '' } })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.stdout, /personal-access-token.*PROTON_PASS_PERSONAL_ACCESS_TOKEN/s)
  assert.ok(!('DB_PASSWORD' in result.env))
})

test('a parent-shell PAT cannot authenticate a test without an explicit token', async () => {
  const savedPat = process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN
  process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN = 'pst_parent_test::SYNTHETIC'
  try {
    const result = await runAction({ inputs: { 'personal-access-token': '' } })
    assert.equal(result.exitCode, 1)
    assert.match(result.stdout, /No Proton Pass token/)
    assert.ok(!result.stdout.includes('pst_parent_test::SYNTHETIC'))
  } finally {
    if (savedPat === undefined) delete process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN
    else process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN = savedPat
  }
})

test('parent session paths and mock controls cannot affect an action test', async () => {
  const parentSession = mkdtempSync(join(tmpdir(), 'parent-proton-session-'))
  const savedSession = process.env.PROTON_PASS_SESSION_DIR
  const savedFailure = process.env.MOCK_PASS_CLI_FAIL_INFO
  process.env.PROTON_PASS_SESSION_DIR = parentSession
  process.env.MOCK_PASS_CLI_FAIL_INFO = 'true'
  try {
    const result = await runAction({ env: { DB_PASSWORD: URI } })
    assert.equal(result.exitCode, 0, result.stdout)
    assert.equal(result.env['DB_PASSWORD'], 'mock-real-password')
    assert.notEqual(result.env['PROTON_PASS_SESSION_DIR'], parentSession)
    assert.ok(!existsSync(join(parentSession, '.pat-fingerprint')))
  } finally {
    if (savedSession === undefined) delete process.env.PROTON_PASS_SESSION_DIR
    else process.env.PROTON_PASS_SESSION_DIR = savedSession
    if (savedFailure === undefined) delete process.env.MOCK_PASS_CLI_FAIL_INFO
    else process.env.MOCK_PASS_CLI_FAIL_INFO = savedFailure
    rmSync(parentSession, { recursive: true, force: true })
  }
})
