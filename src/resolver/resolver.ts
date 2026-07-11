import * as core from '@actions/core'
import { runPassCli, stderrDetail, type CliRunner } from '../pass-cli.ts'
import { sanitizeSuffix } from './sanitize.ts'
import { troubleshootingHints } from '../hints.ts'
import type { SecretRef } from './env-scan.ts'
import type { PassUri } from '../domain/pass-uri.ts'
import type { ResolutionReport, ResolvedSecret, ResolutionFailure } from '../domain/resolution.ts'

export interface ResolverOptions {
  /** Emits one failure-annotation line (core.error in strict mode, core.warning otherwise). */
  readonly annotate: (message: string) => void
  readonly runner?: CliRunner
}

interface ResolverContext {
  readonly annotate: (message: string) => void
  readonly runner: CliRunner
  readonly resolved: ResolvedSecret[]
  readonly failures: ResolutionFailure[]
}

/**
 * Resolve every scanned pass:// reference. Never throws on a per-secret
 * failure — failures accumulate in the report and the caller decides
 * (strict mode) whether they fail the step. Values are captured byte-exact
 * from pass-cli stdout: no trimming, ever.
 */
export async function resolveSecrets(
  refs: SecretRef[],
  options: ResolverOptions,
): Promise<ResolutionReport> {
  const context: ResolverContext = {
    annotate: options.annotate,
    runner: options.runner ?? runPassCli,
    resolved: [],
    failures: [],
  }

  for (const ref of refs) {
    core.startGroup(`Resolving ${ref.name}`)
    core.info(`  URI: ${ref.uri.raw}`)
    await resolveOne(ref, context)
    core.endGroup()
  }

  return { resolved: context.resolved, failures: context.failures }
}

async function resolveOne(ref: SecretRef, context: ResolverContext): Promise<void> {
  switch (ref.uri.kind) {
    case 'invalid-vault-item-wildcard':
      context.annotate(`Wildcards are only supported in the field segment. Got '${ref.uri.raw}'.`)
      context.annotate('  Supported form: pass://Vault/Item/*')
      context.failures.push({
        name: ref.name,
        uri: ref.uri.raw,
        detail: 'wildcards only supported in the field segment',
      })
      return
    case 'invalid-partial-field-wildcard':
      context.annotate(`Partial wildcards are not supported in the field segment. Got '${ref.uri.raw}'.`)
      context.annotate('  Use pass://Vault/Item/* to load every field, or an exact field name.')
      context.failures.push({
        name: ref.name,
        uri: ref.uri.raw,
        detail: 'partial wildcards not supported',
      })
      return
    case 'field-glob':
      await resolveFieldGlob(ref.name, ref.uri, context)
      return
    case 'literal':
      await resolveLiteral(ref.name, ref.uri.raw, ref.uri, context)
      return
  }
}

async function resolveLiteral(
  envKey: string,
  uri: string,
  parsed: Pick<PassUri, 'vault' | 'item' | 'field'>,
  context: ResolverContext,
): Promise<void> {
  core.info(`  Resolving ${uri} -> ${envKey}`)
  const result = await context.runner(['item', 'view', '--', uri])
  if (result.exitCode !== 0) {
    const detail = stderrDetail(result)
    context.annotate(`Failed to resolve secret for ${envKey} (${uri}): ${detail}`)
    for (const hint of troubleshootingHints(detail, parsed.vault, parsed.item, parsed.field)) {
      context.annotate(hint)
    }
    context.failures.push({ name: envKey, uri, detail })
    return
  }
  context.resolved.push({ name: envKey, uri, value: result.stdout })
}

async function resolveFieldGlob(envKey: string, uri: PassUri, context: ResolverContext): Promise<void> {
  const globUri = uri.raw
  const listing = await context.runner(['item', 'view', '--output', 'json', '--', uri.itemUri])
  if (listing.exitCode !== 0) {
    const detail = stderrDetail(listing)
    context.annotate(`Failed to list fields for ${uri.itemUri}: ${detail}`)
    context.failures.push({ name: envKey, uri: globUri, detail })
    return
  }

  const fieldNames = parseFieldNames(listing.stdout)
  if (fieldNames === null) {
    context.annotate(`Unexpected JSON from pass-cli while expanding ${globUri}`)
    context.failures.push({ name: envKey, uri: globUri, detail: 'unexpected item JSON from pass-cli' })
    return
  }
  if (fieldNames.length === 0) {
    context.annotate(`Glob ${globUri} matched zero fields on item '${uri.item}' in vault '${uri.vault}'`)
    context.failures.push({ name: envKey, uri: globUri, detail: 'matched zero fields' })
    return
  }

  const suffixes = sanitizeFields(envKey, uri, fieldNames, context)
  if (suffixes === null) return

  for (const [suffix, rawField] of suffixes) {
    const fieldUri = `pass://${uri.vault}/${uri.item}/${rawField}`
    await resolveLiteral(`${envKey}_${suffix}`, fieldUri, { vault: uri.vault, item: uri.item, field: rawField }, context)
  }
}

/**
 * Sanitize field names into env-var suffixes, failing the whole glob on an
 * empty suffix or when two raw names collide on the same suffix (both raw
 * names are listed so the user can rename one).
 */
function sanitizeFields(
  envKey: string,
  uri: PassUri,
  fieldNames: string[],
  context: ResolverContext,
): Array<[string, string]> | null {
  const bySuffix = new Map<string, string[]>()
  for (const rawField of fieldNames) {
    const suffix = sanitizeSuffix(rawField)
    if (suffix === '') {
      context.annotate(
        `Field name '${rawField}' on item '${uri.item}' sanitizes to an empty suffix; ` +
          'rename the field or use an explicit pass:// URI.',
      )
      context.failures.push({
        name: envKey,
        uri: uri.raw,
        detail: `field '${rawField}' sanitizes to an empty suffix`,
      })
      return null
    }
    bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), rawField])
  }

  const collisions = [...bySuffix.entries()].filter(([, rawNames]) => rawNames.length > 1)
  if (collisions.length > 0) {
    context.annotate(
      `Field-name collision while expanding ${uri.raw}: multiple fields sanitize to the same env-var suffix.`,
    )
    for (const [suffix, rawNames] of collisions) {
      context.annotate(`  ${envKey}_${suffix} <- ${rawNames.join(',')}`)
    }
    context.annotate('Rename the offending fields or replace the glob with explicit pass:// URIs.')
    context.failures.push({ name: envKey, uri: uri.raw, detail: 'field-name collision' })
    return null
  }

  return [...bySuffix.entries()].map(([suffix, rawNames]) => [suffix, rawNames[0] as string])
}

/** Returns null on malformed JSON; [] when the item has no fields. */
function parseFieldNames(itemJson: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(itemJson)
  } catch {
    return null
  }
  const fields = (parsed as { fields?: unknown })?.fields
  if (fields === undefined || fields === null) return []
  if (!Array.isArray(fields)) return null
  const names: string[] = []
  for (const field of fields) {
    const name = (field as { name?: unknown })?.name
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}
