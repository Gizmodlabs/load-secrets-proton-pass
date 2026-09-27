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

// pass-cli refuses to replace an existing output file without --force, so a
// second render (re-run, persistent self-hosted workspace, explicit
// output-path onto a committed file) used to fail.
test('re-rendering over an existing output file succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'template-test-'))
  const templatePath = join(dir, 'app.env.template')
  const outputPath = join(dir, 'app.env')
  writeFileSync(templatePath, 'DB_PASSWORD={{ pass://GithubActions/load-secrets-proton-pass-test/Password }}\n')
  writeFileSync(outputPath, 'DB_PASSWORD=stale-from-a-previous-run\n')
  try {
    const result = await runAction({ inputs: { 'env-template': templatePath, 'mask-values': 'false' } })
    assert.equal(result.exitCode, 0, result.stdout)
    assert.equal(readFileSync(outputPath, 'utf8'), 'DB_PASSWORD=mock-injected-value\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const TEMPLATE_ITEM = 'pass://GithubActions/template-item'

/** Values registered with the runner's log masker, one per ::add-mask:: line. */
const maskedValues = (stdout: string) =>
  stdout.split(/\r?\n/).filter(line => line.startsWith('::add-mask::')).map(line => line.slice('::add-mask::'.length))

// The old KEY= line heuristic masked `"value"` with its quotes, skipped YAML
// lines, and masked a whole DSN instead of the credentials inside it.
test('masking registers exactly the injected values: quoted, YAML, several per line, multiline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'template-test-'))
  const templatePath = join(dir, 'app.env.template')
  writeFileSync(
    templatePath,
    [
      `PLAIN={{ ${TEMPLATE_ITEM}/plain }}`,
      `QUOTED="{{ ${TEMPLATE_ITEM}/quoted }}"`,
      `password: {{ ${TEMPLATE_ITEM}/yaml }}`,
      `DSN=postgres://{{ ${TEMPLATE_ITEM}/user }}:{{ ${TEMPLATE_ITEM}/pw }}@db.internal/app`,
      `KEY="{{ ${TEMPLATE_ITEM}/pem }}"`,
      'STATIC=not-a-secret',
      '',
    ].join('\n'),
  )
  try {
    const result = await runAction({ inputs: { 'env-template': templatePath } })
    assert.equal(result.exitCode, 0, result.stdout)
    const masks = maskedValues(result.stdout)
    for (const value of ['plain-injected', 'quoted-injected', 'yaml-injected', 'dsn-user', 'dsn-pw']) {
      assert.ok(masks.includes(value), `${value} is masked on its own; masks were ${JSON.stringify(masks)}`)
    }
    assert.ok(masks.includes('-----BEGIN OPENSSH PRIVATE KEY-----'), 'each line of a multiline value is masked')
    assert.ok(!masks.includes('"quoted-injected"'), 'quotes from the template are not part of the value')
    assert.ok(!masks.some(mask => mask.includes('not-a-secret')), 'static template text is never masked')
    assert.ok(!result.stdout.includes('::warning::'), 'no fallback warning when the output lines up')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rendering in place (output-path == env-template) still masks the injected values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'template-test-'))
  const path = join(dir, '.env')
  writeFileSync(path, `PLAIN={{ ${TEMPLATE_ITEM}/plain }}\n`)
  try {
    const result = await runAction({ inputs: { 'env-template': path, 'output-path': path } })
    assert.equal(result.exitCode, 0, result.stdout)
    assert.equal(readFileSync(path, 'utf8'), 'PLAIN=plain-injected\n')
    assert.ok(maskedValues(result.stdout).includes('plain-injected'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
