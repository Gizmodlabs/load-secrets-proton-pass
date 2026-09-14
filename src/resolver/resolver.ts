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
 * (strict mode) whether they fail the step. Values are the stored bytes:
 * pass-cli prints a field value followed by exactly one newline (Rust
 * `println!`), and that single newline is the only thing ever removed.
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
  context.resolved.push({ name: envKey, uri, value: stripPrintNewline(result.stdout) })
}

/**
 * pass-cli prints a value with `println!`, so stdout is `<stored bytes>\n`.
 * Remove exactly that one newline. A stored value that itself ends in a
 * newline (PEM/SSH keys) keeps it; nothing else is trimmed.
 */
export function stripPrintNewline(stdout: string): string {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
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

/**
 * Field names on an item, in the shape `pass-cli item view --output json`
 * actually emits:
 *
 *   item.content.content       one externally tagged variant per item type,
 *                              e.g. `{ Login: { email, username, urls, ... } }`.
 *                              Note and Alias are unit structs and serialize
 *                              as a bare `null`.
 *   item.content.extra_fields  custom fields, `{ name, content: { <Kind>: value } }`
 *                              where Kind is Text, Hidden, Totp or Timestamp.
 *                              Timestamp alone carries a number.
 *
 * Inside a variant, an array is one of three things, told apart by its element
 * shape rather than by its key, since the keys differ per item type. A list of
 * strings (Login.urls) is itself one addressable field registered under the
 * array's own key, joined with ", ". A list of `{ name, content }` is custom
 * fields registered under their plain names, which is how Identity carries
 * extra_personal_details and its three siblings. A list of
 * `{ section_name, section_fields }` is sections, registered as
 * `SectionName.fieldname`, which covers SshKey, Wifi and Custom `sections` plus
 * Identity `extra_sections`. Anything else, notably Login.passkeys, is skipped.
 *
 * Section fields are emitted qualified even though a bare name usually
 * resolves, because the unqualified lookup returns the first match across all
 * sections: two sections sharing a field name would otherwise silently collapse
 * onto one value.
 *
 * Every name returned here is resolved with a second
 * `item view -- pass://vault/item/<name>` call, and one unaddressable name
 * fails the whole glob, so only addressable names may be returned. pass-cli
 * registers a scalar only when it is non-empty, so empty strings and empty
 * arrays are dropped. A custom field is registered once declared and resolves
 * even when its value is empty, so those are always kept. `title` and `note`
 * resolve as well but are item metadata rather than secrets, so a glob leaves
 * them out.
 *
 * Returns null when the envelope is unrecognized, so a pass-cli schema change
 * surfaces as a loud error rather than an item that silently has no fields.
 */
function parseFieldNames(itemJson: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(itemJson)
  } catch {
    return null
  }
  const content = (parsed as { item?: { content?: unknown } })?.item?.content
  if (typeof content !== 'object' || content === null) return null
  const { content: builtins, extra_fields: extraFields } = content as {
    content?: unknown
    extra_fields?: unknown
  }

  const names: string[] = []
  if (typeof builtins === 'object' && builtins !== null) {
    for (const variant of Object.values(builtins as Record<string, unknown>)) {
      if (typeof variant !== 'object' || variant === null) continue
      for (const [key, value] of Object.entries(variant as Record<string, unknown>)) {
        if (typeof value === 'string' && value !== '') names.push(key)
        else if (Array.isArray(value)) names.push(...arrayFieldNames(key, value))
      }
    }
  }
  names.push(...customFieldNames(extraFields))
  return names
}

function arrayFieldNames(key: string, entries: unknown[]): string[] {
  if (entries.length === 0) return []
  if (entries.every(entry => typeof entry === 'string')) return [key]
  const names: string[] = []
  for (const entry of entries) {
    const section = (entry as { section_name?: unknown; section_fields?: unknown })?.section_fields
    if (Array.isArray(section)) {
      const sectionName = (entry as { section_name?: unknown }).section_name
      const prefix = typeof sectionName === 'string' && sectionName !== '' ? `${sectionName}.` : ''
      names.push(...customFieldNames(section).map(name => `${prefix}${name}`))
    } else {
      names.push(...customFieldNames([entry]))
    }
  }
  return names
}

/** Entries shaped `{ name, content: { <Kind>: value } }`; anything else is not a field. */
function customFieldNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  const names: string[] = []
  for (const entry of entries) {
    const { name, content } = (entry ?? {}) as { name?: unknown; content?: unknown }
    if (typeof name !== 'string' || name === '') continue
    if (typeof content !== 'object' || content === null || Array.isArray(content)) continue
    names.push(name)
  }
  return names
}
