/** A secret successfully resolved from Proton Pass. Value bytes are opaque and never logged. */
export interface ResolvedSecret {
  readonly name: string
  readonly uri: string
  readonly value: string
}

/** A per-variable failure. Carries names, URIs, and error detail — never a value. */
export interface ResolutionFailure {
  readonly name: string
  readonly uri: string
  readonly detail: string
}

/** Outcome of scanning and resolving every pass:// reference in the environment. */
export interface ResolutionReport {
  readonly resolved: ResolvedSecret[]
  readonly failures: ResolutionFailure[]
}

export function formatFailure(failure: ResolutionFailure): string {
  return `${failure.name} -> ${failure.uri} (${failure.detail})`
}
