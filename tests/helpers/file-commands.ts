import { readFileSync } from 'node:fs'

/**
 * Parse a GitHub Actions file command ($GITHUB_ENV / $GITHUB_OUTPUT) into a
 * name -> value map. Supports both the simple `key=value` form and the
 * heredoc form `key<<DELIM ... DELIM` that @actions/core emits. Values are
 * extracted byte-exact (heredoc delimiters exchange exactly one EOL on each
 * side of the value).
 */
export function parseFileCommands(content: string): Record<string, string> {
  const entries: Record<string, string> = {}
  let rest = content
  while (rest.length > 0) {
    const lineEnd = rest.search(/\r?\n/)
    const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd)
    const afterLine = lineEnd === -1 ? '' : rest.slice(lineEnd).replace(/^\r?\n/, '')

    const heredoc = /^(.+?)<<(.+)$/.exec(line)
    if (heredoc) {
      const [, key, delimiter] = heredoc
      if (key === undefined || delimiter === undefined) throw new Error('unreachable')
      const terminator = new RegExp(`\\r?\\n${escapeRegExp(delimiter)}(\\r?\\n|$)`)
      const match = terminator.exec(afterLine)
      if (!match) throw new Error(`Unterminated heredoc for key "${key}"`)
      entries[key] = afterLine.slice(0, match.index)
      rest = afterLine.slice(match.index + match[0].length)
      continue
    }

    const simple = /^([^=]+)=(.*)$/.exec(line)
    if (simple) {
      const [, key, value] = simple
      if (key !== undefined && value !== undefined) entries[key] = value
    }
    rest = afterLine
  }
  return entries
}

export function readFileCommands(filePath: string): Record<string, string> {
  return parseFileCommands(readFileSync(filePath, 'utf8'))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
