#!/usr/bin/env node
// Mock pass-cli for offline testing. Deterministic values per URI, mirroring
// tests/mock-pass-cli.sh from the bash version, plus a multiline PEM item.
// Like the real CLI, `item view` prints the stored value followed by one newline.
// Understands the `--` argument separator the action now always passes.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PEM_KEY } from './pem-fixture.mjs'

const argv = process.argv.slice(2)
const command = argv[0]

function sessionFile() {
  const dir = process.env.PROTON_PASS_SESSION_DIR
  if (process.env.MOCK_PASS_CLI_AUTH_LOG) {
    appendFileSync(
      process.env.MOCK_PASS_CLI_AUTH_LOG,
      `${command}\t${process.env.PROTON_PASS_KEY_PROVIDER ?? ''}\t${dir ?? ''}\n`,
    )
  }
  if (!dir || process.env.PROTON_PASS_KEY_PROVIDER !== 'fs') fail('Missing filesystem session environment (mock)')
  return join(dir, 'mock-session')
}

function out(text) {
  process.stdout.write(text)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const ITEM_JSON = {
  'GithubActions/multi-field-item': {
    title: 'multi-field-item',
    fields: [
      { name: 'host', value: 'db.example.com' },
      { name: 'port', value: '5432' },
      { name: 'password', value: 'hunter2' },
    ],
  },
  'GithubActions/empty-item': { title: 'empty-item', fields: [] },
  'GithubActions/collision-item': {
    title: 'collision-item',
    fields: [
      { name: 'api-key', value: 'a' },
      { name: 'api_key', value: 'b' },
    ],
  },
  'GithubActions/sanitize-item': {
    title: 'sanitize-item',
    fields: [
      { name: 'API Key', value: 'sanitize-apikey-value' },
      { name: 'database-name', value: 'sanitize-dbname-value' },
    ],
  },
  'GithubActions/bad-suffix-item': {
    title: 'bad-suffix-item',
    fields: [{ name: '---', value: 'unreachable' }],
  },
}

const FIELD_VALUES = {
  'GithubActions/load-secrets-proton-pass-test/Password': 'mock-real-password',
  'GithubActions/load-secrets-proton-pass-test/Email': 'mock@example.com',
  'GithubActions/multi-field-item/host': 'db.example.com',
  'GithubActions/multi-field-item/port': '5432',
  'GithubActions/multi-field-item/password': 'hunter2',
  'GithubActions/sanitize-item/API Key': 'sanitize-apikey-value',
  'GithubActions/sanitize-item/database-name': 'sanitize-dbname-value',
  'GithubActions/ssh-key-item/private-key': PEM_KEY,
}

function itemView(args) {
  let uri = ''
  let output = 'human'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--output') {
      output = args[i + 1] ?? 'human'
      i++
    } else if (arg === '--') {
      // separator — everything after is positional
    } else if (arg.startsWith('pass://')) {
      uri = arg
    }
  }
  const path = uri.replace(/^pass:\/\//, '')

  if (output === 'json') {
    const item = ITEM_JSON[path]
    if (!item) fail(`Unknown mock item: ${path}`)
    out(`${JSON.stringify(item)}\n`)
    process.exit(0)
  }

  if (path.includes('Does-Not-Exist')) {
    fail("Error: Could not find item by name 'Does-Not-Exist'")
  }
  // Real pass-cli prints the stored value with println!: value + exactly one newline.
  const value = FIELD_VALUES[path]
  if (value === undefined) fail(`Unknown mock field: ${path}`)
  out(`${value}\n`)
  process.exit(0)
}

function inject(args) {
  let template = ''
  let output = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i') template = args[++i] ?? ''
    if (args[i] === '-o') output = args[++i] ?? ''
  }
  if (!template || !output) fail('inject requires -i and -o')
  const rendered = readFileSync(template, 'utf8').replace(
    /\{\{ *pass:\/\/[^}]+ *\}\}/g,
    'mock-injected-value',
  )
  writeFileSync(output, rendered)
  process.exit(0)
}

switch (command) {
  case 'login': {
    const file = sessionFile()
    writeFileSync(file, 'partial')
    if (process.env.MOCK_PASS_CLI_FAIL_LOGIN === 'true') fail('Login failed (mock)')
    writeFileSync(file, 'active')
    out('Login successful (mock)\n')
    process.exit(0)
    break
  }
  case 'info': {
    const file = sessionFile()
    if (process.env.MOCK_PASS_CLI_FAIL_INFO === 'true' || !existsSync(file) || readFileSync(file, 'utf8') !== 'active') {
      fail('No active session (mock)')
    }
    out('Personal Access Token: github-actions (mock)\n')
    process.exit(0)
    break
  }
  case 'logout': {
    const file = sessionFile()
    if (process.env.MOCK_PASS_CLI_FAIL_LOGOUT === 'true') fail('Logout failed (mock)')
    rmSync(file, { force: true })
    out('Logged out (mock)\n')
    process.exit(0)
    break
  }
  case '--version':
    out('pass-cli 1.0.0 (mock)\n')
    process.exit(0)
    break
  case 'item':
    if (argv[1] === 'view') itemView(argv.slice(2))
    fail(`Unknown item subcommand: ${argv[1]}`)
    break
  case 'inject':
    inject(argv.slice(1))
    break
  default:
    fail(`Unknown command: ${command}`)
}
