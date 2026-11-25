import { join } from 'node:path'

import { Linter } from 'eslint'
import * as plainParser from 'eslint-parser-plain'
import { Linter as LinterV9 } from 'eslint-v9'
import { describe, expect, it } from 'vitest'

import plugin from '../dist/index.mjs'

import type { RuleOptions } from '../dist/index.mjs'

const fixtures = join(import.meta.dirname, 'fixtures')

interface LintOptions extends RuleOptions {
  eslint?: typeof Linter | typeof LinterV9
}

function lint(fixture: string, file: string, code: string, options: LintOptions = {}) {
  const { eslint: LinterClass = Linter, ...ruleOptions } = options
  const root = join(fixtures, fixture)
  // Both versions share the API used here
  const linter = new LinterClass({ cwd: root, configType: 'flat' }) as Linter
  const config = [
    {
      files: ['**/*.{ts,vue,json,md}'],
      languageOptions: { parser: plainParser },
      plugins: { 'oxfmt-vue': plugin },
      rules: { 'oxfmt-vue/oxfmt': ['error', { root, ...ruleOptions }] },
    },
  ] as Linter.Config[]
  const filename = join(root, file)
  return {
    messages: linter.verify(code, config, { filename }),
    fixed: linter.verifyAndFix(code, config, { filename }),
  }
}

describe('non-Vue files', () => {
  it('accepts formatted code', () => {
    expect(lint('basic', 'a.ts', "const a = 'x'\n").messages).toEqual([])
  })

  it('fixes unformatted code with the nearest config', () => {
    const { messages, fixed } = lint('basic', 'a.ts', 'const a = "x";')
    expect(messages.length).toBeGreaterThan(0)
    expect(fixed.output).toBe("const a = 'x'\n")
  })

  it.each([
    ['ts-config', "const a = 'x'\n"],
    ['jsonc', 'const a = "x"\n'],
  ])('reads the config file of the %s fixture', (fixture, expected) => {
    expect(lint(fixture, 'a.ts', 'const a = "x";').fixed.output).toBe(expected)
  })

  it('uses a nested config for files under it', () => {
    expect(lint('nested', 'a.ts', 'const a = 1').fixed.output).toBe('const a = 1\n')
    expect(lint('nested', 'sub/a.ts', 'const a = 1').fixed.output).toBe('const a = 1;\n')
  })

  it('reads `.editorconfig` from the root, as the oxfmt CLI does from its cwd', () => {
    const code = 'function f() {\nreturn 1\n}\n'
    const expected = 'function f() {\n    return 1\n}\n'
    expect(lint('editorconfig', 'a.ts', code).fixed.output).toBe(expected)
    // `sub/.editorconfig` is not read
    expect(lint('editorconfig', 'sub/a.ts', code).fixed.output).toBe(expected)
  })

  it('formats files as the language set in `associations`', () => {
    expect(lint('associations', 'a.json', '{"alpha":1}').fixed.output).toBe('{ alpha: 1 }\n')
  })

  it('reports syntax errors at the right UTF-16 position', () => {
    const { messages } = lint('basic', 'a.ts', "const 中文 = '😀' +\n")
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ messageId: 'formatError', line: 2, column: 1 })
  })

  it('skips code extracted by a processor', () => {
    const root = join(fixtures, 'basic')
    const linter = new Linter({ cwd: root, configType: 'flat' })
    const messages = linter.verify(
      'const a = "x";',
      [
        {
          files: ['**/*.{ts,vue,json,md}'],
          processor: {
            preprocess: (text: string) => [{ text, filename: 'inner.js' }],
            postprocess: (messages: Linter.LintMessage[][]) => messages.flat(),
          },
        },
        {
          files: ['**/*.js'],
          languageOptions: { parser: plainParser },
          plugins: { 'oxfmt-vue': plugin },
          rules: { 'oxfmt-vue/oxfmt': ['error', { root }] },
        },
      ] as Linter.Config[],
      { filename: join(root, 'a.md') },
    )
    expect(messages).toEqual([])
  })
})

