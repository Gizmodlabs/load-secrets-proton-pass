import { chmodSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = dirname(fileURLToPath(import.meta.url))

/** @param {string} binDir */
export function materializeMockCli(binDir) {
  copyFileSync(join(fixturesDir, 'mock-pass-cli.mjs'), join(binDir, 'mock-pass-cli.mjs'))
  copyFileSync(join(fixturesDir, 'pem-fixture.mjs'), join(binDir, 'pem-fixture.mjs'))

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
}
