import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifySha256 } from '../../src/installer/install.ts'

function tempFileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-hash-'))
  const file = join(dir, 'binary')
  writeFileSync(file, content)
  return file
}

test('accepts a file whose SHA-256 matches (case-insensitive)', async () => {
  const file = tempFileWith('binary-bytes')
  const digest = createHash('sha256').update('binary-bytes').digest('hex')
  await verifySha256(file, digest.toUpperCase())
  assert.ok(existsSync(file))
})

test('rejects and deletes the file on mismatch, without leaking the actual hash', async () => {
  const file = tempFileWith('tampered-bytes')
  const actual = createHash('sha256').update('tampered-bytes').digest('hex')
  await assert.rejects(verifySha256(file, 'deadbeef'.repeat(8)), (err: Error) => {
    assert.match(err.message, /SHA-256 mismatch/)
    assert.ok(!err.message.includes(actual), 'actual hash of tampered binary must not be disclosed')
    return true
  })
  assert.ok(!existsSync(file), 'unverified binary must be deleted')
})
