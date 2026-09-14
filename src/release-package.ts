import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const VERSION_TAG = /^v\d+\.\d+\.\d+$/
const PACKAGE_PATHS = ['action.yml', 'dist', 'README.md', 'LICENSE', 'CLAUDE.md', 'CHANGELOG.md'] as const

export interface PackageReleaseOptions {
  readonly tag: string
  readonly outDir: string
  readonly projectRoot?: string
}

export interface PackagedRelease {
  readonly tarball: string
  readonly checksum: string
}

/** Build the exact source archive that the release workflow publishes. */
export async function packageRelease(options: PackageReleaseOptions): Promise<PackagedRelease> {
  if (!VERSION_TAG.test(options.tag)) {
    throw new Error(`Tag '${options.tag}' must match vMAJOR.MINOR.PATCH`)
  }

  const projectRoot = options.projectRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await Promise.all(PACKAGE_PATHS.map(path => requirePath(join(projectRoot, path))))
  await fs.mkdir(options.outDir, { recursive: true })

  const tarball = join(options.outDir, `load-secrets-proton-pass-${options.tag}.tar.gz`)
  const checksum = `${tarball}.sha256`
  await execFileAsync('tar', ['-czf', tarball, ...PACKAGE_PATHS], { cwd: projectRoot })

  const digest = createHash('sha256').update(await fs.readFile(tarball)).digest('hex')
  await fs.writeFile(checksum, `${digest}  ${basename(tarball)}\n`)
  return { tarball, checksum }
}

async function requirePath(path: string): Promise<void> {
  try {
    await fs.access(path)
  } catch {
    throw new Error(`Release package is missing required path: ${path}`)
  }
}

function readCliArgs(args: string[]): PackageReleaseOptions {
  let tag = ''
  let outDir = ''
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--tag') tag = args[++index] ?? ''
    if (value === '--out-dir') outDir = args[++index] ?? ''
  }
  if (!outDir) throw new Error('Missing required --out-dir argument')
  return { tag, outDir }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  packageRelease(readCliArgs(process.argv.slice(2)))
    .then(({ tarball, checksum }) => {
      process.stdout.write(`tarball=${tarball}\nchecksum=${checksum}\n`)
    })
    .catch(err => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}
