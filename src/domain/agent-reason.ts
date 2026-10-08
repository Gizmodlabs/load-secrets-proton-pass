/**
 * Audit reason for item reads made with a Proton Pass agent token
 * (`pass-cli agent create`). pass-cli reads it from this env var on
 * `item view` and `inject`, stores it end-to-end encrypted in the agent's
 * audit log (`pass-cli agent monitor`), and refuses the read when it is
 * missing, blank, or longer than the limit. For plain personal access tokens
 * it is never read or sent (`agent_monitor.rs`), so the action sets it on
 * every read without knowing which kind of token it was given.
 */
export const AGENT_REASON_ENV_VAR = 'PROTON_PASS_AGENT_REASON'

/** pass-cli's `MAX_REASON_LENGTH`, counted in Unicode scalar values like Rust's `chars()`. */
export const MAX_AGENT_REASON_LENGTH = 300

/**
 * The part of every reason that says why this run reads secrets: the
 * `agent-reason` input, else a `PROTON_PASS_AGENT_REASON` the step already
 * sets, else a description of the workflow run.
 */
export function agentReasonContext(input: string, env: NodeJS.ProcessEnv): string {
  return input.trim() || env[AGENT_REASON_ENV_VAR]?.trim() || describeRun(env)
}

/**
 * The run's URL comes first: it names the repository and the exact attempt,
 * links straight to the logs, and is the part a truncated reason keeps.
 */
export function describeRun(env: NodeJS.ProcessEnv): string {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = env
  const server = env.GITHUB_SERVER_URL || 'https://github.com'
  const url = repo && runId ? `${server}/${repo}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ''}` : ''

  const workflow = env.GITHUB_WORKFLOW
  const details = [
    workflow ? `workflow "${workflow}"${env.GITHUB_RUN_NUMBER ? ` #${env.GITHUB_RUN_NUMBER}` : ''}` : '',
    env.GITHUB_REF_NAME ? `ref ${env.GITHUB_REF_NAME}` : '',
    env.GITHUB_ACTOR ? `actor ${env.GITHUB_ACTOR}` : '',
  ].filter(Boolean)

  const run = url ? `GitHub Actions run ${url}` : 'GitHub Actions run'
  return details.length > 0 ? `${run} (${details.join(', ')})` : run
}

/**
 * One read's reason: what it loads, then the run context. Cut to pass-cli's
 * limit from the end, so the purpose and the run URL survive.
 */
export function formatAgentReason(purpose: string, context: string): string {
  const reason = Array.from(`${purpose}: ${context}`)
  if (reason.length <= MAX_AGENT_REASON_LENGTH) return reason.join('')
  return `${reason.slice(0, MAX_AGENT_REASON_LENGTH - 1).join('')}…`
}

/** Extra env for one pass-cli read; none when no context was configured (unit tests). */
export function agentReasonEnv(context: string | undefined, purpose: string): Record<string, string> | undefined {
  return context === undefined ? undefined : { [AGENT_REASON_ENV_VAR]: formatAgentReason(purpose, context) }
}
