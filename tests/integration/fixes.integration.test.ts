// End-to-end regression coverage for the critical fixes:
//   fix #1 (multiline-safe outputs/env) + fix #5 (no trimming) — PEM fixture
//   fix #4 (post cleanup always runs, never fails)
//   upstream output mode (export-env=false → step outputs only)
// Fix #2 (installer fail-closed) is covered by unit tests (manifest,
// verify-hash); fix #3 (PAT-bound sessions) by unit tests (session).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction, runCleanup } from '../helpers/run-action.ts'
// @ts-expect-error importing an untyped .mjs fixture shared with the mock CLI
import { PEM_KEY } from '../fixtures/pem-fixture.mjs'

const SSH_KEY_URI = 'pass://GithubActions/ssh-key-item/private-key'
const PEM_FIXTURE: string = PEM_KEY

test('fix #1/#5: multiline PEM survives byte-exact through env mode', async () => {
  const result = await runAction({ env: { SSH_KEY: SSH_KEY_URI } })
  assert.equal(result.exitCode, 0)
  assert.equal(result.env['SSH_KEY'], PEM_FIXTURE, 'GITHUB_ENV value byte-exact, trailing newline intact')
})

test('fix #1/#5: multiline PEM survives byte-exact through output mode', async () => {
  const result = await runAction({
    env: { SSH_KEY: SSH_KEY_URI },
    inputs: { 'export-env': 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output['SSH_KEY'], PEM_FIXTURE, 'GITHUB_OUTPUT value byte-exact')
  assert.ok(!('SSH_KEY' in result.env), 'export-env=false keeps env untouched')
})

test('fix #5: single-line values keep the exact bytes pass-cli printed', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: 'pass://GithubActions/load-secrets-proton-pass-test/Password' },
  })
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password\n', 'no trimming applied')
})

test('export-env=false still publishes resolved-keys and per-var outputs', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: 'pass://GithubActions/load-secrets-proton-pass-test/Password' },
    inputs: { 'export-env': 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output['resolved-keys'], 'DB_PASSWORD')
  assert.ok(result.output['DB_PASSWORD'])
})

// Bash test 4 equivalent + fix #4.
test('fix #4: post cleanup logs out, removes the session dir, and exits 0', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'cleanup-session-'))
  const result = await runCleanup({ 'session-dir': sessionDir })
  assert.equal(result.exitCode, 0, 'cleanup completed')
  assert.ok(!existsSync(sessionDir), 'session dir removed')
  assert.ok(result.stdout.includes('Proton Pass session cleaned up'))
  rmSync(sessionDir, { recursive: true, force: true })
})

test('fix #4: cleanup never fails the job even without pass-cli state', async () => {
  const result = await runCleanup()
  assert.equal(result.exitCode, 0)
})

test('security: PAT is masked the instant it is read', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: 'pass://GithubActions/load-secrets-proton-pass-test/Password' },
  })
  assert.ok(result.stdout.includes('::add-mask::pst_mock::TOKENKEY'), 'PAT registered with masker')
})

test('security: login failure produces an actionable error without the PAT value in the failure line', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: 'pass://GithubActions/load-secrets-proton-pass-test/Password' },
    mockEnv: { MOCK_PASS_CLI_FAIL_LOGIN: 'true', MOCK_PASS_CLI_FAIL_INFO: 'true' },
  })
  assert.equal(result.exitCode, 1)
  const failureLines = result.stdout.split('\n').filter(line => line.includes('::error::'))
  assert.ok(failureLines.some(line => line.includes('login failed')), 'actionable failure message')
  assert.ok(
    failureLines.every(line => !line.includes('pst_mock::TOKENKEY')),
    'PAT never appears in error lines',
  )
})