describe('Vue SFCs', () => {
  const sfc = [
    '<script setup lang="ts" generic="T">',
    'const a = "x";',
    '</script>',
    '',
    '<template>',
    '  <div   class="a"/>',
    '</template>',
    '',
    '<style scoped>',
    'a{color:red}',
    '</style>',
    '',
  ].join('\n')

  it('formats only the enabled blocks and keeps the original tags', () => {
    const { fixed } = lint('basic', 'A.vue', sfc, {
      sfcBlocks: { template: false },
    })
    expect(fixed.output).toBe(
      [
        '<script setup lang="ts" generic="T">',
        "const a = 'x'",
        '</script>',
        '',
        '<template>',
        '  <div   class="a"/>',
        '</template>',
        '',
        '<style scoped>',
        'a {',
        '  color: red;',
        '}',
        '</style>',
        '',
      ].join('\n'),
    )
  })

  it('formats the template when enabled', () => {
    const { fixed } = lint('basic', 'A.vue', sfc)
    expect(fixed.output).toContain('  <div class="a" />\n')
  })

  describe('template expressions', () => {
    it.each([
      [
        '<script setup lang="ts">',
        '<script setup lang="ts">\nconst data = 1\n</script>\n\n<template>\n  <Foo :a="(data as any)" />\n</template>\n',
      ],
      [
        '<script lang="ts">',
        '<script lang="ts">\nconst data = 1\n</script>\n\n<template>\n  <Foo :a="(data as any)" />\n</template>\n',
      ],
      [
        '<script src lang="ts">',
        '<script src="./a.ts" lang="ts"></script>\n\n<template>\n  <Foo :a="(data as any)" />\n</template>\n',
      ],
    ])('parses them as TypeScript next to %s', (_, code) => {
      const { fixed } = lint('basic', 'A.vue', code)
      expect(fixed.output).toContain(':a="data as any"')
    })

    it('keeps them unchanged next to a JavaScript script, as the oxfmt CLI does', () => {
      const code =
        '<script>\nconst data = 1\n</script>\n\n<template>\n  <Foo :a="(data as any)" />\n</template>\n'
      const { fixed } = lint('basic', 'A.vue', code)
      expect(fixed.output).toContain(':a="(data as any)"')
    })

    it('reports syntax errors in a TypeScript SFC at the right position', () => {
      const code =
        '<script setup lang="ts">\nconst data = 1\n</script>\n\n<template>\n  <div></span>\n</template>\n'
      const { messages } = lint('basic', 'A.vue', code)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ messageId: 'formatError', line: 6, column: 8 })
    })
  })

  it('never touches the start tag, even when the rebuilt one is wrapped', () => {
    const code = '<style lang="scss" scoped>a{color:red}</style>\n'
    const { fixed } = lint('narrow', 'A.vue', code)
    expect(fixed.output).toBe('<style lang="scss" scoped>\na {\n  color: red;\n}\n</style>\n')
    expect(lint('narrow', 'A.vue', fixed.output).messages).toEqual([])
  })

  it('never reaches past the end tag', () => {
    const code = '<script>\nconst a = "x"\n</script><template><div /></template>'
    const { messages, fixed } = lint('nofinalnl', 'A.vue', code, {
      sfcBlocks: { template: false },
    })
    expect(messages).toEqual([])
    expect(fixed.output).toBe(code)
  })

  it('accepts CRLF files formatted with `endOfLine: crlf`', () => {
    const code =
      '<script>\r\nconst a = 1\r\n</script>\r\n\r\n<template>\r\n  <div />\r\n</template>\r\n'
    expect(lint('crlf', 'A.vue', code, { sfcBlocks: { template: false } }).messages).toEqual([])
    expect(lint('crlf', 'A.vue', code).messages).toEqual([])
  })

  it('formats custom blocks listed in `customBlocks` only', () => {
    const code =
      '<i18n lang="json">\n{"a":1}\n</i18n>\n<docs lang="json">\n{"a":1}\n</docs>\n<constructor lang="json">{"x":1}</constructor>\n'
    const { fixed } = lint('basic', 'A.vue', code, {
      sfcBlocks: { customBlocks: { i18n: {} } },
    })
    expect(fixed.output).toBe(
      '<i18n lang="json">\n{ "a": 1 }\n</i18n>\n<docs lang="json">\n{"a":1}\n</docs>\n<constructor lang="json">{"x":1}</constructor>\n',
    )
  })

  it('uses `customBlocks` for blocks without `lang`, and keeps CRLF after the start tag', () => {
    const code = '<i18n>\r\n{ "a": 1 }\r\n</i18n>\r\n'
    expect(
      lint('crlf', 'A.vue', code, {
        sfcBlocks: { customBlocks: { i18n: { lang: 'json' } } },
      }).messages,
    ).toEqual([])
  })

  it('reports syntax errors inside a block at the right position', () => {
    const code = '<i18n lang="json">{"中":"😀","a": [1 2]}</i18n>\n'
    const { messages } = lint('basic', 'A.vue', code, {
      sfcBlocks: { customBlocks: { i18n: {} } },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ messageId: 'formatError', line: 1, column: 37 })
  })
})

describe('ESLint 9', () => {
  it('works with the same results', () => {
    const { fixed } = lint('basic', 'a.ts', 'const a = "x";', { eslint: LinterV9 })
    expect(fixed.output).toBe("const a = 'x'\n")
    expect(
      lint('narrow', 'A.vue', '<style lang="scss" scoped>a{color:red}</style>\n', {
        eslint: LinterV9,
      }).fixed.output,
    ).toBe('<style lang="scss" scoped>\na {\n  color: red;\n}\n</style>\n')
  })
})
