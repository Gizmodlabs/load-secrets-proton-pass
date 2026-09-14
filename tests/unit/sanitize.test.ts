import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSuffix } from '../../src/resolver/sanitize.ts'

test('uppercases and replaces spaces', () => {
  assert.equal(sanitizeSuffix('API Key'), 'API_KEY')
})

test('replaces dashes', () => {
  assert.equal(sanitizeSuffix('database-name'), 'DATABASE_NAME')
})

test('collapses runs of non-alphanumerics into one underscore', () => {
  assert.equal(sanitizeSuffix('a--b  c'), 'A_B_C')
})

test('strips leading and trailing underscores', () => {
  assert.equal(sanitizeSuffix('-key-'), 'KEY')
  assert.equal(sanitizeSuffix('__key__'), 'KEY')
})

test('all-symbol names sanitize to the empty string', () => {
  assert.equal(sanitizeSuffix('---'), '')
  assert.equal(sanitizeSuffix('   '), '')
})

test('plain names pass through uppercased', () => {
  assert.equal(sanitizeSuffix('host'), 'HOST')
  assert.equal(sanitizeSuffix('port'), 'PORT')
})
