# eslint-plugin-oxfmt-vue

Format files with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) in ESLint. For Vue single-file components (SFCs), choose which blocks to format, as [eslint-plugin-prettier-vue](https://github.com/meteorlxy/eslint-plugin-prettier-vue) does for Prettier.

- The plugin formats Vue SFCs block by block. You can turn `<template>`, `<script>`, `<style>` and custom blocks on or off.
- The plugin finds oxfmt config files the same way that the oxfmt CLI does. For each file, it uses the nearest `.oxfmtrc.json`, `.oxfmtrc.jsonc`, `oxfmt.config.ts` or `oxfmt.config.mts`. It also applies `overrides`, `associations` and `.editorconfig`.
- ESLint's cache stays correct. If you edit an oxfmt config file or `.editorconfig`, or upgrade oxfmt, ESLint lints the cached files again. See [Caching](#caching).

## Requirements

- Node.js `^22.13.0 || >=24`
- ESLint `^9.5.0 || ^10.0.0`, flat config only
- oxfmt `>=0.79.0`

## Install

```sh
pnpm add -D eslint-plugin-oxfmt-vue oxfmt
```

## Usage

```ts
// eslint.config.ts
import pluginOxfmtVue from 'eslint-plugin-oxfmt-vue'

export default [
  // ...other configs, with a parser for every file type you want to format
  pluginOxfmtVue.createConfig({
    root: import.meta.dirname,
    sfcBlocks: { template: false },
  }),
]
```

`pluginOxfmtVue.configs.recommended` is `createConfig()` with the default options. Its root is `process.cwd()`. Tools such as `@eslint/config-inspector` show it as `oxfmt-vue/recommended`. They show a config from `createConfig()` as `oxfmt-vue/config`.

ESLint lints a file only when a config gives it a parser. To format JSON, YAML, Markdown or CSS, add a parser for them, such as `jsonc-eslint-parser`, `yaml-eslint-parser` or [`eslint-parser-plain`](https://github.com/so1ve/eslint-parser-plain).

ESLint reports each difference from the oxfmt output. In the messages, `·` is a space and `⏎` is a line break. With the config above, the `<template>` block stays as it is:

```
src/Hello.vue
   2:13  error  Replace `"hello";` with `'hello'`              oxfmt-vue/oxfmt
  10:2   error  Replace `{color:red` with `·{⏎··color:·red;⏎`  oxfmt-vue/oxfmt
```

Run `eslint --fix` to format the files.

### `createConfig(options)`

| Option        | Default             | Description                                                                                                                                                                                                                                                          |
| ------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`        | `process.cwd()`     | The project root. The plugin scans for config files from this directory. It also searches upward from it for `.editorconfig`, as the oxfmt CLI does from its current working directory.                                                                              |
| `files`       | every linted file   | `files` of the returned config.                                                                                                                                                                                                                                      |
| `sfcBlocks`   | all built-in blocks | The blocks of Vue SFCs that the plugin formats. See [`sfcBlocks`](#sfcblocks).                                                                                                                                                                                       |
| `scanIgnores` | `[]`                | Directories, relative to `root`, that the plugin does not scan for config files.                                                                                                                                                                                     |
| `cacheConfig` | `true`              | Whether the plugin caches config files for the lifetime of the process. If ESLint runs in a long-running process, such as an editor integration, turn it off. ESLint then reads config changes without a restart. When it is off, each file takes about 0.5 ms more. |

`createConfig()` validates every oxfmt config file of the project one time. If a file is not valid, it throws one error that lists all the problems. As a result, ESLint does not report the same error on every file. Like the oxfmt CLI, it also refuses a directory with more than one config file.

### `sfcBlocks`

```ts
{
  template: true,
  script: true,
  style: true,
  customBlocks: {
    // Format <i18n> blocks, as JSON when a block has no `lang`
    i18n: { lang: 'json' },
    // Leave <docs> blocks alone (the same as not listing them)
    docs: false,
  },
}
```

- The plugin never changes the start tags or their attributes, such as `setup`, `generic` and `scoped`. Fixes stay inside the content of a block.
- The plugin formats `<script>` and `<style>` as the language in their `lang` attribute, and the `vueIndentScriptAndStyle` option applies to them.
- The plugin formats a custom block as the language in its `lang` attribute. If the tag has no `lang`, it uses the `lang` in `customBlocks`.

## Other formatting rules

Do not use another formatter plugin, such as eslint-plugin-oxfmt or eslint-plugin-prettier, together with this plugin. The two plugins format the same files, and their reports conflict.

Turn off the ESLint rules that format code, such as the layout rules of eslint-plugin-vue. [`eslint-config-prettier`](https://github.com/prettier/eslint-config-prettier) turns off these rules. Put it after the configs that enable them.

If you set `template: false`, oxfmt does not format `<template>`. To let ESLint format it, enable the layout rules of eslint-plugin-vue again, such as `vue/html-indent`.

## Migrate from eslint-plugin-prettier-vue

1. In the directory of your Prettier config file, run `oxfmt --migrate=prettier`. The command writes an `.oxfmtrc.json`.
2. If you set Prettier options in the `prettier-vue/prettier` rule, move them to `.oxfmtrc.json`. This plugin reads formatting options only from oxfmt config files.
3. Move `settings['prettier-vue'].SFCBlocks` to the `sfcBlocks` option of `createConfig()`. The two options have the same shape.
4. If you set `fileInfoOptions.ignorePath`, put those patterns in ESLint's `ignores`.
5. Replace `plugin:prettier-vue/recommended` with `pluginOxfmtVue.createConfig()` in a flat config.
6. Remove the `eslint-plugin-prettier-vue` package.

The plugin always reads oxfmt config files, so `usePrettierrc` has no equivalent.

## Caching

`eslint --cache` stays correct. ESLint lints all files again when one of these items changes:

- An oxfmt config file under `root`, or in a directory above `root`
- The `.editorconfig` that the plugin finds upward from `root`
- The version of this plugin, oxfmt or `@vue/compiler-sfc`

The cache does not detect the changes that follow. After one of these changes, delete the ESLint cache file (`.eslintcache` by default):

- You edit a file that an `oxfmt.config.ts` imports.
- You edit a config file in a directory that `scanIgnores` lists.
- You edit a config file in a submodule or a worktree, and ESLint lints its files from the outer project.

## Differences from the oxfmt CLI

- ESLint decides which files to format. The plugin does not read `ignorePatterns` or `.prettierignore`. Use ESLint's `ignores` instead.
- If a custom block gets no `lang` from its tag or from `customBlocks`, the plugin formats it as Vue, as eslint-plugin-prettier-vue does. The Vue parser changes only its whitespace.

## Credits

- [eslint-plugin-prettier-vue](https://github.com/meteorlxy/eslint-plugin-prettier-vue) (MIT): how SFC blocks are split and formatted.
- [eslint-plugin-oxfmt](https://github.com/ntnyq/eslint-plugin-oxfmt) (MIT): how `overrides` and `associations` are applied, and [load-oxfmt-config](https://github.com/ntnyq/load-oxfmt-config), which finds config files.

## License

MIT
