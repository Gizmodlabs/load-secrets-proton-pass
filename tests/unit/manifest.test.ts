import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInstallerSpec } from '../../src/installer/manifest.ts'

const MANIFEST = {
  passCliVersions: [
    {
      version: '2.0.5',
      urls: {
        linux: {
          x86_64: { url: 'https://proton.me/download/pass-cli/2.0.5/pass-cli-linux-x86_64', hash: 'aaa5' },
        },
      },
    },
    {
      version: '2.1.0',
      urls: {
        linux: {
          x86_64: { url: 'https://proton.me/download/pass-cli/2.1.0/pass-cli-linux-x86_64', hash: 'a1b2' },
          aarch64: { url: 'https://proton.me/download/pass-cli/2.1.0/pass-cli-linux-aarch64', hash: 'c3d4' },
        },
        macos: {
          aarch64: { url: 'https://proton.me/download/pass-cli/2.1.0/pass-cli-macos-aarch64', hash: 'e5f6' },
        },
        windows: {
          x86_64: { url: 'https://proton.me/download/pass-cli/2.1.0/pass-cli-windows-x86_64.zip', hash: '0709' },
        },
      },
    },
  ],
}

const fetchManifest = async () => MANIFEST as unknown

test('resolves a pinned version to url + hash for the platform', async () => {
  const spec = await resolveInstallerSpec('2.1.0', 'linux-x86_64', fetchManifest)
  assert.equal(spec.version, '2.1.0')
  assert.equal(spec.sha256, 'a1b2')
  assert.equal(spec.url, 'https://proton.me/download/pass-cli/2.1.0/pass-cli-linux-x86_64')
})

test('resolves latest to the highest semver in the manifest', async () => {
  const spec = await resolveInstallerSpec('latest', 'linux-x86_64', fetchManifest)
  assert.equal(spec.version, '2.1.0')
  assert.equal(spec.sha256, 'a1b2')
})

test('fails closed when the manifest is unreachable', async () => {
  const failingFetch = async () => {
    throw new Error('connect ETIMEDOUT')
  }
  await assert.rejects(
    resolveInstallerSpec('2.1.0', 'linux-x86_64', failingFetch),
    /versions\.json.*ETIMEDOUT/s,
  )
})

test('fails closed when the requested version is not in the manifest', async () => {
  await assert.rejects(resolveInstallerSpec('9.9.9', 'linux-x86_64', fetchManifest), /9\.9\.9/)
})

test('fails closed when the platform entry is missing', async () => {
  await assert.rejects(resolveInstallerSpec('2.1.0', 'macos-x86_64', fetchManifest), /macos-x86_64/)
})

test('fails closed when the hash is missing or empty', async () => {
  const noHash = {
    passCliVersions: [
      {
        version: '2.1.0',
        urls: { linux: { x86_64: { url: 'https://example.com/pass-cli', hash: '' } } },
      },
    ],
  }
  await assert.rejects(
    resolveInstallerSpec('2.1.0', 'linux-x86_64', async () => noHash as unknown),
    /SHA-256/,
  )
})

test('fails closed on an unexpected manifest schema', async () => {
  await assert.rejects(
    resolveInstallerSpec('2.1.0', 'linux-x86_64', async () => ({ nope: true }) as unknown),
    /schema/i,
  )
})
