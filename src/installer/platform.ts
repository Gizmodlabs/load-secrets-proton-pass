/** Release platforms pass-cli is published for. */
export const VALID_PLATFORMS = [
  'linux-x86_64',
  'linux-aarch64',
  'macos-x86_64',
  'macos-aarch64',
  'windows-x86_64',
] as const

export type Platform = (typeof VALID_PLATFORMS)[number]

const PLATFORM_MAP: Readonly<Record<string, Platform>> = {
  'linux/x64': 'linux-x86_64',
  'linux/arm64': 'linux-aarch64',
  'darwin/x64': 'macos-x86_64',
  'darwin/arm64': 'macos-aarch64',
  'win32/x64': 'windows-x86_64',
}

export function detectPlatform(
  os: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): Platform {
  const platform = PLATFORM_MAP[`${os}/${arch}`]
  if (!platform) {
    throw new Error(
      `Unsupported platform/architecture: ${os}/${arch}. ` +
        `pass-cli is available for: ${VALID_PLATFORMS.join(', ')}`,
    )
  }
  return platform
}

/** Validates an explicit platform input, or auto-detects when empty. */
export function resolvePlatform(input: string): Platform {
  const trimmed = input.trim()
  if (!trimmed) return detectPlatform()
  if (!(VALID_PLATFORMS as readonly string[]).includes(trimmed)) {
    throw new Error(`Invalid platform "${trimmed}". Valid values: ${VALID_PLATFORMS.join(', ')}`)
  }
  return trimmed as Platform
}
