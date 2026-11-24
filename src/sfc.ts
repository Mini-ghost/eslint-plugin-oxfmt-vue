import { parse } from '@vue/compiler-sfc'

export interface CustomBlockOptions {
  /** Language of blocks without a `lang` attribute */
  lang?: string
}

/** Same shape as eslint-plugin-prettier-vue's `SFCBlocks` setting */
export interface SFCBlocksOptions {
  template?: boolean
  script?: boolean
  style?: boolean
  /** The rule formats only the custom blocks that this object lists */
  customBlocks?: Record<string, CustomBlockOptions | false>
}

/** A part of the linted file that oxfmt formats on its own */
export interface Segment {
  /** File name that decides the language that oxfmt formats the segment as */
  filename: string
  formatInput: string
  /** Index in the file where `originalContent` starts */
  start: number
  originalContent: string
  /** Picks the new `originalContent` out of the oxfmt output, or `undefined` */
  extract: (code: string) => string | undefined
  /** Maps an index in `formatInput` to an index in the file */
  toFileIndex: (index: number) => number
}

type BuiltInBlockType = 'template' | 'script' | 'style'

function extractBlockContent(code: string, type: BuiltInBlockType) {
  // If the parser finds the block, errors inside the template do not matter
  const { descriptor } = parse(code, { pad: false })
  if (type === 'template') return descriptor.template?.content
  if (type === 'script') return descriptor.script?.content
  return descriptor.styles.length === 1 ? descriptor.styles[0]!.content : undefined
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

/**
 * Each built-in block gets a new start tag that keeps only `lang`, so
 * `vueIndentScriptAndStyle` still applies. oxfmt can reformat this wrapper, so
 * the rule compares only the content between the tags. Fixes then never reach
 * the original attributes or the text after the block.
 */
export function toSFCSegments(
  text: string,
  filename: string,
  options: SFCBlocksOptions,
): Segment[] {
  const enabled: Record<BuiltInBlockType, boolean> = {
    template: options.template !== false,
    script: options.script !== false,
    style: options.style !== false,
  }
  const customOptions = options.customBlocks ?? {}

  const { descriptor } = parse(text, { filename, pad: false })
  const { template, script, scriptSetup, styles, customBlocks } = descriptor

  const segments: Segment[] = []

  for (const block of [template, script, scriptSetup, ...styles]) {
    if (!block || !enabled[block.type as BuiltInBlockType]) continue
    // A block with `src` has no content of its own
    if (block.src) continue

    const type = block.type as BuiltInBlockType
    const startTag = `<${type}${block.lang ? ` lang="${block.lang}"` : ''}>`
    const start = block.loc.start.offset
    const end = block.loc.end.offset
    segments.push({
      filename: `${filename}.${type}.vue`,
      formatInput: `${startTag}${block.content}</${type}>\n`,
      start,
      originalContent: block.content,
      extract: (code) => extractBlockContent(code, type),
      toFileIndex: (index) => clamp(start + index - startTag.length, start, end),
    })
  }

  for (const block of customBlocks) {
    if (!Object.hasOwn(customOptions, block.type)) continue
    const blockOptions = customOptions[block.type]
    if (!blockOptions) continue

    const lang = typeof block.attrs.lang === 'string' ? block.attrs.lang : blockOptions.lang
    // Drop the leading newline after the start tag, as eslint-plugin-prettier-vue does
    const leadingNewline = /^\r?\n/.exec(block.content)?.[0] ?? ''
    const start = block.loc.start.offset + leadingNewline.length
    const end = block.loc.end.offset
    segments.push({
      // TODO: `vue` matches eslint-plugin-prettier-vue, but the Vue parser only
      // rewrites whitespace. Skip the block and report the missing `lang` instead.
      filename: `${filename}.${block.type}.${lang ?? 'vue'}`,
      formatInput: block.content.slice(leadingNewline.length),
      start,
      originalContent: block.content.slice(leadingNewline.length),
      extract: (code) => code,
      toFileIndex: (index) => clamp(start + index, start, end),
    })
  }

  return segments
}
