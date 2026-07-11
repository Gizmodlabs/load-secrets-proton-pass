import type { Platform } from '../installer/platform.ts'

/** Everything needed to install one verified pass-cli binary. */
export interface InstallerSpec {
  readonly version: string
  readonly platform: Platform
  readonly url: string
  readonly sha256: string
}
