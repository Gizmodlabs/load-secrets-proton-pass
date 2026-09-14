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

for (const [description, output, requested, accepted] of [
  ['matches the mock version', MOCK_VERSION_OUTPUT, '1.0.0', true],
  ['rejects a different version', MOCK_VERSION_OUTPUT, '2.3.3', false],
  ['matches the complete version', 'pass-cli 2.3.3\n', '2.3.3', true],
  ['accepts an output v prefix', 'pass-cli v2.3.3\n', '2.3.3', true],
  ['rejects a longer patch', 'pass-cli 2.3.30', '2.3.3', false],
  ['rejects a longer major', 'pass-cli 12.3.3', '2.3.3', false],
  ['rejects an installed prerelease', 'pass-cli 2.3.3-beta.1', '2.3.3', false],
  ['rejects installed build metadata', 'pass-cli 2.3.3+build.1', '2.3.3', false],
  ['rejects a different command', 'other-cli 2.3.3', '2.3.3', false],
  ['rejects a misplaced version', 'pass-cli unknown 2.3.3', '2.3.3', false],
  ['rejects an incomplete request', 'pass-cli 2.3.3', '2.3', false],
  ['rejects a request substring', 'pass-cli 2.3.3', '3.3', false],
  ['rejects a command-name request', 'pass-cli 2.3.3', 'pass-cli', false],
  ['rejects a blank request', 'pass-cli 2.3.3', ' ', false],
  ['rejects a request v prefix', 'pass-cli v2.3.3', 'v2.3.3', false],
  ['rejects a prerelease request', 'pass-cli 2.3.3-beta.1', '2.3.3-beta.1', false],
] as const) {
  test(`an explicit version ${description}`, () => {
    assert.equal(acceptsPreinstalled(output, requested), accepted)
  })
}

test('the default is a pinned MAJOR.MINOR.PATCH, not latest', () => {
  assert.match(DEFAULT_PASS_CLI_VERSION, /^\d+\.\d+\.\d+$/)
})
