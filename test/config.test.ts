import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import plugin from '../dist/index.mjs'

const fixtures = join(import.meta.dirname, 'fixtures')

function fingerprintOf(root: string, scanIgnores?: string[]) {
  const config = plugin.createConfig({ root, scanIgnores })
  const [, options] = config.rules!['oxfmt-vue/oxfmt'] as [string, { fingerprint: string }]
  return options.fingerprint
}

describe('createConfig', () => {
  it('enables the rule with the root and the SFC blocks', () => {
    const root = join(fixtures, 'basic')
    const config = plugin.createConfig({
      root,
      files: ['**/*.vue'],
      sfcBlocks: { template: false },
    })
    expect(config.files).toEqual(['**/*.vue'])
    expect(config.plugins).toEqual({ 'oxfmt-vue': plugin })
    expect(config.rules!['oxfmt-vue/oxfmt']).toEqual([
      'error',
      { root, fingerprint: expect.any(String), sfcBlocks: { template: false } },
    ])
  })

  it('names only the default config `recommended`', () => {
    expect(plugin.createConfig({ root: join(fixtures, 'basic') }).name).toBe('oxfmt-vue/config')
    expect(plugin.configs.recommended.name).toBe('oxfmt-vue/recommended')
  })

  it('throws once for an invalid config instead of on every file', () => {
    // An invalid fixture file breaks the oxfmt CLI when it runs on this
    // repository, so the test writes the file to a temporary directory
    const root = mkdtempSync(join(tmpdir(), 'oxfmt-vue-'))
    try {
      mkdirSync(join(root, 'sub'))
      writeFileSync(join(root, 'sub/.oxfmtrc.json'), '{ "printWidth": "80" }\n')
      expect(() => plugin.createConfig({ root })).toThrow(
        /Invalid oxfmt config:\n.*sub[/\\]\.oxfmtrc\.json: .*expected u16/,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('createConfig with config files of other kinds', () => {
  it.each(['ts-config', 'jsonc'])('accepts the %s fixture', (fixture) => {
    expect(() => plugin.createConfig({ root: join(fixtures, fixture) })).not.toThrow()
  })

  it('throws for a directory with two config files, as the oxfmt CLI does', () => {
    const root = mkdtempSync(join(tmpdir(), 'oxfmt-vue-'))
    try {
      writeFileSync(join(root, '.oxfmtrc.json'), '{}\n')
      writeFileSync(join(root, 'oxfmt.config.ts'), 'export default {}\n')
      expect(() => plugin.createConfig({ root })).toThrow(
        /more than one config file: \.oxfmtrc\.json, oxfmt\.config\.ts/,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips directories it cannot read', () => {
    const root = mkdtempSync(join(tmpdir(), 'oxfmt-vue-'))
    const locked = join(root, 'locked')
    try {
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      expect(() => plugin.createConfig({ root })).not.toThrow()
    } finally {
      chmodSync(locked, 0o755)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('fingerprint', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oxfmt-vue-'))
    writeFileSync(join(root, '.oxfmtrc.json'), '{ "semi": false }\n')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('changes with any config file of the project', () => {
    const initial = fingerprintOf(root)
    expect(fingerprintOf(root)).toBe(initial)

    mkdirSync(join(root, 'packages/a'), { recursive: true })
    writeFileSync(join(root, 'packages/a/.oxfmtrc.json'), '{}\n')
    const nested = fingerprintOf(root)
    expect(nested).not.toBe(initial)

    writeFileSync(join(root, '.editorconfig'), 'root = true\n')
    const withEditorconfig = fingerprintOf(root)
    expect(withEditorconfig).not.toBe(nested)

    mkdirSync(join(root, 'packages/b'), { recursive: true })
    writeFileSync(join(root, 'packages/b/oxfmt.config.ts'), 'export default {}\n')
    expect(fingerprintOf(root)).not.toBe(withEditorconfig)
  })

  it('skips node_modules, nested git roots and `scanIgnores`', () => {
    const initial = fingerprintOf(root)
    for (const dir of ['node_modules/x', '.claude/worktrees/w', 'vendor']) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, '.oxfmtrc.json'), '{ "semi": true }\n')
    }
    // A worktree has a `.git` file
    writeFileSync(join(root, '.claude/worktrees/w/.git'), 'gitdir: /somewhere\n')
    expect(fingerprintOf(root, ['vendor'])).toBe(initial)
    expect(fingerprintOf(root)).not.toBe(initial)
  })

  it('stays the same when the project moves', () => {
    const other = mkdtempSync(join(tmpdir(), 'oxfmt-vue-'))
    try {
      writeFileSync(join(other, '.oxfmtrc.json'), '{ "semi": false }\n')
      expect(fingerprintOf(other)).toBe(fingerprintOf(root))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('plugin meta', () => {
  it('carries the versions of everything that decides the output', () => {
    expect(plugin.meta?.version).toMatch(/^\d+\.\d+\.\d+\+oxfmt\.[\d.]+\+vue\.[\d.]+$/)
  })
})
