// Port of the 22 scenarios (63 assertions) from tests/run-local-tests.sh —
// the behavioral spec of the bash action — run end-to-end against the built
// dist/index.js with the mock pass-cli on PATH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAction } from '../helpers/run-action.ts'

const TEST_ITEM = 'pass://GithubActions/load-secrets-proton-pass-test'

// Test 1 + Test 20: no pass:// URIs — no-op success, resolved-keys empty
test('T1/T20: no secrets to resolve is a successful no-op with empty resolved-keys', async () => {
  const result = await runAction({ env: { NORMAL_VAR: 'hello' } })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output['resolved-keys'], '')
})

// Test 2: single URI resolved into GITHUB_ENV
test('T2: resolves a single pass:// URI into GITHUB_ENV', async () => {
  const result = await runAction({ env: { DB_PASSWORD: `${TEST_ITEM}/Password` } })
  assert.equal(result.exitCode, 0)
  assert.ok('DB_PASSWORD' in result.env, 'DB_PASSWORD written to GITHUB_ENV')
  assert.ok(result.env['DB_PASSWORD']?.includes('mock-real-password'), 'correct value in GITHUB_ENV')
})

// Test 5: multiple secrets, non-secret vars untouched
test('T5: resolves multiple secrets and leaves non-pass:// vars alone', async () => {
  const result = await runAction({
    env: {
      SECRET_A: `${TEST_ITEM}/Password`,
      SECRET_B: `${TEST_ITEM}/Email`,
      NOT_A_SECRET: 'just-a-value',
    },
  })
  assert.equal(result.exitCode, 0)
  assert.ok('SECRET_A' in result.env)
  assert.ok('SECRET_B' in result.env)
  assert.ok(!('NOT_A_SECRET' in result.env), 'non-pass:// vars left alone')
})

