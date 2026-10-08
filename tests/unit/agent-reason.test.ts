import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_REASON_ENV_VAR,
  MAX_AGENT_REASON_LENGTH,
  agentReasonContext,
  agentReasonEnv,
  describeRun,
  formatAgentReason,
} from '../../src/domain/agent-reason.ts'

const RUN_ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/api',
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW: 'Deploy',
  GITHUB_RUN_NUMBER: '42',
  GITHUB_REF_NAME: 'main',
  GITHUB_ACTOR: 'octocat',
}

test('describes the run with its attempt URL first, then workflow, ref and actor', () => {
  assert.equal(
    describeRun(RUN_ENV),
    'GitHub Actions run https://github.com/acme/api/actions/runs/123456789/attempts/2 ' +
      '(workflow "Deploy" #42, ref main, actor octocat)',
  )
})

test('uses the GitHub Enterprise server URL when the runner reports one', () => {
  const description = describeRun({ ...RUN_ENV, GITHUB_SERVER_URL: 'https://ghe.example.com' })
  assert.match(description, /^GitHub Actions run https:\/\/ghe\.example\.com\/acme\/api\//)
})

test('degrades to whatever context exists outside a full Actions run', () => {
  assert.equal(describeRun({}), 'GitHub Actions run')
  assert.equal(describeRun({ GITHUB_WORKFLOW: 'CI' }), 'GitHub Actions run (workflow "CI")')
  assert.equal(
    describeRun({ GITHUB_REPOSITORY: 'acme/api', GITHUB_RUN_ID: '7' }),
    'GitHub Actions run https://github.com/acme/api/actions/runs/7',
  )
})

test('context precedence: agent-reason input, then a reason the step already sets, then the run', () => {
  const env = { ...RUN_ENV, [AGENT_REASON_ENV_VAR]: 'From the step env' }
  assert.equal(agentReasonContext('Nightly deploy', env), 'Nightly deploy')
  assert.equal(agentReasonContext('', env), 'From the step env')
  assert.equal(agentReasonContext('   ', { ...env, [AGENT_REASON_ENV_VAR]: ' \t' }), describeRun(RUN_ENV))
})

test('a reason names what the read loads, then the run context', () => {
  assert.equal(formatAgentReason('load DB_PASSWORD', 'Nightly deploy'), 'load DB_PASSWORD: Nightly deploy')
})

test('an overlong reason is cut to the pass-cli limit, counting characters the way Rust does', () => {
  // Each emoji is one Rust char but two UTF-16 code units.
  const reason = formatAgentReason('load DB_PASSWORD', '🔑'.repeat(400))
  const chars = Array.from(reason)
  assert.equal(chars.length, MAX_AGENT_REASON_LENGTH)
  assert.ok(reason.startsWith('load DB_PASSWORD: 🔑'))
  assert.equal(chars.at(-1), '…')
  assert.ok(!reason.includes('�'), 'never splits a surrogate pair')
})

test('a reason at exactly the limit is kept whole', () => {
  const context = 'x'.repeat(MAX_AGENT_REASON_LENGTH - 'load A: '.length)
  assert.equal(formatAgentReason('load A', context).length, MAX_AGENT_REASON_LENGTH)
  assert.ok(!formatAgentReason('load A', context).endsWith('…'))
})

test('agentReasonEnv sets the pass-cli variable, or nothing when no context is configured', () => {
  assert.deepEqual(agentReasonEnv('Nightly deploy', 'load KEY'), { [AGENT_REASON_ENV_VAR]: 'load KEY: Nightly deploy' })
  assert.equal(agentReasonEnv(undefined, 'load KEY'), undefined)
})
