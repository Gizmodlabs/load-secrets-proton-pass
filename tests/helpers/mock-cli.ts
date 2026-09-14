import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeMockCli } from '../fixtures/materialize-mock.mjs'

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
  materializeMockCli(binDir)

  return {
    binDir,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  }
}
