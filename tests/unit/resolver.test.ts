import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSecrets } from '../../src/resolver/resolver.ts'
import { findSecretRefs } from '../../src/resolver/env-scan.ts'
import { formatFailure } from '../../src/domain/resolution.ts'
import type { CliResult, CliRunner } from '../../src/pass-cli.ts'
import { loginItem, customItem } from '../fixtures/item-json.mjs'

interface CannedResponse {
  match: (args: string[]) => boolean
  result: Partial<CliResult>
}

function cannedRunner(responses: CannedResponse[]) {
  const calls: string[][] = []
  const runner: CliRunner = async args => {
    calls.push(args)
    const canned = responses.find(response => response.match(args))
    return {
      exitCode: canned?.result.exitCode ?? 0,
      stdout: canned?.result.stdout ?? '',
      stderr: canned?.result.stderr ?? '',
    }
  }
  return { runner, calls }
}

function collectAnnotations() {
  const lines: string[] = []
  return { annotate: (message: string) => lines.push(message), lines }
}

const refsFor = (env: Record<string, string>) => findSecretRefs(env)

test('findSecretRefs picks up only full pass:// URIs', () => {
  const refs = refsFor({
    DB_PASSWORD: 'pass://Vault/Item/password',
    NORMAL_VAR: 'hello',
    TWO_SEGMENTS: 'pass://Vault/Item',
  })
  assert.deepEqual(
    refs.map(ref => ref.name),
    ['DB_PASSWORD'],
  )
})

test('literal value is stdout minus exactly one trailing newline — no other trimming', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Vault/Item/key'),
      result: { stdout: 'line one\nline two\n' },
    },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ KEY: 'pass://Vault/Item/key' }), { annotate, runner })
  assert.equal(report.resolved[0]?.value, 'line one\nline two')
  assert.equal(report.failures.length, 0)
})

test('only one trailing newline is removed — a stored trailing newline (PEM) survives', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Vault/Item/key'),
      result: { stdout: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n\n' },
    },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ KEY: 'pass://Vault/Item/key' }), { annotate, runner })
  assert.equal(report.resolved[0]?.value, '-----BEGIN KEY-----\nabc\n-----END KEY-----\n')
})

test('stdout without a trailing newline is passed through unchanged', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Vault/Item/key'),
      result: { stdout: '  padded value ' },
    },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ KEY: 'pass://Vault/Item/key' }), { annotate, runner })
  assert.equal(report.resolved[0]?.value, '  padded value ')
})

test('literal invocations use the -- argument separator before the URI', async () => {
  const { runner, calls } = cannedRunner([])
  const { annotate } = collectAnnotations()
  await resolveSecrets(refsFor({ KEY: 'pass://Vault/Item/key' }), { annotate, runner })
  assert.deepEqual(calls[0], ['item', 'view', '--', 'pass://Vault/Item/key'])
})

test('literal failure records name, uri, and stderr detail — never a value', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Prod/Does-Not-Exist/x'),
      result: { exitCode: 1, stderr: "Error: Could not find item by name 'Does-Not-Exist'" },
    },
  ])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ BOGUS: 'pass://Prod/Does-Not-Exist/x' }), {
    annotate,
    runner,
  })
  assert.equal(report.resolved.length, 0)
  const failure = report.failures[0]
  assert.ok(failure)
  assert.match(formatFailure(failure), /^BOGUS -> pass:\/\/Prod\/Does-Not-Exist\/x \(.*Does-Not-Exist.*\)$/)
  assert.ok(lines.some(line => line.includes('Failed to resolve secret for BOGUS')))
  assert.ok(lines.some(line => line.includes("item 'Does-Not-Exist' was not found")), 'hint emitted')
})

test('field glob expands to sanitized suffixed names', async () => {
  const itemJson = JSON.stringify(loginItem('multi', { custom: ['host', 'API Key'] }))
  const { runner, calls } = cannedRunner([
    { match: args => args.includes('json'), result: { stdout: itemJson } },
    { match: args => args.includes('pass://Vault/Item/host'), result: { stdout: 'db.example.com' } },
    { match: args => args.includes('pass://Vault/Item/API Key'), result: { stdout: 'k-value' } },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ DB: 'pass://Vault/Item/*' }), { annotate, runner })
  assert.deepEqual(
    report.resolved.map(secret => secret.name).sort(),
    ['DB_API_KEY', 'DB_HOST'],
  )
  assert.deepEqual(calls[0], ['item', 'view', '--output', 'json', '--', 'pass://Vault/Item'])
})

test('glob with zero fields fails with "matched zero fields"', async () => {
  const { runner } = cannedRunner([
    { match: args => args.includes('json'), result: { stdout: JSON.stringify(loginItem('empty')) } },
  ])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ EMPTY: 'pass://Vault/empty-item/*' }), {
    annotate,
    runner,
  })
  assert.equal(report.failures[0]?.detail, 'matched zero fields')
  assert.ok(lines.some(line => line.includes('matched zero fields')))
})

