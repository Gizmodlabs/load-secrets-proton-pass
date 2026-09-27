// The installer's security claim is about ordering: a download reaches the
// tool cache and PATH only after its SHA-256 matched. verify-hash.test.ts
// covers the check itself; these tests cover the wiring around it, which the
// real-vault e2e exercises but cannot prove (it passes with or without the
// check).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PASS_CLI_VERSION, ensurePassCli, type InstallDeps } from '../../src/installer/install.ts'

const BINARY = 'pass-cli binary bytes'
const BINARY_SHA256 = createHash('sha256').update(BINARY).digest('hex')
const WRONG_SHA256 = 'deadbeef'.repeat(8)
const PLATFORM = 'linux-x86_64'

const scratchDirs: string[] = []
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakeInstall {
  readonly deps: InstallDeps
  /** Every side effect, in order: `sidecar <url>`, `download <url>`, `cache <version>`, `addPath <dir>`. */
  readonly events: string[]
  readonly downloadedFile: () => string
}

function fakeInstall(options: { installed?: string; sidecarSha256?: string } = {}): FakeInstall {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-pass-cli-'))
  scratchDirs.push(dir)
  const events: string[] = []
  const file = join(dir, 'download')
  const deps: InstallDeps = {
    installedVersion: async () => options.installed ?? null,
    http: {
      async head() {
        return { statusCode: 302, location: 'https://github.com/protonpass/pass-cli/releases/tag/9.9.9' }
      },
      async getText(url) {
        events.push(`sidecar ${url}`)
        return { statusCode: 200, body: `${options.sidecarSha256 ?? BINARY_SHA256}  pass-cli-${PLATFORM}\n` }
      },
    },
    async download(url) {
      events.push(`download ${url}`)
      writeFileSync(file, BINARY)
      return file
    },
    async cache(_downloadPath, version) {
      events.push(`cache ${version}`)
      return join(dir, 'tool-cache')
    },
    addPath: path => events.push(`addPath ${path}`),
  }
  return { deps, events, downloadedFile: () => file }
}

const kinds = (events: string[]) => events.map(event => event.split(' ')[0])

test('a sidecar checksum mismatch aborts before cache or PATH, and deletes the download', async () => {
  const { deps, events, downloadedFile } = fakeInstall({ sidecarSha256: WRONG_SHA256 })
  await assert.rejects(ensurePassCli({ version: '2.3.3', hash: '', platform: PLATFORM }, deps), /SHA-256 mismatch/)
  assert.deepEqual(kinds(events), ['sidecar', 'download'], 'nothing is cached or put on PATH')
  assert.ok(!existsSync(downloadedFile()), 'the unverified binary is removed')
})

test('a caller-supplied hash is enforced the same way, without fetching the sidecar', async () => {
  const { deps, events } = fakeInstall()
  await assert.rejects(
    ensurePassCli({ version: '2.3.3', hash: WRONG_SHA256, platform: PLATFORM }, deps),
    /SHA-256 mismatch/,
  )
  assert.deepEqual(kinds(events), ['download'])
})

test('a verified download is cached, then put on PATH, in that order', async () => {
  const { deps, events } = fakeInstall()
  await ensurePassCli({ version: '2.3.3', hash: '', platform: PLATFORM }, deps)
  assert.deepEqual(kinds(events), ['sidecar', 'download', 'cache', 'addPath'])
  assert.ok(events[1]?.endsWith(`/download/2.3.3/pass-cli-${PLATFORM}`), events[1])
})

test('unset version with no pass-cli on PATH installs the pinned default', async () => {
  const { deps, events } = fakeInstall()
  await ensurePassCli({ version: '', hash: '', platform: PLATFORM }, deps)
  assert.ok(events.some(event => event === `cache ${DEFAULT_PASS_CLI_VERSION}`), JSON.stringify(events))
})

test('unset version accepts any pass-cli already on PATH and touches nothing', async () => {
  const { deps, events } = fakeInstall({ installed: 'Proton Pass CLI 2.1.2 (abc1234)' })
  await ensurePassCli({ version: '', hash: '', platform: PLATFORM }, deps)
  assert.deepEqual(events, [])
})

test('an explicit version different from the one on PATH is downloaded and verified', async () => {
  const { deps, events } = fakeInstall({ installed: 'Proton Pass CLI 2.3.2 (abc1234)' })
  await ensurePassCli({ version: '2.3.3', hash: '', platform: PLATFORM }, deps)
  assert.deepEqual(kinds(events), ['sidecar', 'download', 'cache', 'addPath'])
})

test('an explicit version that matches the real CLI on PATH is not downloaded again', async () => {
  const { deps, events } = fakeInstall({ installed: 'Proton Pass CLI 2.3.3 (04de99b)' })
  await ensurePassCli({ version: '2.3.3', hash: '', platform: PLATFORM }, deps)
  assert.deepEqual(events, [])
})
