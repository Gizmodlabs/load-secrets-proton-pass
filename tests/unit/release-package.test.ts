import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { packageRelease } from '../../src/release-package.ts'

const execFileAsync = promisify(execFile)
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('release package contains only the action distribution and verifies its checksum', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'release-package-'))
  try {
    const result = await packageRelease({ tag: 'v1.1.0', outDir, projectRoot: PROJECT_ROOT })
    const archive = await fs.readFile(result.tarball)
    const checksum = await fs.readFile(result.checksum, 'utf8')
    assert.match(checksum, new RegExp(createHash('sha256').update(archive).digest('hex')))

    // bsdtar on Windows and GNU tar elsewhere differ in line endings, in whether
    // entries carry a leading ./, and in directory trailing slashes. The assertion
    // is about archive membership, so normalize before comparing.
    const { stdout } = await execFileAsync('tar', ['-tzf', result.tarball])
    const files = stdout
      .split(/\r?\n/)
      .map(line => line.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(line => line !== '')
    for (const required of ['action.yml', 'README.md', 'LICENSE', 'CLAUDE.md', 'CHANGELOG.md', 'dist/index.js', 'dist/cleanup.js']) {
      assert.ok(files.includes(required), `${required} is packaged; archive holds ${JSON.stringify(files)}`)
    }
    assert.ok(files.every(file => !file.startsWith('tests/') && !file.startsWith('.github/') && !file.startsWith('.git/')))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('release package rejects invalid tags', async () => {
  await assert.rejects(packageRelease({ tag: 'release-1.1.0', outDir: tmpdir(), projectRoot: PROJECT_ROOT }), /vMAJOR\.MINOR\.PATCH/)
})
