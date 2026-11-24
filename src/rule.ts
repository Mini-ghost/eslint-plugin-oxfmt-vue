import { fileURLToPath } from 'node:url'

import { generateDifferences, showInvisibles } from 'prettier-linter-helpers'
import { createSyncFn } from 'synckit'

import { toSFCSegments } from './sfc.ts'

import type { Segment, SFCBlocksOptions } from './sfc.ts'
import type { ConfigFailure, FormatOutput, FormatRequest, ValidateRequest } from './worker.ts'
import type { Rule } from 'eslint'
import type { Difference } from 'prettier-linter-helpers'

export interface RuleOptions {
  /**
   * Where the search for `.editorconfig` starts, like the current working
   * directory of the oxfmt CLI. Defaults to the `cwd` of ESLint.
   */
  root?: string
  /** Hash of the formatting inputs. Its only purpose is to change the cache key of ESLint. */
  fingerprint?: string
  /** The blocks of Vue SFCs that the plugin formats */
  sfcBlocks?: SFCBlocksOptions
  /**
   * Whether the plugin caches config files for the lifetime of the process.
   * If ESLint runs in a long-running process, such as an editor integration,
   * turn it off. ESLint then reads config changes without a restart.
   */
  cacheConfig?: boolean
}

const { INSERT, DELETE, REPLACE } = generateDifferences

interface SyncWorker {
  (request: FormatRequest): FormatOutput[]
  (request: ValidateRequest): ConfigFailure[]
}

let syncWorker: SyncWorker | undefined

/** Runs the async oxfmt API synchronously, because ESLint rules must be synchronous */
export function getSyncWorker(): SyncWorker {
  syncWorker ??= createSyncFn(
    fileURLToPath(new URL('./worker.mjs', import.meta.url)),
  ) as unknown as SyncWorker
  return syncWorker
}

function reportDifference(
  context: Rule.RuleContext,
  { operation, offset, deleteText = '', insertText = '' }: Difference,
  base: number,
) {
  const range: [number, number] = [base + offset, base + offset + deleteText.length]
  context.report({
    messageId: operation,
    data: {
      deleteText: showInvisibles(deleteText),
      insertText: showInvisibles(insertText),
    },
    loc: {
      start: context.sourceCode.getLocFromIndex(range[0]),
      end: context.sourceCode.getLocFromIndex(range[1]),
    },
    fix: (fixer) => fixer.replaceTextRange(range, insertText),
  })
}

export const oxfmtRule: Rule.RuleModule = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Format files with oxfmt, and Vue SFCs block by block',
    },
    fixable: 'code',
    messages: {
      [INSERT]: 'Insert `{{ insertText }}`',
      [DELETE]: 'Delete `{{ deleteText }}`',
      [REPLACE]: 'Replace `{{ deleteText }}` with `{{ insertText }}`',
      formatError: 'oxfmt: {{ message }}',
      unmappedOutput: 'Cannot map the oxfmt output of this block back to the file',
    },
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          fingerprint: { type: 'string' },
          cacheConfig: { type: 'boolean' },
          sfcBlocks: {
            type: 'object',
            properties: {
              template: { type: 'boolean' },
              script: { type: 'boolean' },
              style: { type: 'boolean' },
              customBlocks: {
                type: 'object',
                additionalProperties: {
                  anyOf: [
                    { enum: [false] },
                    {
                      type: 'object',
                      properties: { lang: { type: 'string' } },
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    // A processor extracted this code from another file. The rule formats that
    // file as a whole, so it skips the extracted code.
    if (context.filename !== context.physicalFilename) return {}

    const options = (context.options[0] ?? {}) as RuleOptions

    return {
      Program() {
        const filename = context.filename
        const text = context.sourceCode.text
        const isVue = filename.endsWith('.vue')
        const segments: Segment[] = isVue
          ? toSFCSegments(text, filename, options.sfcBlocks ?? {})
          : [
              {
                filename,
                formatInput: text,
                start: 0,
                originalContent: text,
                extract: (code) => code,
                toFileIndex: (index) => index,
              },
            ]
        if (segments.length === 0) return

        const results = getSyncWorker()({
          kind: 'format',
          filename,
          root: options.root ?? context.cwd,
          segments: segments.map(({ filename: name, formatInput }) => ({
            filename: name,
            formatInput,
          })),
          useAssociations: !isVue,
          useCache: options.cacheConfig !== false,
        })

        results.forEach(({ code, errors }, index) => {
          const segment = segments[index]!

          if (errors.length > 0) {
            for (const { message, start } of errors) {
              context.report({
                messageId: 'formatError',
                data: { message },
                loc: context.sourceCode.getLocFromIndex(segment.toFileIndex(start)),
              })
            }
            return
          }

          if (code === segment.formatInput) return
          const formatted = segment.extract(code)
          if (formatted === undefined) {
            context.report({
              messageId: 'unmappedOutput',
              loc: context.sourceCode.getLocFromIndex(segment.start),
            })
            return
          }
          if (formatted === segment.originalContent) return
          for (const difference of generateDifferences(segment.originalContent, formatted)) {
            reportDifference(context, difference, segment.start)
          }
        })
      },
    }
  },
}
