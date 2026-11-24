import { defineConfig } from 'tsdown'

import type { UserConfig } from 'tsdown'

const shared: UserConfig = { format: 'esm', platform: 'node' }

// Separate builds keep the worker out of the declaration output, because
// `exports` does not expose it
export default defineConfig([
  { ...shared, entry: 'src/index.ts', dts: { generator: 'tsrs' } },
  { ...shared, entry: 'src/worker.ts', dts: false },
])
