/**
 * Parsed `pass://<vault>/<item>/<field>` reference.
 *
 * Parity with the bash action's greedy regex `^pass://(.+)/(.+)/(.+)$`:
 * extra `/` characters are absorbed by the vault segment, and values with
 * fewer than three segments are not secret references at all (callers skip
 * them silently).
 */
export type PassUriKind =
  | 'literal'
  | 'field-glob'
  | 'invalid-vault-item-wildcard'
  | 'invalid-partial-field-wildcard'

export interface PassUri {
  readonly raw: string
  readonly vault: string
  readonly item: string
  readonly field: string
  readonly kind: PassUriKind
  /** URI without the field segment — used to list an item's fields for globs. */
  readonly itemUri: string
}

const PASS_URI_PATTERN = /^pass:\/\/(.+)\/(.+)\/(.+)$/

function classify(vault: string, item: string, field: string): PassUriKind {
  if (vault.includes('*') || item.includes('*')) return 'invalid-vault-item-wildcard'
  if (field === '*') return 'field-glob'
  if (field.includes('*')) return 'invalid-partial-field-wildcard'
  return 'literal'
}

/** Returns null when the value is not a full three-segment pass:// reference. */
export function parsePassUri(value: string): PassUri | null {
  const match = PASS_URI_PATTERN.exec(value)
  if (!match) return null

  const [, vault, item, field] = match
  if (vault === undefined || item === undefined || field === undefined) return null

  return {
    raw: value,
    vault,
    item,
    field,
    kind: classify(vault, item, field),
    itemUri: `pass://${vault}/${item}`,
  }
}
