import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import picomatch from 'picomatch'

import { toPosixRelativePath } from './path.ts'

/** The file names that the oxfmt CLI looks for */
export const CONFIG_FILENAMES = [
  '.oxfmtrc.json',
  '.oxfmtrc.jsonc',
  'oxfmt.config.ts',
  'oxfmt.config.mts',
]

const EDITORCONFIG = '.editorconfig'

export interface ScanOptions {
  /** Directories, relative to `root`, that the scan skips */
  scanIgnores?: string[]
}

export interface FormatInputs {
  /** Config files under `root` and in the directories above it */
  configFiles: string[]
  /** The `.editorconfig` found upward from `root` */
  editorconfig?: string
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Stops at nested git roots, such as worktrees and submodules, whose `.git` is
 * a file or a directory. Their configs must not invalidate the cache of this
 * project.
 */
export function scanFormatInputs(root: string, options: ScanOptions = {}): FormatInputs {
  const isIgnored = options.scanIgnores?.length
    ? picomatch(options.scanIgnores, { dot: true })
    : () => false

  const configFiles: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // An unreadable directory cannot hold files that ESLint lints either
      if (dir === root) throw error
      continue
    }
    if (dir !== root && entries.some((entry) => entry.name === '.git')) continue

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        if (isIgnored(toPosixRelativePath(root, path))) continue
        stack.push(path)
      } else if (CONFIG_FILENAMES.includes(entry.name)) {
        configFiles.push(path)
      }
    }
  }

  // Files without a config of their own use one above `root`, as far up as
  // the file system root
  let editorconfig: string | undefined
  for (let dir = root; ; dir = dirname(dir)) {
    if (dir !== root) {
      for (const name of CONFIG_FILENAMES) {
        if (isFile(join(dir, name))) configFiles.push(join(dir, name))
      }
    }
    if (!editorconfig && isFile(join(dir, EDITORCONFIG))) {
      editorconfig = join(dir, EDITORCONFIG)
    }
    if (dirname(dir) === dir) break
  }

  return { configFiles: configFiles.sort(), editorconfig }
}

/**
 * ESLint's cache uses only the config as its key. This hash goes into the rule
 * options, so a change to a formatting input invalidates the cache. The hash
 * does not cover files that an `oxfmt.config.ts` imports.
 */
export function createFingerprint(root: string, inputs: FormatInputs, versions: string[]) {
  const hash = createHash('sha256')
  for (const version of versions) hash.update(`${version}\0`)
  for (const path of [...inputs.configFiles, inputs.editorconfig ?? '']) {
    // Relative paths keep the key the same across checkouts of the project
    hash.update(`${path && toPosixRelativePath(root, path)}\0`)
    if (path && existsSync(path)) hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}
