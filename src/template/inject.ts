import { readFileSync } from 'node:fs'
import * as core from '@actions/core'
import { runPassCli, stderrDetail, type CliRunner } from '../pass-cli.ts'
import { maskValue } from '../export/exporter.ts'

/**
 * The placeholder pattern pass-cli itself matches (`compile_pass_uri_regex`
 * in pass-cli's inject.rs): `{{`, optional whitespace, a pass:// URI running
 * to the first `}`, optional whitespace, `}}`.
 */
const PLACEHOLDER = /\{\{\s*pass:\/\/[^}]+\s*\}\}/g

export interface TemplateOptions {
  readonly templatePath: string
  /** Explicit output path; empty string means derive from the template name. */
  readonly outputPathInput: string
  readonly maskValues: boolean
  readonly runner?: CliRunner
}

/**
 * Render an env-file template containing `{{ pass://vault/item/field }}`
 * placeholders via `pass-cli inject`. Throws on any failure — template
 * errors are hard errors regardless of strict mode. Returns the output path.
 */
export async function injectTemplate(options: TemplateOptions): Promise<string> {
  const { templatePath, maskValues } = options
  // Read before rendering: masking compares against the template, and an
  // in-place render (output-path == env-template) replaces the file.
  const template = readTemplate(templatePath)

  const outputPath = deriveOutputPath(templatePath, options.outputPathInput)
  core.info(`Injecting secrets into template: ${templatePath} -> ${outputPath}`)

  const runner = options.runner ?? runPassCli
  // --force: pass-cli refuses to replace an existing output file without it,
  // so re-rendering (a second run, a persistent self-hosted workspace, an
  // explicit output-path) would otherwise fail.
  const result = await runner(['inject', '--force', '-i', templatePath, '-o', outputPath])
  if (result.exitCode !== 0) {
    const detail = stderrDetail(result)
    throw new Error(`Failed to inject secrets into template ${templatePath}: ${detail}`)
  }

  if (maskValues) maskInjectedValues(template, readFileSync(outputPath, 'utf8'), outputPath)
  core.info(`Template injection complete: ${outputPath}`)
  return outputPath
}

function readTemplate(templatePath: string): string {
  try {
    return readFileSync(templatePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Template file not found: ${templatePath}`)
    }
    throw new Error(`Could not read template file ${templatePath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Explicit override > strip `.template` > strip `.tpl` > append `.resolved`. */
export function deriveOutputPath(templatePath: string, outputPathInput: string): string {
  if (outputPathInput) return outputPathInput
  if (templatePath.endsWith('.template')) return templatePath.slice(0, -'.template'.length)
  if (templatePath.endsWith('.tpl')) return templatePath.slice(0, -'.tpl'.length)
  return `${templatePath}.resolved`
}

/**
 * The values pass-cli substituted, recovered by walking the rendered output
 * against the literal text between placeholders. pass-cli copies that text
 * verbatim, so each value is whatever sits between one literal and the next.
 * Adjacent placeholders share one span and are returned as one value.
 *
 * Returns null when the output does not line up with the template. The walk
 * takes the first occurrence of each following literal, so a secret that
 * itself contains that literal text splits early; that is the one case it
 * cannot recover exactly.
 */
export function injectedValues(template: string, rendered: string): string[] | null {
  const literals = template.split(PLACEHOLDER)
  const head = literals[0] ?? ''
  if (!rendered.startsWith(head)) return null

  const values: string[] = []
  let cursor = head.length
  for (let index = 1; index < literals.length; index += 1) {
    const literal = literals[index] ?? ''
    const isLast = index === literals.length - 1
    if (literal === '' && !isLast) continue

    let end: number
    if (isLast) {
      end = rendered.length - literal.length
      if (end < cursor || !rendered.endsWith(literal)) return null
    } else {
      end = rendered.indexOf(literal, cursor)
      if (end === -1) return null
    }
    values.push(rendered.slice(cursor, end))
    cursor = end + literal.length
  }
  return cursor === rendered.length ? values : null
}

/**
 * Mask exactly the substituted values (whole and per line, like env-var
 * secrets), so quoted values, YAML keys and several placeholders on one line
 * are all covered. When the output cannot be matched back to the template,
 * fall back to masking the value part of every `KEY=` line that held a
 * placeholder, and say so.
 */
function maskInjectedValues(template: string, rendered: string, outputPath: string): void {
  const values = injectedValues(template, rendered)
  if (values !== null) {
    for (const value of values) maskValue(value)
    return
  }

  core.warning(
    `Could not match ${outputPath} back to its template, so only whole KEY=value lines that held ` +
      'a pass:// placeholder are masked. Values printed on their own may not be redacted.',
  )
  const outputLines = rendered.split('\n')
  for (const templateLine of template.split('\n')) {
    if (!templateLine.includes('pass://')) continue
    const key = templateLine.split('=', 1)[0]
    if (!key) continue
    const line = outputLines.find(candidate => candidate.startsWith(`${key}=`))
    if (line) maskValue(line.slice(key.length + 1))
  }
}
