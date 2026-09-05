import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptsPreinstalled, DEFAULT_PASS_CLI_VERSION } from '../../src/installer/install.ts'

const MOCK_VERSION_OUTPUT = 'pass-cli 1.0.0 (mock)\n'

test('unset version accepts whatever pass-cli is already on PATH (install-cli-action interop)', () => {
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, ''), true)
})

test('latest accepts whatever pass-cli is already on PATH', () => {
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, 'latest'), true)
})

test('an explicit version must appear in --version output', () => {
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, '1.0.0'), true)
  assert.equal(acceptsPreinstalled(MOCK_VERSION_OUTPUT, '2.3.3'), false)
})

test('the default is a pinned MAJOR.MINOR.PATCH, not latest', () => {
  assert.match(DEFAULT_PASS_CLI_VERSION, /^\d+\.\d+\.\d+$/)
})
