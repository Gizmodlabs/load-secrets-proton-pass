import { existsSync, readFileSync } from 'node:fs'
import * as core from '@actions/core'
import { runPassCli, stderrDetail, type CliRunner } from '../pass-cli.ts'

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
  if (!existsSync(templatePath)) {
    throw new Error(`Template file not found: ${templatePath}`)
  }

  const outputPath = deriveOutputPath(templatePath, options.outputPathInput)
  core.info(`Injecting secrets into template: ${templatePath} -> ${outputPath}`)

  const runner = options.runner ?? runPassCli
  const result = await runner(['inject', '-i', templatePath, '-o', outputPath])
  if (result.exitCode !== 0) {
    const detail = stderrDetail(result)
    throw new Error(`Failed to inject secrets into template ${templatePath}: ${detail}`)
  }

  if (maskValues) maskInjectedValues(templatePath, outputPath)
  core.info(`Template injection complete: ${outputPath}`)
  return outputPath
}

/** Explicit override > strip `.template` > strip `.tpl` > append `.resolved`. */
export function deriveOutputPath(templatePath: string, outputPathInput: string): string {
  if (outputPathInput) return outputPathInput
  if (templatePath.endsWith('.template')) return templatePath.slice(0, -'.template'.length)
  if (templatePath.endsWith('.tpl')) return templatePath.slice(0, -'.tpl'.length)
  return `${templatePath}.resolved`
}

/**
 * Mask only values that were actually injected: for each template line that
 * contained a pass:// placeholder, find the matching KEY= line in the
 * rendered output and register its value with the log masker.
 */
function maskInjectedValues(templatePath: string, outputPath: string): void {
  const templateLines = readFileSync(templatePath, 'utf8').split('\n')
  const outputLines = readFileSync(outputPath, 'utf8').split('\n')

  for (const templateLine of templateLines) {
    if (!templateLine.includes('pass://')) continue
    const key = templateLine.split('=', 1)[0]
    if (!key) continue
    const rendered = outputLines.find(line => line.startsWith(`${key}=`))
    if (!rendered) continue
    const value = rendered.slice(key.length + 1)
    if (value.length > 0) core.setSecret(value)
  }
}
