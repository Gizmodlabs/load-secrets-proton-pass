#!/usr/bin/env node
// Installs the mock pass-cli onto the runner PATH for smoke workflows.
// Cross-platform: writes a shell shim on POSIX and a .cmd shim on Windows,
// then appends the bin dir to $GITHUB_PATH (or prints it when run locally).
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = dirname(fileURLToPath(import.meta.url))
const binDir = mkdtempSync(join(tmpdir(), 'mock-pass-cli-'))

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

if (process.env.GITHUB_PATH) {
  appendFileSync(process.env.GITHUB_PATH, `${binDir}\n`)
}
console.log(binDir)