// Test 7: field glob expands into one env var per field
test('T7: field glob expands pass://V/item/* into per-field env vars', async () => {
  const result = await runAction({
    env: { DB: 'pass://GithubActions/multi-field-item/*' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.ok('DB_HOST' in result.env, 'DB_HOST written')
  assert.ok('DB_PORT' in result.env, 'DB_PORT written')
  assert.ok('DB_PASSWORD' in result.env, 'DB_PASSWORD written')
  assert.ok(result.env['DB_HOST']?.includes('db.example.com'), 'resolved value present')
})

// Test 8: glob matching zero fields fails
test('T8: glob matching zero fields fails the step', async () => {
  const result = await runAction({
    env: { EMPTY: 'pass://GithubActions/empty-item/*' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 1)
  assert.ok(result.stdout.includes('matched zero fields'))
})

// Test 9: sanitized-suffix collision fails listing both raw names
test('T9: suffix collision fails and lists both offending raw names', async () => {
  const result = await runAction({
    env: { X: 'pass://GithubActions/collision-item/*' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 1)
  assert.ok(result.stdout.includes('api-key'), 'error lists api-key')
  assert.ok(result.stdout.includes('api_key'), 'error lists api_key')
})

// Test 10: wildcards rejected in vault and item segments
test('T10: item-segment wildcard rejected', async () => {
  const result = await runAction({
    env: { BAD: 'pass://GithubActions/*/password' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 1)
  assert.ok(result.stdout.includes('only supported in the field segment'))
})

test('T10b: vault-segment wildcard rejected', async () => {
  const result = await runAction({
    env: { BAD: 'pass://*/item/password' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 1)
  assert.ok(result.stdout.includes('only supported in the field segment'))
})

// Test 11: field-name sanitization
test('T11: mixed-case/space/dash field names map to clean suffixes', async () => {
  const result = await runAction({
    env: { CFG: 'pass://GithubActions/sanitize-item/*' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.ok(result.env['CFG_API_KEY']?.includes('sanitize-apikey-value'), "'API Key' -> CFG_API_KEY")
  assert.ok(
    result.env['CFG_DATABASE_NAME']?.includes('sanitize-dbname-value'),
    "'database-name' -> CFG_DATABASE_NAME",
  )
})

// Test 12: glob masking emits add-mask per value
test('T12: glob masking emits ::add-mask:: per expanded value', async () => {
  const result = await runAction({
    env: { DB: 'pass://GithubActions/multi-field-item/*' },
    inputs: { 'mask-values': 'true' },
  })
  assert.equal(result.exitCode, 0)
  assert.ok(result.stdout.includes('::add-mask::hunter2'), 'password value masked')
  assert.ok(result.stdout.includes('::add-mask::db.example.com'), 'host value masked')
  assert.ok('DB_PASSWORD' in result.env, 'DB_PASSWORD still written when masking')
})

// Test 13: glob and single URI coexist
test('T13: glob and single URI resolve in one run', async () => {
  const result = await runAction({
    env: {
      DB: 'pass://GithubActions/multi-field-item/*',
      PASSWORD: `${TEST_ITEM}/Password`,
    },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.ok('DB_HOST' in result.env, 'glob var written')
  assert.ok(result.env['PASSWORD']?.includes('mock-real-password'), 'single value resolved')
})

// Test 14: empty-suffix field name fails
test('T14: field sanitizing to an empty suffix fails the step', async () => {
  const result = await runAction({
    env: { BAD: 'pass://GithubActions/bad-suffix-item/*' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 1)
  assert.ok(result.stdout.includes('sanitizes to an empty suffix'))
})

// Test 15: partial field wildcard rejected
test('T15: partial wildcard in field segment rejected', async () => {
  const result = await runAction({
    env: { BAD: 'pass://GithubActions/multi-field-item/pass*' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 1)
  assert.ok(result.stdout.includes('Partial wildcards are not supported'))
})

// Test 16: strict mode (default) fails on missing item with a value-free report
test('T16: strict mode fails on missing item; good secrets still exported; no values leak', async () => {
  const result = await runAction({
    env: {
      GOOD_SECRET: `${TEST_ITEM}/Password`,
      BOGUS: 'pass://Prod/Does-Not-Exist/x',
    },
  })
  assert.equal(result.exitCode, 1, 'missing item fails step by default')
  assert.ok(
    result.stdout.includes('BOGUS -> pass://Prod/Does-Not-Exist/x'),
    'failure report names var and URI',
  )
  assert.ok('GOOD_SECRET' in result.env, 'good secret still exported')
  assert.ok(!('BOGUS' in result.env), 'unresolved var not written to GITHUB_ENV')
  const errorLines = result.stdout.split('\n').filter(line => line.includes('::error::'))
  assert.ok(
    errorLines.every(line => !line.includes('mock-real-password')),
    'failure report never contains secret values',
  )
})

// Test 17: strict=false — best-effort mode succeeds with warnings
test('T17: strict=false continues despite failures, reporting warnings', async () => {
  const result = await runAction({
    env: {
      GOOD_SECRET: `${TEST_ITEM}/Password`,
      BOGUS: 'pass://Prod/Does-Not-Exist/x',
    },
    inputs: { strict: 'false' },
  })
  assert.equal(result.exitCode, 0, 'strict=false continues despite failure')
  assert.ok('GOOD_SECRET' in result.env, 'good secret exported in best-effort mode')
  assert.ok(result.stdout.includes('::warning::'), 'failures reported as warnings')
})

// Test 18: strict=false also demotes glob failures to warnings
test('T18: strict=false demotes glob failures to warnings', async () => {
  const result = await runAction({
    env: { EMPTY: 'pass://GithubActions/empty-item/*' },
    inputs: { strict: 'false', 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 0)
  const warningLines = result.stdout.split('\n').filter(line => line.includes('::warning::'))
  assert.ok(
    warningLines.some(line => line.includes('matched zero fields')),
    'empty glob reported as warning',
  )
})

// Test 19: resolved-keys sorted, names only. Per-var step outputs are the
// documented node-action addition (upstream mode), so unlike the bash suite
// we assert the resolved-keys *value* is value-free rather than the whole
// $GITHUB_OUTPUT file.
test('T19: resolved-keys is sorted names only; per-var outputs exist', async () => {
  const result = await runAction({
    env: {
      ZEBRA_KEY: `${TEST_ITEM}/Password`,
      ALPHA_KEY: `${TEST_ITEM}/Email`,
    },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output['resolved-keys'], 'ALPHA_KEY,ZEBRA_KEY')
  assert.ok(result.output['ZEBRA_KEY']?.includes('mock-real-password'), 'per-var step output present')
})

// Test 21: resolved-keys includes glob-expanded names
test('T21: resolved-keys lists glob-expanded names sorted', async () => {
  const result = await runAction({
    env: { DB: 'pass://GithubActions/multi-field-item/*' },
    inputs: { 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output['resolved-keys'], 'DB_HOST,DB_PASSWORD,DB_PORT')
})

// Test 22: best-effort mode excludes failed keys from resolved-keys
test('T22: resolved-keys excludes unresolved vars when strict=false', async () => {
  const result = await runAction({
    env: {
      GOOD_SECRET: `${TEST_ITEM}/Password`,
      BOGUS: 'pass://Prod/Does-Not-Exist/x',
    },
    inputs: { strict: 'false' },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output['resolved-keys'], 'GOOD_SECRET')
})
