import { parsePassUri, type PassUri } from '../domain/pass-uri.ts'

export interface SecretRef {
  readonly name: string
  readonly uri: PassUri
}

/**
 * Scan an environment map for full three-segment pass:// references.
 * Values that merely start with pass:// but do not parse (fewer than three
 * segments) are ignored, matching the bash action.
 */
export function findSecretRefs(env: NodeJS.ProcessEnv): SecretRef[] {
  const refs: SecretRef[] = []
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    const uri = parsePassUri(value)
    if (uri) refs.push({ name, uri })
  }
  return refs
}