test('suffix collision fails listing both raw field names', async () => {
  const itemJson = JSON.stringify(loginItem('collision', { custom: ['api-key', 'api_key'] }))
  const { runner } = cannedRunner([{ match: args => args.includes('json'), result: { stdout: itemJson } }])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ X: 'pass://Vault/collision-item/*' }), {
    annotate,
    runner,
  })
  assert.equal(report.failures[0]?.detail, 'field-name collision')
  assert.equal(report.resolved.length, 0)
  const collisionLine = lines.find(line => line.includes('X_API_KEY'))
  assert.ok(collisionLine)
  assert.ok(collisionLine.includes('api-key') && collisionLine.includes('api_key'))
})

test('field sanitizing to an empty suffix fails the glob', async () => {
  const itemJson = JSON.stringify(loginItem('bad-suffix', { custom: ['---'] }))
  const { runner } = cannedRunner([{ match: args => args.includes('json'), result: { stdout: itemJson } }])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ BAD: 'pass://Vault/bad-suffix-item/*' }), {
    annotate,
    runner,
  })
  assert.match(report.failures[0]?.detail ?? '', /sanitizes to an empty suffix/)
  assert.ok(lines.some(line => line.includes('sanitizes to an empty suffix')))
})

test('vault/item wildcards are rejected without calling pass-cli', async () => {
  const { runner, calls } = cannedRunner([])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(
    refsFor({ BAD_ITEM: 'pass://Vault/*/password', BAD_VAULT: 'pass://*/item/password' }),
    { annotate, runner },
  )
  assert.equal(report.failures.length, 2)
  assert.equal(calls.length, 0)
  assert.ok(lines.some(line => line.includes('only supported in the field segment')))
})

test('partial field wildcard is rejected', async () => {
  const { runner } = cannedRunner([])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ BAD: 'pass://Vault/Item/pass*' }), { annotate, runner })
  assert.equal(report.failures[0]?.detail, 'partial wildcards not supported')
  assert.ok(lines.some(line => line.includes('Partial wildcards are not supported')))
})

test('one failing secret does not stop later ones from resolving', async () => {
  const { runner } = cannedRunner([
    {
      match: args => args.includes('pass://Prod/Does-Not-Exist/x'),
      result: { exitCode: 1, stderr: 'nope' },
    },
    { match: args => args.includes('pass://Vault/Item/good'), result: { stdout: 'good-value' } },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(
    refsFor({ BOGUS: 'pass://Prod/Does-Not-Exist/x', GOOD: 'pass://Vault/Item/good' }),
    { annotate, runner },
  )
  assert.equal(report.resolved.length, 1)
  assert.equal(report.failures.length, 1)
})

// Verbatim structural copy of `pass-cli item view --output json` output
// (pass-cli 2.1.0, live vault), values replaced. The glob parsed an invented
// `{fields:[{name}]}` shape for the whole 1.1.0 cycle, so every offline test
// passed while the feature matched zero fields against the real CLI.
const REAL_LOGIN_OUTPUT = JSON.stringify({
  item: {
    id: 'i', share_id: 's', vault_id: 'v',
    content: {
      title: 'load-secrets-proton-pass-test',
      note: 'a note',
      item_uuid: 'u',
      content: {
        Login: {
          email: 'user@example.com',
          username: 'someone',
          password: '',
          urls: [],
          totp_uri: '',
          passkeys: [],
        },
      },
      extra_fields: [{ name: 'Custom Thing', content: { Text: 'cv' } }],
    },
    state: 'Active', flags: [], create_time: 't', modify_time: 't',
  },
  attachments: [],
})

test('glob expands the real pass-cli envelope, skipping unaddressable fields', async () => {
  const { runner } = cannedRunner([
    { match: args => args.includes('json'), result: { stdout: REAL_LOGIN_OUTPUT } },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ ALL: 'pass://Vault/Item/*' }), { annotate, runner })

  // email and username hold values; password and totp_uri are unset and
  // answer "Field does not exist", and urls/passkeys are arrays. title and
  // note are item metadata, not secrets.
  assert.deepEqual(
    report.resolved.map(secret => secret.name).sort(),
    ['ALL_CUSTOM_THING', 'ALL_EMAIL', 'ALL_USERNAME'],
  )
  assert.deepEqual(report.failures, [])
})

test('glob qualifies custom-item section fields with their section name', async () => {
  const itemJson = JSON.stringify(customItem('sectioned', ['section-host', 'section-token']))
  const { runner } = cannedRunner([
    { match: args => args.includes('json'), result: { stdout: itemJson } },
  ])
  const { annotate } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ S: 'pass://Vault/Item/*' }), { annotate, runner })
  assert.deepEqual(
    report.resolved.map(secret => secret.name).sort(),
    ['S_SECTION_1_SECTION_HOST', 'S_SECTION_1_SECTION_TOKEN'],
  )
})

