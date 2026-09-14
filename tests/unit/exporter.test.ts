import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSecrets, resolvedKeysCsv } from '../../src/export/exporter.ts'
import { readFileCommands } from '../helpers/file-commands.ts'
import type { ResolvedSecret } from '../../src/domain/resolution.ts'

const PEM_FIXTURE =
  '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n' +
  'QyNTUxOQAAACBjbW9ja21vY2ttb2NrbW9ja21vY2ttb2NrbW9ja21vY2sAAAAA\n' +
  '-----END OPENSSH PRIVATE KEY-----\n'

let scratchDir: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'exporter-test-'))
  savedEnv = { GITHUB_ENV: process.env.GITHUB_ENV, GITHUB_OUTPUT: process.env.GITHUB_OUTPUT }
  process.env.GITHUB_ENV = join(scratchDir, 'env')
  process.env.GITHUB_OUTPUT = join(scratchDir, 'output')
  writeFileSync(process.env.GITHUB_ENV, '')
  writeFileSync(process.env.GITHUB_OUTPUT, '')
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratchDir, { recursive: true, force: true })
})

const secret = (name: string, value: string): ResolvedSecret => ({
  name,
  uri: `pass://Vault/Item/${name}`,
  value,
})

test('multiline PEM value survives byte-exact through GITHUB_ENV (fix #1/#5 regression)', () => {
  exportSecrets([secret('SSH_KEY', PEM_FIXTURE)], { maskValues: true, exportEnv: true })
  const env = readFileCommands(process.env.GITHUB_ENV as string)
  assert.equal(env['SSH_KEY'], PEM_FIXTURE)
})

test('multiline PEM value survives byte-exact through GITHUB_OUTPUT (fix #1/#5 regression)', () => {
  exportSecrets([secret('SSH_KEY', PEM_FIXTURE)], { maskValues: true, exportEnv: false })
  const output = readFileCommands(process.env.GITHUB_OUTPUT as string)
  assert.equal(output['SSH_KEY'], PEM_FIXTURE)
})

test('values are never trimmed — trailing newline and inner whitespace preserved', () => {
  const value = '  padded \nsecond line\n'
  exportSecrets([secret('RAW', value)], { maskValues: false, exportEnv: true })
  const env = readFileCommands(process.env.GITHUB_ENV as string)
  assert.equal(env['RAW'], value)
})

test('step outputs always written; env vars only when exportEnv', () => {
  exportSecrets([secret('ONLY_OUTPUT', 'v1')], { maskValues: false, exportEnv: false })
  const output = readFileCommands(process.env.GITHUB_OUTPUT as string)
  const env = readFileCommands(process.env.GITHUB_ENV as string)
  assert.equal(output['ONLY_OUTPUT'], 'v1')
  assert.equal(env['ONLY_OUTPUT'], undefined)
})

test('resolvedKeysCsv sorts names and never includes values', () => {
  const csv = resolvedKeysCsv([secret('ZEBRA_KEY', 'z'), secret('ALPHA_KEY', 'a')])
  assert.equal(csv, 'ALPHA_KEY,ZEBRA_KEY')
})

test('resolvedKeysCsv is the empty string when nothing resolved', () => {
  assert.equal(resolvedKeysCsv([]), '')
})
