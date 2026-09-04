// Runs the BUILT dist/index.js against the mock pass-cli (already on PATH).
// Covers the pre-installed acceptance policy and the PAT env fallback.
// `npm run build` first — integration tests execute dist/, not src/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAction, MOCK_PAT } from '../helpers/run-action.ts'

const URI = 'pass://GithubActions/load-secrets-proton-pass-test/Password'

test('unset pass-cli-version accepts the pre-installed CLI without touching the network', async () => {
  const result = await runAction({ env: { DB_PASSWORD: URI }, inputs: { 'pass-cli-version': '' } })
  assert.equal(result.exitCode, 0, result.stdout)
  assert.match(result.stdout, /pass-cli already installed: pass-cli 1\.0\.0 \(mock\)/)
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password\n')
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
  assert.equal(result.env['DB_PASSWORD'], 'mock-real-password\n')
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
