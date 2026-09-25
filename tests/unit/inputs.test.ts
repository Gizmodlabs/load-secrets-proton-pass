import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readInputs, PAT_ENV_VAR } from '../../src/inputs.ts'

const INPUT_KEYS = [
  'INPUT_PERSONAL-ACCESS-TOKEN',
  'INPUT_ENV-TEMPLATE',
  'INPUT_PASS-CLI-VERSION',
  'INPUT_HASH',
  'INPUT_PLATFORM',
  'INPUT_MASK-VALUES',
  'INPUT_STRICT',
  'INPUT_OUTPUT-PATH',
  'INPUT_EXPORT-ENV',
  PAT_ENV_VAR,
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(INPUT_KEYS.map(k => [k, process.env[k]]))
  for (const k of INPUT_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of INPUT_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('PAT input wins over the environment variable', () => {
  process.env['INPUT_PERSONAL-ACCESS-TOKEN'] = 'pst_input::KEY'
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().pat, 'pst_input::KEY')
})

test('PAT falls back to PROTON_PASS_PERSONAL_ACCESS_TOKEN (upstream-compatible)', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().pat, 'pst_env::KEY')
})

test('no PAT anywhere is an actionable error naming both sources', () => {
  assert.throws(() => readInputs(), /personal-access-token.*PROTON_PASS_PERSONAL_ACCESS_TOKEN/s)
})

test('pass-cli-version is passed through raw: empty stays empty (installer applies the default)', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().passCliVersion, '')
  process.env['INPUT_PASS-CLI-VERSION'] = 'latest'
  assert.equal(readInputs().passCliVersion, 'latest')
})

test('hash and platform inputs are read raw and default to empty', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  assert.equal(readInputs().passCliHash, '')
  assert.equal(readInputs().platform, '')
  process.env['INPUT_HASH'] = 'ABC'
  process.env['INPUT_PLATFORM'] = 'linux-aarch64'
  assert.equal(readInputs().passCliHash, 'ABC')
  assert.equal(readInputs().platform, 'linux-aarch64')
})

test('boolean defaults are unchanged: mask-values, strict, export-env all default true', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  const inputs = readInputs()
  assert.equal(inputs.maskValues, true)
  assert.equal(inputs.strict, true)
  assert.equal(inputs.exportEnv, true)
})

/** Capture the workflow commands (::warning:: etc.) @actions/core writes to stdout. */
function captureStdout(run: () => void): string {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return chunks.join('')
}

test('boolean inputs accept true and false in any case', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  process.env['INPUT_MASK-VALUES'] = 'FALSE'
  process.env['INPUT_STRICT'] = 'False'
  process.env['INPUT_EXPORT-ENV'] = 'false'
  const inputs = readInputs()
  assert.equal(inputs.maskValues, false)
  assert.equal(inputs.strict, false)
  assert.equal(inputs.exportEnv, false)
})

test('an unrecognized boolean keeps the documented default and warns instead of meaning false', () => {
  process.env[PAT_ENV_VAR] = 'pst_env::KEY'
  process.env['INPUT_MASK-VALUES'] = 'yes'
  process.env['INPUT_STRICT'] = '0'
  process.env['INPUT_EXPORT-ENV'] = 'ture'
  let inputs: ReturnType<typeof readInputs> | undefined
  const stdout = captureStdout(() => {
    inputs = readInputs()
  })
  assert.equal(inputs?.maskValues, true, 'a typo must never turn masking off')
  assert.equal(inputs?.strict, true, 'nor strict mode')
  assert.equal(inputs?.exportEnv, true)
  assert.match(stdout, /::warning::Input 'mask-values' must be true or false, got 'yes'\. Using the default \(true\)\./)
  assert.match(stdout, /::warning::Input 'strict' must be true or false, got '0'/)
  assert.match(stdout, /::warning::Input 'export-env' must be true or false, got 'ture'/)
})
