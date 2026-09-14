import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPlatform, resolvePlatform, VALID_PLATFORMS } from '../../src/installer/platform.ts'

const DETECTION_CASES: ReadonlyArray<[NodeJS.Platform, NodeJS.Architecture, string]> = [
  ['linux', 'x64', 'linux-x86_64'],
  ['linux', 'arm64', 'linux-aarch64'],
  ['darwin', 'x64', 'macos-x86_64'],
  ['darwin', 'arm64', 'macos-aarch64'],
  ['win32', 'x64', 'windows-x86_64'],
]

for (const [os, arch, expected] of DETECTION_CASES) {
  test(`detects ${os}/${arch} as ${expected}`, () => {
    assert.equal(detectPlatform(os, arch), expected)
  })
}

test('throws an actionable error for unsupported combos', () => {
  assert.throws(() => detectPlatform('freebsd', 'x64'), /Unsupported platform/)
  assert.throws(() => detectPlatform('win32', 'arm64'), /Unsupported platform/)
})

test('resolvePlatform detects when input empty', () => {
  assert.ok((VALID_PLATFORMS as readonly string[]).includes(resolvePlatform('')))
})

for (const platform of VALID_PLATFORMS) {
  test(`resolvePlatform accepts explicit ${platform}`, () => {
    assert.equal(resolvePlatform(platform), platform)
  })
}

test('resolvePlatform rejects unknown values listing valid ones', () => {
  assert.throws(() => resolvePlatform('linux-mips'), /linux-x86_64/)
})
