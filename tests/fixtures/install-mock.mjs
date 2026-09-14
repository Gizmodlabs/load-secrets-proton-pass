#!/usr/bin/env node
// Installs the mock pass-cli onto the runner PATH for smoke workflows.
// Cross-platform: writes a shell shim on POSIX and a .cmd shim on Windows,
// then appends the bin dir to $GITHUB_PATH (or prints it when run locally).
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = dirname(fileURLToPath(import.meta.url))
const binDir = mkdtempSync(join(tmpdir(), 'mock-pass-cli-'))

// Copy every fixture module, not a hand-listed subset: the mock imports its
// siblings, and a missing one makes the shim fail to start, which surfaces in
// smoke jobs as pass-cli itself being broken rather than as a clear error.
for (const entry of readdirSync(fixturesDir)) {
  if (entry.endsWith('.mjs') && entry !== 'install-mock.mjs') {
    copyFileSync(join(fixturesDir, entry), join(binDir, entry))
  }
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

if (process.env.GITHUB_PATH) {
  appendFileSync(process.env.GITHUB_PATH, `${binDir}\n`)
}
console.log(binDir)
