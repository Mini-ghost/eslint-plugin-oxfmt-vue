import { basename, dirname, join, resolve } from 'node:path'

import { loadOxfmtConfig, loadOxfmtConfigForFile } from 'load-oxfmt-config'
import { format } from 'oxfmt'
import picomatch from 'picomatch'
import { runAsWorker } from 'synckit'

import { toPosixRelativePath } from './path.ts'

import type { OxfmtOptions } from 'load-oxfmt-config'
import type { FormatConfig } from 'oxfmt'

/** The part of a `Segment` that the worker needs. Functions cannot cross the worker boundary. */
export interface FormatSegment {
  filename: string
  formatInput: string
}

export interface FormatRequest {
  kind: 'format'
  /** The linted file, which decides the config and the overrides to apply */
  filename: string
  /** Where the search for `.editorconfig` starts. See `RuleOptions.root`. */
  root: string
  segments: FormatSegment[]
  /** Whether `associations` can change the language of the segments */
  useAssociations: boolean
  useCache: boolean
}

export interface ValidateRequest {
  kind: 'validate'
  configPaths: string[]
}

export interface FormatError {
  message: string
  /** Index in `formatInput`, in UTF-16 code units */
  start: number
}

export interface FormatOutput {
  code: string
  errors: FormatError[]
}

export interface ConfigFailure {
  configPath: string
  message: string
}

export interface WorkerFunction {
  (request: FormatRequest): Promise<FormatOutput[]>
  (request: ValidateRequest): Promise<ConfigFailure[]>
}

// Adapted from eslint-plugin-oxfmt (MIT, ntnyq). oxfmt picks the language by the
// file extension, so each language that `associations` accepts maps to one.
const LANGUAGE_SUFFIXES: Record<string, string> = {
  'angular-html': 'component.html',
  astro: 'astro',
  css: 'css',
  graphql: 'graphql',
  handlebars: 'hbs',
  html: 'html',
  javascript: 'js',
  json: 'json',
  json5: 'json5',
  jsonc: 'jsonc',
  jsx: 'jsx',
  less: 'less',
  markdown: 'md',
  mdx: 'mdx',
  scss: 'scss',
  svelte: 'svelte',
  toml: 'toml',
  tsx: 'tsx',
  typescript: 'ts',
  vue: 'vue',
  yaml: 'yaml',
}

// Same as the oxfmt CLI, which never changes the language of these files
const ASSOCIATION_EXCLUDED_FILENAMES = new Set([
  'bun.lock',
  'Cargo.lock',
  'composer.lock',
  'deno.lock',
  'flake.lock',
  'Gopkg.lock',
  'mcmod.info',
  'MODULE.bazel.lock',
  'package-lock.json',
  'Package.resolved',
  'pdm.lock',
])

const GLOB_OPTIONS = { dot: true, noextglob: true, strictBrackets: true }

const matcherCache = new Map<string, picomatch.Matcher>()

function getMatcher(patterns: string[]) {
  const key = patterns.join('\0')
  let matcher = matcherCache.get(key)
  if (!matcher) {
    matcher = picomatch(patterns, GLOB_OPTIONS)
    matcherCache.set(key, matcher)
  }
  return matcher
}

function matchesGlobs(relativePath: string, files: string[], excludeFiles: string[] | undefined) {
  if (!getMatcher(files)(relativePath)) return false
  return !excludeFiles?.length || !getMatcher(excludeFiles)(relativePath)
}

/** Paths in `sortTailwindcss` are relative to the config file */
function resolveTailwindPaths(options: FormatConfig, baseDir: string) {
  const { sortTailwindcss } = options
  if (!sortTailwindcss || typeof sortTailwindcss !== 'object') return options
  return {
    ...options,
    sortTailwindcss: {
      ...sortTailwindcss,
      ...(sortTailwindcss.config && {
        config: resolve(baseDir, sortTailwindcss.config),
      }),
      ...(sortTailwindcss.stylesheet && {
        stylesheet: resolve(baseDir, sortTailwindcss.stylesheet),
      }),
    },
  }
}

interface FileConfig {
  options: FormatConfig
  /** Last `associations` entry that matches the file, if any */
  language?: string
}

