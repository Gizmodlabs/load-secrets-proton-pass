#!/usr/bin/env node
// Mock pass-cli for offline testing. Deterministic values per URI, mirroring
// tests/mock-pass-cli.sh from the bash version, plus a multiline PEM item.
// Understands the `--` argument separator the action now always passes.
import { readFileSync, writeFileSync } from 'node:fs'
import { PEM_KEY } from './pem-fixture.mjs'

const argv = process.argv.slice(2)
const command = argv[0]

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
  'GithubActions/load-secrets-proton-pass-test/Password': 'mock-real-password\n',
  'GithubActions/load-secrets-proton-pass-test/Email': 'mock@example.com\n',
  'GithubActions/multi-field-item/host': 'db.example.com\n',
  'GithubActions/multi-field-item/port': '5432\n',
  'GithubActions/multi-field-item/password': 'hunter2\n',
  'GithubActions/sanitize-item/API Key': 'sanitize-apikey-value\n',
  'GithubActions/sanitize-item/database-name': 'sanitize-dbname-value\n',
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
    out(`${JSON.stringify(item ?? { title: 'unknown', fields: [] })}\n`)
    process.exit(0)
  }

  if (path.includes('Does-Not-Exist')) {
    fail("Error: Could not find item by name 'Does-Not-Exist'")
  }
  out(FIELD_VALUES[path] ?? 'mock-secret-value\n')
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
  case 'login':
    if (process.env.MOCK_PASS_CLI_FAIL_LOGIN === 'true') fail('Login failed (mock)')
    out('Login successful (mock)\n')
    process.exit(0)
    break
  case 'info':
    if (process.env.MOCK_PASS_CLI_FAIL_INFO === 'true') fail('No active session (mock)')
    out('Personal Access Token: github-actions (mock)\n')
    process.exit(0)
    break
  case 'logout':
    out('Logged out (mock)\n')
    process.exit(0)
    break
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
