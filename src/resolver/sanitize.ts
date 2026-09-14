/**
 * Sanitize a Proton Pass field name into an env-var suffix.
 *
 * Rules (parity with the bash action): every run of non-alphanumeric
 * characters becomes a single `_`, leading/trailing `_` are stripped, and
 * the result is uppercased. `api-key` and `API Key` both become `API_KEY`.
 * Returns the empty string when nothing alphanumeric remains — callers must
 * treat that as a failure.
 */
export function sanitizeSuffix(rawFieldName: string): string {
  return rawFieldName
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}
