// Ports bash tests 3, 3b, 6 — template injection through dist/index.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction } from '../helpers/run-action.ts'

const TEMPLATE_BODY =
  'DB_HOST=localhost\n' +
  'DB_PASSWORD={{ pass://GithubActions/load-secrets-proton-pass-test/Password }}\n' +
  'API_KEY={{ pass://GithubActions/load-secrets-proton-pass-test/Email }}\n'

test('T3: template renders to the auto-derived path (.template stripped)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'template-test-'))
  const templatePath = join(dir, 'test.env.template')
  writeFileSync(templatePath, TEMPLATE_BODY)
  try {
    const result = await runAction({
      inputs: { 'env-template': templatePath, 'mask-values': 'false' },
    })
    assert.equal(result.exitCode, 0, 'template injection ran')
    const rendered = join(dir, 'test.env')
    assert.ok(existsSync(rendered), 'output created at auto-derived path')
    assert.ok(readFileSync(rendered, 'utf8').includes('mock-injected-value'), 'values injected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T3b: explicit output-path overrides the auto-derived destination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'template-test-'))
  const templatePath = join(dir, 'test.env.template')
  const overridePath = join(dir, '.env.production')
  writeFileSync(templatePath, 'DB_PASSWORD={{ pass://GithubActions/load-secrets-proton-pass-test/Password }}\n')
  try {
    const result = await runAction({
      inputs: {
        'env-template': templatePath,
        'output-path': overridePath,
        'mask-values': 'false',
      },
    })
    assert.equal(result.exitCode, 0, 'injection with output-path ran')
    assert.ok(existsSync(overridePath), 'output written to override path')
    assert.ok(readFileSync(overridePath, 'utf8').includes('mock-injected-value'))
    assert.ok(!existsSync(join(dir, 'test.env')), 'auto-derived path not written despite override')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T6: missing template file errors instead of silently succeeding', async () => {
  const missing = join(tmpdir(), 'does-not-exist', 'nope.template')
  const result = await runAction({
    inputs: { 'env-template': missing, 'mask-values': 'false' },
  })
  assert.equal(result.exitCode, 1, 'inject errors when template missing')
  assert.ok(result.stdout.includes('Template file not found'), 'error names the problem')
})
