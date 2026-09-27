import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveOutputPath, injectedValues } from '../../src/template/inject.ts'

test('deriveOutputPath: explicit input > strip .template > strip .tpl > append .resolved', () => {
  assert.equal(deriveOutputPath('app.env.template', 'out.env'), 'out.env')
  assert.equal(deriveOutputPath('app.env.template', ''), 'app.env')
  assert.equal(deriveOutputPath('app.env.tpl', ''), 'app.env')
  assert.equal(deriveOutputPath('app.env', ''), 'app.env.resolved')
})

test('injectedValues recovers each value, whatever surrounds the placeholder', () => {
  const template =
    'PLAIN={{ pass://V/I/plain }}\n' +
    'QUOTED="{{pass://V/I/quoted}}"\n' +
    'password: {{  pass://V/I/yaml  }}\n'
  const rendered = 'PLAIN=p1\nQUOTED="q1"\npassword: y1\n'
  assert.deepEqual(injectedValues(template, rendered), ['p1', 'q1', 'y1'])
})

test('injectedValues splits several placeholders on one line', () => {
  const template = 'DSN=postgres://{{ pass://V/I/user }}:{{ pass://V/I/pw }}@db/app\n'
  assert.deepEqual(injectedValues(template, 'DSN=postgres://alice:s3cret@db/app\n'), ['alice', 's3cret'])
})

test('injectedValues keeps a multiline value whole, trailing newline included', () => {
  const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----\n'
  const template = 'KEY="{{ pass://V/I/pem }}"\nNEXT=1\n'
  assert.deepEqual(injectedValues(template, `KEY="${pem}"\nNEXT=1\n`), [pem])
})

test('injectedValues returns adjacent placeholders as one span', () => {
  const template = 'X={{ pass://V/I/a }}{{ pass://V/I/b }}\n'
  assert.deepEqual(injectedValues(template, 'X=first-second\n'), ['first-second'])
})

test('injectedValues handles a template ending in a placeholder and one with none', () => {
  assert.deepEqual(injectedValues('A={{ pass://V/I/a }}', 'A=tail'), ['tail'])
  assert.deepEqual(injectedValues('STATIC=1\n', 'STATIC=1\n'), [])
})

test('injectedValues returns null when the output does not line up with the template', () => {
  assert.equal(injectedValues('STATIC=1\n', 'STATIC=2\n'), null)
  assert.equal(injectedValues('A={{ pass://V/I/a }}\nB=2\n', 'A=x\nB=3\n'), null)
  assert.equal(injectedValues('HEAD {{ pass://V/I/a }}', 'OTHER x'), null)
  assert.equal(injectedValues('A={{ pass://V/I/a }}\nB={{ pass://V/I/b }}\n', 'A=x\n'), null)
})
