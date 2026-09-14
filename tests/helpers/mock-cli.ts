import { chmodSync, copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export interface MockCli {
  readonly binDir: string
  cleanup(): void
}

/**
 * Materialize the mock pass-cli into a temp dir that can be prepended to
 * PATH. Uses a shell shim on POSIX and a .cmd shim on Windows so the same
 * node script backs `pass-cli` on every runner OS.
 */
export function installMockPassCli(): MockCli {
  const binDir = mkdtempSync(join(tmpdir(), 'mock-pass-cli-'))
  // Copy every fixture module, not a hand-listed subset: the mock imports its
  // siblings, and a missing one makes the shim fail to start, which surfaces
  // as every integration test exiting non-zero rather than as a clear error.
  for (const entry of readdirSync(FIXTURES_DIR)) {
    if (entry.endsWith('.mjs')) copyFileSync(join(FIXTURES_DIR, entry), join(binDir, entry))
  }

  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'pass-cli.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0mock-pass-cli.mjs" %*\r\n`,
    )
  } else {
    const shim = join(binDir, 'pass-cli')
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/mock-pass-cli.mjs" "$@"\n`)
    chmodSync(shim, 0o755)
  }

  return {
    binDir,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  }
}
