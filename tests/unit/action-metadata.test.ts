// action.yml, src/inputs.ts and README.md each describe the inputs, and the
// pinned default pass-cli version is written out by hand in two of them.
// These tests keep the three from drifting apart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASS_CLI_VERSION } from '../../src/installer/install.ts'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path: string) => readFileSync(join(PROJECT_ROOT, path), 'utf8')

/** Input names declared in action.yml: the two-space-indented keys under `inputs:`. */
function declaredInputs(): string[] {
  const yml = read('action.yml').replaceAll('\r\n', '\n')
  const block = yml.slice(yml.indexOf('\ninputs:\n'), yml.indexOf('\noutputs:\n'))
  return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(match => match[1] ?? '').sort()
}

/** Input names src/inputs.ts reads, through core.getInput or booleanInput. */
function readInputNames(): string[] {
  const source = read('src/inputs.ts')
  const names = [...source.matchAll(/(?:getInput|booleanInput)\('([a-z0-9-]+)'/g)].map(match => match[1] ?? '')
  return [...new Set(names)].sort()
}

test('src/inputs.ts reads exactly the inputs action.yml declares', () => {
  assert.ok(declaredInputs().length > 0, 'parsed no inputs from action.yml')
  assert.deepEqual(readInputNames(), declaredInputs())
})

test('the README input table has a row for every input', () => {
  const readme = read('README.md')
  for (const name of declaredInputs()) {
    assert.match(readme, new RegExp(`^\\| \`${name}\` \\|`, 'm'), `README.md has no row for ${name}`)
  }
})

test('action.yml and the README name the pinned default pass-cli version', () => {
  const version = DEFAULT_PASS_CLI_VERSION.replaceAll('.', '\\.')
  assert.match(read('action.yml'), new RegExp(`to install ${version}\\b`), 'pass-cli-version description in action.yml')
  assert.match(read('README.md'), new RegExp(`\`''\` → \`${version}\``), 'pass-cli-version default in the README table')
})
