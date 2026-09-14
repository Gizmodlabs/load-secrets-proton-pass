import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { runActionLifecycle } from '../helpers/run-action.ts'

const URI = 'pass://GithubActions/load-secrets-proton-pass-test/Password'

for (const [name, mockEnv, exitCode, commands] of [
  ['success', {}, 0, ['info', 'login', 'info', 'logout']],
  ['login failure', { MOCK_PASS_CLI_FAIL_LOGIN: 'true' }, 1, ['info', 'login', 'logout']],
  ['probe failure', { MOCK_PASS_CLI_FAIL_INFO: 'true' }, 1, ['info', 'login', 'info', 'logout']],
  ['logout failure', { MOCK_PASS_CLI_FAIL_LOGOUT: 'true' }, 0, ['info', 'login', 'info', 'logout']],
] as const) {
  test(`main and post clean the same session after ${name}`, async t => {
    const result = await runActionLifecycle(t, { env: { DB_PASSWORD: URI }, mockEnv })
    assert.equal(result.main.exitCode, exitCode, result.main.stdout)
    assert.equal(result.main.state['session-dir'], result.sessionDir)
    assert.equal(result.main.env['PROTON_PASS_SESSION_DIR'], result.sessionDir)
    assert.ok(result.sessionDirExistedAfterMain)
    assert.equal(result.post.exitCode, 0, result.post.stdout)
    assert.ok(!existsSync(result.sessionDir), 'post removed the directory before test teardown')
    assert.deepEqual(result.authCalls, commands.map(command => `${command}\tfs\t${result.sessionDir}`))
    if (exitCode === 0) assert.equal(result.main.output['DB_PASSWORD'], 'mock-real-password')
    else assert.ok(!('DB_PASSWORD' in result.main.output))
    if (name === 'logout failure') assert.match(result.post.stdout, /::warning::pass-cli logout exited with code 1/)
  })
}

test('post succeeds without session state when main rejects a missing PAT', async t => {
  const result = await runActionLifecycle(t, { inputs: { 'personal-access-token': '' } })
  assert.equal(result.main.exitCode, 1)
  assert.match(result.main.stdout, /No Proton Pass token/)
  assert.deepEqual(result.main.state, {})
  assert.equal(result.sessionDirExistedAfterMain, false)
  assert.equal(result.post.exitCode, 0)
  assert.ok(!existsSync(result.sessionDir))
})
