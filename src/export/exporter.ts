import * as core from '@actions/core'
import type { ResolvedSecret } from '../domain/resolution.ts'

export interface ExportOptions {
  readonly maskValues: boolean
  readonly exportEnv: boolean
}

/**
 * Export resolved secrets: mask first, then emit. Values go through
 * core.setOutput / core.exportVariable exclusively — both speak the
 * heredoc-delimiter file-command protocol, so multiline values (SSH keys,
 * PEM certs) survive byte-exact. Never append raw key=value lines to
 * $GITHUB_OUTPUT or $GITHUB_ENV.
 */
export function exportSecrets(resolved: ResolvedSecret[], options: ExportOptions): void {
  for (const secret of resolved) {
    if (options.maskValues) maskValue(secret.value)
    core.setOutput(secret.name, secret.value)
    if (options.exportEnv) core.exportVariable(secret.name, secret.value)
  }
}

/**
 * Register a value with the log masker. The whole value is masked, and each
 * non-empty line is masked individually so every line of a multiline secret
 * is redacted even when tools print lines in isolation.
 */
function maskValue(value: string): void {
  if (value.length === 0) return
  core.setSecret(value)
  for (const line of value.split('\n')) {
    const trimmedLine = line.replace(/\r$/, '')
    if (trimmedLine.length > 0 && trimmedLine !== value) core.setSecret(trimmedLine)
  }
}

/** Sorted, comma-separated resolved names. Names only — never values. */
export function resolvedKeysCsv(resolved: ResolvedSecret[]): string {
  return resolved
    .map(secret => secret.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .join(',')
}
