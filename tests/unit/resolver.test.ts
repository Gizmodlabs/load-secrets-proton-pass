import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSecrets } from '../../src/resolver/resolver.ts'
import { findSecretRefs } from '../../src/resolver/env-scan.ts'
import { formatFailure } from '../../src/domain/resolution.ts'
import type { CliResult, CliRunner } from '../../src/pass-cli.ts'

interface CannedResponse {
  match: (args: string[]) => boolean
  result: Partial<CliResult>
}

function cannedRunner(responses: CannedResponse[]) {
  const calls: string[][] = []
  const runner: CliRunner = async args => {
    calls.push(args)
    const canned = responses.find(response => response.match(args))
    return {
      exitCode: canned?.result.exitCode ?? 0,
      stdout: canned?.result.stdout ?? '',
      stderr: canned?.result.stderr ?? '',
    }
  }
  return { runner, calls }
}

function collectAnnotations() {
  const lines: string[] = []
  return { annotate: (message: string) => lines.push(message), lines }
}

const refsFor = (env: Record<string, string>) => findSecretRefs(env)

test('findSecretRefs picks up only full pass:// URIs', () => {
  const refs = refsFor({
    DB_PASSWORD: 'pass://Vault/Item/password',
    NORMAL_VAR: 'hello',
    TWO_SEGMENTS: 'pass://Vault/Item',
  })
  assert.deepEqual(
    refs.map(ref => ref.name),
    ['DB_PASSWORD'],
  )
})

test('literal value is captured byte-exact from stdout — no trimming', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Vault/Item/key'),
      result: { stdout: 'line one\nline two\n' },
    },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ KEY: 'pass://Vault/Item/key' }), { annotate, runner })
  assert.equal(report.resolved[0]?.value, 'line one\nline two\n')
  assert.equal(report.failures.length, 0)
})

test('literal invocations use the -- argument separator before the URI', async () => {
  const { runner, calls } = cannedRunner([])
  const { annotate } = collectAnnotations()
  await resolveSecrets(refsFor({ KEY: 'pass://Vault/Item/key' }), { annotate, runner })
  assert.deepEqual(calls[0], ['item', 'view', '--', 'pass://Vault/Item/key'])
})

test('literal failure records name, uri, and stderr detail — never a value', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Prod/Does-Not-Exist/x'),
      result: { exitCode: 1, stderr: "Error: Could not find item by name 'Does-Not-Exist'" },
    },
  ])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ BOGUS: 'pass://Prod/Does-Not-Exist/x' }), {
    annotate,
    runner,
  })
  assert.equal(report.resolved.length, 0)
  const failure = report.failures[0]
  assert.ok(failure)
  assert.match(formatFailure(failure), /^BOGUS -> pass:\/\/Prod\/Does-Not-Exist\/x \(.*Does-Not-Exist.*\)$/)
  assert.ok(lines.some(line => line.includes('Failed to resolve secret for BOGUS')))
  assert.ok(lines.some(line => line.includes("item 'Does-Not-Exist' was not found")), 'hint emitted')
})

test('field glob expands to sanitized suffixed names', async () => {
  const itemJson = JSON.stringify({
    title: 'multi',
    fields: [
      { name: 'host', value: 'h' },
      { name: 'API Key', value: 'k' },
    ],
  })
  const { runner, calls } = cannedRunner([
    { match: args => args.includes('json'), result: { stdout: itemJson } },
    { match: args => args.includes('pass://Vault/Item/host'), result: { stdout: 'db.example.com' } },
    { match: args => args.includes('pass://Vault/Item/API Key'), result: { stdout: 'k-value' } },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ DB: 'pass://Vault/Item/*' }), { annotate, runner })
  assert.deepEqual(
    report.resolved.map(secret => secret.name).sort(),
    ['DB_API_KEY', 'DB_HOST'],
  )
  assert.deepEqual(calls[0], ['item', 'view', '--output', 'json', '--', 'pass://Vault/Item'])
})

test('glob with zero fields fails with "matched zero fields"', async () => {
  const { runner } = cannedRunner([
    { match: args => args.includes('json'), result: { stdout: '{"title":"empty","fields":[]}' } },
  ])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ EMPTY: 'pass://Vault/empty-item/*' }), {
    annotate,
    runner,
  })
  assert.equal(report.failures[0]?.detail, 'matched zero fields')
  assert.ok(lines.some(line => line.includes('matched zero fields')))
})

test('suffix collision fails listing both raw field names', async () => {
  const itemJson = JSON.stringify({
    fields: [
      { name: 'api-key', value: 'a' },
      { name: 'api_key', value: 'b' },
    ],
  })
  const { runner } = cannedRunner([{ match: args => args.includes('json'), result: { stdout: itemJson } }])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ X: 'pass://Vault/collision-item/*' }), {
    annotate,
    runner,
  })
  assert.equal(report.failures[0]?.detail, 'field-name collision')
  assert.equal(report.resolved.length, 0)
  const collisionLine = lines.find(line => line.includes('X_API_KEY'))
  assert.ok(collisionLine)
  assert.ok(collisionLine.includes('api-key') && collisionLine.includes('api_key'))
})

test('field sanitizing to an empty suffix fails the glob', async () => {
  const itemJson = JSON.stringify({ fields: [{ name: '---', value: 'x' }] })
  const { runner } = cannedRunner([{ match: args => args.includes('json'), result: { stdout: itemJson } }])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ BAD: 'pass://Vault/bad-suffix-item/*' }), {
    annotate,
    runner,
  })
  assert.match(report.failures[0]?.detail ?? '', /sanitizes to an empty suffix/)
  assert.ok(lines.some(line => line.includes('sanitizes to an empty suffix')))
})

test('vault/item wildcards are rejected without calling pass-cli', async () => {
  const { runner, calls } = cannedRunner([])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(
    refsFor({ BAD_ITEM: 'pass://Vault/*/password', BAD_VAULT: 'pass://*/item/password' }),
    { annotate, runner },
  )
  assert.equal(report.failures.length, 2)
  assert.equal(calls.length, 0)
  assert.ok(lines.some(line => line.includes('only supported in the field segment')))
})

test('partial field wildcard is rejected', async () => {
  const { runner } = cannedRunner([])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ BAD: 'pass://Vault/Item/pass*' }), { annotate, runner })
  assert.equal(report.failures[0]?.detail, 'partial wildcards not supported')
  assert.ok(lines.some(line => line.includes('Partial wildcards are not supported')))
})

test('one failing secret does not stop later ones from resolving', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Prod/Does-Not-Exist/x'),
      result: { exitCode: 1, stderr: 'nope' },
    },
    { match: args => args.includes('pass://Vault/Item/good'), result: { stdout: 'good-value' } },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(
    refsFor({ BOGUS: 'pass://Prod/Does-Not-Exist/x', GOOD: 'pass://Vault/Item/good' }),
    { annotate, runner },
  )
  assert.equal(report.resolved.length, 1)
  assert.equal(report.failures.length, 1)
})
