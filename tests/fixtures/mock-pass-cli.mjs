#!/usr/bin/env node
// Mock pass-cli for offline testing. Deterministic values per URI, mirroring
// tests/mock-pass-cli.sh from the bash version, plus a multiline PEM item.
// Like the real CLI, `item view` prints the stored value followed by one newline.
// Understands the `--` argument separator the action now always passes.
import { readFileSync, writeFileSync } from 'node:fs'
import { PEM_KEY } from './pem-fixture.mjs'
import { loginItem, customItem } from './item-json.mjs'

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
  // Mirrors the real vault item the e2e reads: built-in Login scalars, no custom fields.
  'GithubActions/load-secrets-proton-pass-test': loginItem('load-secrets-proton-pass-test', {
    builtins: { email: 'mock@example.com', username: 'mockuser', password: 'mock-real-password' },
  }),
  'GithubActions/multi-field-item': loginItem('multi-field-item', {
    custom: ['host', 'port', 'password'],
  }),
  'GithubActions/empty-item': loginItem('empty-item'),
  'GithubActions/collision-item': loginItem('collision-item', { custom: ['api-key', 'api_key'] }),
  'GithubActions/sanitize-item': loginItem('sanitize-item', { custom: ['API Key', 'database-name'] }),
  'GithubActions/bad-suffix-item': loginItem('bad-suffix-item', { custom: ['---'] }),
  // Custom items carry fields under sections rather than extra_fields.
  'GithubActions/sectioned-item': customItem('sectioned-item', ['section-host', 'section-token']),
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
    out(`${JSON.stringify(item ?? loginItem('unknown'))}\n`)
    process.exit(0)
  }

  if (path.includes('Does-Not-Exist')) {
    fail("Error: Could not find item by name 'Does-Not-Exist'")
  }
  // Real pass-cli prints the stored value with println!: value + exactly one newline.
  out(`${FIELD_VALUES[path] ?? 'mock-secret-value'}\n`)
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
    if (process.env.MOCK_PASS_CLI_LOGOUT_SESSION_FILE) {
      writeFileSync(process.env.MOCK_PASS_CLI_LOGOUT_SESSION_FILE, process.env.PROTON_PASS_SESSION_DIR ?? '')
    }
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
