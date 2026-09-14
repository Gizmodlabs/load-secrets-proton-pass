#!/usr/bin/env node
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeMockCli } from './materialize-mock.mjs'

const binDir = mkdtempSync(join(tmpdir(), 'mock-pass-cli-'))
materializeMockCli(binDir)

if (process.env.GITHUB_PATH) {
  appendFileSync(process.env.GITHUB_PATH, `${binDir}\n`)
}
console.log(binDir)