/** Resolves the options and the language of one file the way the oxfmt CLI does */
async function resolveFileConfig(request: FormatRequest): Promise<FileConfig> {
  const { filename, root, useCache } = request
  const loaded = await loadOxfmtConfigForFile({
    filepath: filename,
    cwd: root,
    // The oxfmt CLI reads one `.editorconfig`, found upward from its current
    // working directory. It does not read the nearest one of each file.
    editorconfig: { cwd: root },
    useCache,
  })
  const {
    overrides,
    associations,
    ignorePatterns: _ignorePatterns,
    ...base
  } = loaded.config as OxfmtOptions & { $schema?: string }
  delete (base as { $schema?: string }).$schema

  const baseDir = loaded.dirname ?? root
  const relativePath = toPosixRelativePath(baseDir, filename)

  let options = resolveTailwindPaths(base, baseDir)
  for (const override of overrides ?? []) {
    if (!override.files?.length || !override.options) continue
    if (!matchesGlobs(relativePath, override.files, override.excludeFiles)) continue
    options = { ...options, ...resolveTailwindPaths(override.options, baseDir) }
  }

  let language: string | undefined
  for (const association of associations ?? []) {
    if (matchesGlobs(relativePath, association.files, association.excludeFiles)) {
      language = association.language
    }
  }
  return { options, language }
}

// oxfmt gives error positions as UTF-8 byte offsets, but ESLint uses UTF-16 indexes
function byteOffsetToUtf16Index(source: string, byteOffset: number) {
  return Buffer.from(source).subarray(0, byteOffset).toString().length
}

async function formatSegments(request: FormatRequest): Promise<FormatOutput[]> {
  const { options, language } = await resolveFileConfig(request)

  return Promise.all(
    request.segments.map(async ({ filename, formatInput }) => {
      let formatFilename = filename
      if (
        request.useAssociations &&
        language &&
        !ASSOCIATION_EXCLUDED_FILENAMES.has(basename(filename))
      ) {
        const suffix = LANGUAGE_SUFFIXES[language]
        if (!suffix) {
          throw new Error(`[oxfmt-vue] Unknown language in associations: ${language}`)
        }
        // Rules that depend on the file name, such as the sort of `package.json`,
        // must not override the chosen language, so use a neutral basename
        formatFilename = join(dirname(filename), `__oxfmt__.${suffix}`)
      }

      const { code, errors } = await format(formatFilename, formatInput, options)
      return {
        code,
        errors: errors.map(({ message, labels }) => ({
          message: message.replaceAll(formatFilename, filename),
          start: byteOffsetToUtf16Index(formatInput, labels[0]?.start ?? 0),
        })),
      }
    }),
  )
}

/**
 * oxfmt reports invalid options only when it formats, so format an empty file
 * with each option set.
 */
async function validateConfigs({ configPaths }: ValidateRequest): Promise<ConfigFailure[]> {
  const failures: ConfigFailure[] = []
  for (const configPath of configPaths) {
    try {
      const { config } = await loadOxfmtConfig({
        configPath,
        cwd: dirname(configPath),
        editorconfig: false,
        useCache: false,
      })
      const {
        overrides,
        associations,
        ignorePatterns: _ignorePatterns,
        ...base
      } = config as OxfmtOptions & { $schema?: string }
      delete (base as { $schema?: string }).$schema

      for (const association of associations ?? []) {
        if (!Object.hasOwn(LANGUAGE_SUFFIXES, association.language)) {
          throw new Error(`Unknown language in associations: ${association.language}`)
        }
      }

      const optionSets = [
        base,
        ...(overrides ?? []).map((override) => ({
          ...base,
          ...override.options,
        })),
      ]
      for (const options of optionSets) {
        const { errors } = await format('probe.ts', '', options)
        if (errors[0]) throw new Error(errors[0].message)
      }
    } catch (error) {
      failures.push({
        configPath,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return failures
}

runAsWorker(((request: FormatRequest | ValidateRequest) =>
  request.kind === 'format' ? formatSegments(request) : validateConfigs(request)) as WorkerFunction)