test('an unrecognized item envelope fails loudly instead of expanding to nothing', async () => {
  const { runner } = cannedRunner([
    { match: args => args.includes('json'), result: { stdout: '{"title":"x","fields":[{"name":"host"}]}' } },
  ])
  const { annotate, lines } = collectAnnotations()
  const report = await resolveSecrets(refsFor({ X: 'pass://Vault/Item/*' }), { annotate, runner })
  assert.equal(report.failures[0]?.detail, 'unexpected item JSON from pass-cli')
  assert.ok(lines.some(line => line.includes('Unexpected JSON from pass-cli')))
})

// item.content.content is an externally tagged union, one variant per item
// type. Note and Alias are unit structs and serialize as a bare null, so the
// walk has to tolerate a variant that is not an object at all.
const variantItem = (content: unknown) =>
  JSON.stringify({ item: { content: { title: 't', note: 'n', content, extra_fields: [] } }, attachments: [] })

const globNames = async (stdout: string) => {
  const runner: CliRunner = async args => ({
    exitCode: 0,
    stdout: args.includes('json') ? stdout : 'v',
    stderr: '',
  })
  const report = await resolveSecrets(refsFor({ K: 'pass://V/I/*' }), { annotate: () => {}, runner })
  return { names: report.resolved.map(s => s.name.replace(/^K_/, '')).sort(), report }
}

test('unit-struct item variants expand to nothing instead of throwing', async () => {
  for (const content of [{ Note: null }, { Alias: null }]) {
    const { names, report } = await globNames(variantItem(content))
    assert.deepEqual(names, [])
    assert.equal(report.failures[0]?.detail, 'matched zero fields')
  }
})

test('non-Login item variants expand their own scalar fields', async () => {
  const card = await globNames(
    variantItem({ CreditCard: { cardholder_name: 'A B', number: '4111', pin: '', card_type: 'Visa' } }),
  )
  assert.deepEqual(card.names, ['CARDHOLDER_NAME', 'CARD_TYPE', 'NUMBER'])

  const wifi = await globNames(variantItem({ Wifi: { ssid: 'net', password: 'pw', security: 'WPA2', sections: [] } }))
  assert.deepEqual(wifi.names, ['PASSWORD', 'SECURITY', 'SSID'])
})

test('section-bearing variants expand scalars and section fields together', async () => {
  const { names } = await globNames(
    variantItem({
      SshKey: {
        private_key: 'pk',
        public_key: '',
        sections: [{ section_name: 'S', section_fields: [{ name: 'ssh-note', content: { Text: 'v' } }] }],
      },
    }),
  )
  assert.deepEqual(names, ['PRIVATE_KEY', 'S_SSH_NOTE'])
})

test('a string array is one field under its own key, and only when non-empty', async () => {
  // pass-cli registers Login.urls as a single field joined with ", ", but skips
  // it when the list is empty. passkeys is a list of objects and is never a field.
  const withUrls = await globNames(
    variantItem({
      Login: {
        email: 'e',
        password: 'p',
        urls: ['https://a', 'https://b'],
        passkeys: [{ key_id: 'k', content: [1, 2, 3], user_name: 'u', note: 'n' }],
      },
    }),
  )
  assert.deepEqual(withUrls.names, ['EMAIL', 'PASSWORD', 'URLS'])

  const noUrls = await globNames(variantItem({ Login: { email: 'e', urls: [], passkeys: [] } }))
  assert.deepEqual(noUrls.names, ['EMAIL'])
})

test('identity extra-detail lists expand unqualified, extra_sections qualified', async () => {
  const { names } = await globNames(
    variantItem({
      Identity: {
        full_name: 'X',
        email: '',
        extra_personal_details: [{ name: 'Nickname', content: { Text: 'v' } }],
        extra_work_details: [{ name: 'Desk', content: { Hidden: 'v' } }],
        extra_sections: [{ section_name: 'Sec', section_fields: [{ name: 'Deep', content: { Text: 'v' } }] }],
      },
    }),
  )
  assert.deepEqual(names, ['DESK', 'FULL_NAME', 'NICKNAME', 'SEC_DEEP'])
})

test('two sections sharing a field name stay distinct instead of colliding', async () => {
  // An unqualified lookup returns the first match across sections, so both
  // fields would otherwise collapse onto one value.
  const { names, report } = await globNames(
    variantItem({
      Custom: {
        sections: [
          { section_name: 'Alpha', section_fields: [{ name: 'shared', content: { Text: 'a' } }] },
          { section_name: 'Beta', section_fields: [{ name: 'shared', content: { Text: 'b' } }] },
        ],
      },
    }),
  )
  assert.deepEqual(names, ['ALPHA_SHARED', 'BETA_SHARED'])
  assert.deepEqual(report.failures, [])
})
