import { getExecOutput } from '@actions/exec'

export interface CliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type CliRunner = (args: string[], extraEnv?: Record<string, string>) => Promise<CliResult>

function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Run pass-cli capturing stdout/stderr without echoing either to the job log
 * (stdout may be secret material). Callers pass `--` before positional URIs
 * so a crafted value can never be parsed as a flag. Non-zero exit codes are
 * returned, not thrown — callers decide how to report.
 */
export const runPassCli: CliRunner = async (args, extraEnv) => {
  const result = await getExecOutput('pass-cli', args, {
    silent: true,
    ignoreReturnCode: true,
    env: { ...currentEnv(), ...extraEnv },
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

/** Collapse captured stderr to a single log-safe line. */
export function stderrDetail(result: CliResult): string {
  return result.stderr.replaceAll('\n', ' ').trim()
}
