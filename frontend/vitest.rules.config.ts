import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * Firestore security-rules tests. They talk to the local Firestore emulator
 * (demo-* project, never production), so they run separately from the unit
 * tests: `pnpm run test:rules` from the repo root starts the emulator first.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.rules.test.ts'],
    // All files share one emulator database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
})
