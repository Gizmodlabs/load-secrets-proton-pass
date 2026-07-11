import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePassUri } from '../../src/domain/pass-uri.ts'

test('parses a literal three-segment URI', () => {
  const uri = parsePassUri('pass://Production/Database/password')
  assert.ok(uri)
  assert.equal(uri.vault, 'Production')
  assert.equal(uri.item, 'Database')
  assert.equal(uri.field, 'password')
  assert.equal(uri.kind, 'literal')
  assert.equal(uri.raw, 'pass://Production/Database/password')
})

test('returns null for non-pass values', () => {
  assert.equal(parsePassUri('just-a-value'), null)
  assert.equal(parsePassUri(''), null)
  assert.equal(parsePassUri('https://example.com/a/b/c'), null)
})

test('returns null for pass:// values with fewer than three segments (bash parity: silently skipped)', () => {
  assert.equal(parsePassUri('pass://vault/item'), null)
  assert.equal(parsePassUri('pass://vault'), null)
  assert.equal(parsePassUri('pass://'), null)
})

test('greedy vault parity: extra slashes belong to the vault segment', () => {
  const uri = parsePassUri('pass://a/b/c/d')
  assert.ok(uri)
  assert.equal(uri.vault, 'a/b')
  assert.equal(uri.item, 'c')
  assert.equal(uri.field, 'd')
})

test('field segment of exactly * is a field glob', () => {
  const uri = parsePassUri('pass://GithubActions/multi-field-item/*')
  assert.ok(uri)
  assert.equal(uri.kind, 'field-glob')
  assert.equal(uri.field, '*')
})

test('wildcard in vault or item segment is invalid', () => {
  const vaultGlob = parsePassUri('pass://*/item/password')
  assert.ok(vaultGlob)
  assert.equal(vaultGlob.kind, 'invalid-vault-item-wildcard')

  const itemGlob = parsePassUri('pass://GithubActions/*/password')
  assert.ok(itemGlob)
  assert.equal(itemGlob.kind, 'invalid-vault-item-wildcard')
})

test('partial wildcard in field segment is invalid', () => {
  const uri = parsePassUri('pass://GithubActions/multi-field-item/pass*')
  assert.ok(uri)
  assert.equal(uri.kind, 'invalid-partial-field-wildcard')
})

test('itemUri drops the field segment (used for glob field listing)', () => {
  const uri = parsePassUri('pass://GithubActions/multi-field-item/*')
  assert.ok(uri)
  assert.equal(uri.itemUri, 'pass://GithubActions/multi-field-item')
})
