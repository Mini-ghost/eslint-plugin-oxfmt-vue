import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

import { createFingerprint, scanFormatInputs } from './fingerprint.ts'
import { getSyncWorker, oxfmtRule } from './rule.ts'

import type { RuleOptions } from './rule.ts'
import type { SFCBlocksOptions } from './sfc.ts'
import type { ESLint, Linter } from 'eslint'

export type { CustomBlockOptions, SFCBlocksOptions } from './sfc.ts'
export type { RuleOptions } from './rule.ts'

const require = createRequire(import.meta.url)

function getPackageVersion(name: string): string {
  return (require(`${name}/package.json`) as { version: string }).version
}

const pluginVersion = (require('../package.json') as { version: string }).version

// ESLint's cache sees a plugin only as `name@version`. oxfmt and the SFC parser
// also decide the output, so their versions are part of the plugin version.
const versions = [
  pluginVersion,
  `oxfmt.${getPackageVersion('oxfmt')}`,
  `vue.${getPackageVersion('@vue/compiler-sfc')}`,
]

export interface CreateConfigOptions {
  /**
   * The project root. The plugin scans for config files from this directory.
   * It also searches upward from it for `.editorconfig`, as the oxfmt CLI does
   * from its current working directory. Defaults to `process.cwd()`.
   */
  root?: string
  /** Files that the config applies to. Defaults to every file that ESLint lints. */
  files?: Linter.Config['files']
  /** The blocks of Vue SFCs that the plugin formats */
  sfcBlocks?: SFCBlocksOptions
  /** Directories, relative to `root`, that the plugin does not scan for config files */
  scanIgnores?: string[]
  /** See `RuleOptions.cacheConfig` */
  cacheConfig?: boolean
}

export interface OxfmtVuePlugin extends ESLint.Plugin {
  /**
   * Creates a flat config that enables the `oxfmt` rule. Throws if an oxfmt
   * config file is not valid, or if a directory has more than one.
   */
  createConfig: (options?: CreateConfigOptions) => Linter.Config
  configs: {
    /** `createConfig()` with the defaults, named `oxfmt-vue/recommended` */
    readonly recommended: Linter.Config
  }
}

function createConfig(options: CreateConfigOptions = {}): Linter.Config {
  const root = resolve(options.root ?? process.cwd())
  const inputs = scanFormatInputs(root, { scanIgnores: options.scanIgnores })

  const failures = getSyncWorker()({ kind: 'validate', configPaths: inputs.configFiles })
  // The oxfmt CLI refuses a directory with more than one config file. The
  // loader picks one of them and gives no warning.
  const configsByDir = Map.groupBy(inputs.configFiles, (path) => dirname(path))
  for (const [dir, paths] of configsByDir) {
    if (paths.length < 2) continue
    failures.push({
      configPath: dir,
      message: `more than one config file: ${paths.map((path) => basename(path)).join(', ')}`,
    })
  }
  if (failures.length > 0) {
    const details = failures
      .map(({ configPath, message }) => `  ${configPath}: ${message}`)
      .join('\n')
    throw new Error(`[oxfmt-vue] Invalid oxfmt config:\n${details}`)
  }

  const ruleOptions: RuleOptions = {
    root,
    fingerprint: createFingerprint(root, inputs, versions),
    ...(options.sfcBlocks && { sfcBlocks: options.sfcBlocks }),
    ...(options.cacheConfig !== undefined && { cacheConfig: options.cacheConfig }),
  }

  return {
    name: 'oxfmt-vue/config',
    ...(options.files && { files: options.files }),
    plugins: { 'oxfmt-vue': plugin },
    rules: { 'oxfmt-vue/oxfmt': ['error', ruleOptions] },
  }
}

let recommended: Linter.Config | undefined

const plugin: OxfmtVuePlugin = {
  meta: {
    name: 'eslint-plugin-oxfmt-vue',
    version: versions.join('+'),
  },
  rules: { oxfmt: oxfmtRule },
  createConfig,
  configs: {
    get recommended() {
      recommended ??= { ...createConfig(), name: 'oxfmt-vue/recommended' }
      return recommended
    },
  },
}

export default plugin
