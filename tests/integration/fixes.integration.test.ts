import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAction } from '../helpers/run-action.ts'
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
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password', 'only the CLI print newline is removed')
})

test('export-env=false still publishes resolved-keys and per-var outputs', async () => {
  const result = await runAction({
    env: { DB_PASSWORD: 'pass://GithubActions/load-secrets-proton-pass-test/Password' },
    inputs: { 'export-env': 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output['resolved-keys'], 'DB_PASSWORD')
  assert.equal(result.output['DB_PASSWORD'], 'mock-real-password')
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
