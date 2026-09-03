import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RELEASES_BASE,
  assetName,
  downloadUrl,
  checksumUrl,
  assertValidVersion,
  parseExpectedHash,
  resolveLatestVersion,
  fetchReleaseChecksum,
  resolveInstallerSpec,
  type ReleaseHttp,
} from '../../src/installer/release.ts'

const HASH = 'b5b49a8b3fd0af8830c0c1979f28ea0c90ccece73f59023a8bca8245d4b68da9'

function fakeHttp(overrides: Partial<ReleaseHttp> = {}): ReleaseHttp {
  return {
    async head() {
      return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases/tag/2.3.3' }
    },
    async getText(url) {
      if (url.endsWith('.sha256')) return { statusCode: 200, body: `${HASH}  pass-cli-linux-x86_64\n` }
      return { statusCode: 404, body: 'Not Found' }
    },
    ...overrides,
  }
}

test('assetName: windows is a zip, everything else a bare binary', () => {
  assert.equal(assetName('windows-x86_64'), 'pass-cli-windows-x86_64.zip')
  assert.equal(assetName('linux-x86_64'), 'pass-cli-linux-x86_64')
  assert.equal(assetName('macos-aarch64'), 'pass-cli-macos-aarch64')
})

test('downloadUrl/checksumUrl point at the GitHub release asset and its .sha256 sidecar', () => {
  assert.equal(RELEASES_BASE, 'https://github.com/protonpass/pass-cli/releases')
  assert.equal(
    downloadUrl('2.3.3', 'linux-x86_64'),
    'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-linux-x86_64',
  )
  assert.equal(
    checksumUrl('2.3.3', 'windows-x86_64'),
    'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-windows-x86_64.zip.sha256',
  )
})

test('assertValidVersion accepts MAJOR.MINOR.PATCH only', () => {
  assert.doesNotThrow(() => assertValidVersion('2.3.3'))
  for (const bad of ['v2.3.3', '2.3', '2.0.0-beta.1', '../../etc/passwd', '2.3.3; rm -rf /', 'latest', '']) {
    assert.throws(() => assertValidVersion(bad), /Invalid pass-cli version/, bad)
  }
})

test('parseExpectedHash accepts 64 hex chars (any case, surrounding whitespace) and lowercases', () => {
  const upper = 'B5B49A8B3FD0AF8830C0C1979F28EA0C90CCECE73F59023A8BCA8245D4B68DA9'
  assert.equal(parseExpectedHash(`  ${upper}\n`), upper.toLowerCase())
  for (const bad of ['deadbeef', 'zz'.repeat(32), '', `${upper}0`]) {
    assert.throws(() => parseExpectedHash(bad), /Invalid "hash" input/, bad)
  }
})

test('resolveLatestVersion parses the version out of the 302 Location header', async () => {
  assert.equal(await resolveLatestVersion(fakeHttp()), '2.3.3')
  const withV = fakeHttp({
    async head() {
      return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases/tag/v2.4.0' }
    },
  })
  assert.equal(await resolveLatestVersion(withV), '2.4.0')
})

test('resolveLatestVersion fails closed on non-redirect, missing, or malformed Location', async () => {
  const cases: Array<Partial<ReleaseHttp>> = [
    { async head() { return { statusCode: 200, location: undefined } } },
    { async head() { return { statusCode: 302, location: undefined } } },
    { async head() { return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases' } } },
    { async head() { return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases/tag/../x' } } },
  ]
  for (const c of cases) {
    await assert.rejects(resolveLatestVersion(fakeHttp(c)), /latest pass-cli version|Invalid pass-cli version/)
  }
})

test('fetchReleaseChecksum reads the first token of "<hex>  <filename>" and lowercases it', async () => {
  const upper = fakeHttp({
    async getText() { return { statusCode: 200, body: `${HASH.toUpperCase()}  pass-cli-linux-x86_64` } },
  })
  assert.equal(await fetchReleaseChecksum('2.3.3', 'linux-x86_64', upper), HASH)
  const bare = fakeHttp({ async getText() { return { statusCode: 200, body: `${HASH}\n` } } })
  assert.equal(await fetchReleaseChecksum('2.3.3', 'linux-x86_64', bare), HASH)
})

test('fetchReleaseChecksum fails closed on 404, oversized, or non-hex body', async () => {
  const notFound = fakeHttp({ async getText() { return { statusCode: 404, body: 'Not Found' } } })
  await assert.rejects(
    fetchReleaseChecksum('2.1.0', 'linux-x86_64', notFound),
    /2\.1\.0\/pass-cli-linux-x86_64\.sha256 \(HTTP 404\).*unverified/s,
  )
  const huge = fakeHttp({ async getText() { return { statusCode: 200, body: 'a'.repeat(2048) } } })
  await assert.rejects(fetchReleaseChecksum('2.3.3', 'linux-x86_64', huge), /too large.*unverified/s)
  const html = fakeHttp({ async getText() { return { statusCode: 200, body: '<!DOCTYPE html><html>' } } })
  await assert.rejects(fetchReleaseChecksum('2.3.3', 'linux-x86_64', html), /did not contain a SHA-256.*unverified/s)
})

test('resolveInstallerSpec: pinned version + sidecar', async () => {
  const spec = await resolveInstallerSpec('2.3.3', 'linux-x86_64', '', fakeHttp())
  assert.deepEqual(spec, {
    version: '2.3.3',
    platform: 'linux-x86_64',
    url: 'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-linux-x86_64',
    sha256: HASH,
  })
})

test('resolveInstallerSpec: latest resolves through the redirect, then fetches that version’s sidecar', async () => {
  const seen: string[] = []
  const http = fakeHttp({
    async getText(url) {
      seen.push(url)
      return { statusCode: 200, body: `${HASH}  x` }
    },
  })
  const spec = await resolveInstallerSpec('latest', 'windows-x86_64', '', http)
  assert.equal(spec.version, '2.3.3')
  assert.equal(spec.url, 'https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-windows-x86_64.zip')
  assert.deepEqual(seen, ['https://github.com/protonpass/pass-cli/releases/download/2.3.3/pass-cli-windows-x86_64.zip.sha256'])
})

test('resolveInstallerSpec: a caller-supplied hash is used verbatim and the sidecar is never fetched', async () => {
  const http = fakeHttp({
    async getText() { throw new Error('sidecar must not be fetched when hash is supplied') },
  })
  const spec = await resolveInstallerSpec('2.3.3', 'linux-x86_64', HASH.toUpperCase(), http)
  assert.equal(spec.sha256, HASH)
})

test('resolveInstallerSpec: rejects malformed version and malformed hash before any network call', async () => {
  const http = fakeHttp({
    async head() { throw new Error('no network expected') },
    async getText() { throw new Error('no network expected') },
  })
  await assert.rejects(resolveInstallerSpec('2.1', 'linux-x86_64', '', http), /Invalid pass-cli version/)
  await assert.rejects(resolveInstallerSpec('2.3.3', 'linux-x86_64', 'nope', http), /Invalid "hash" input/)
})
