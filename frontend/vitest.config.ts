import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Security-rules tests need the Firestore emulator — run them with `pnpm run test:rules`
    exclude: [...configDefaults.exclude, 'tests/rules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'src/components/ui/**', // shadcn components — not hand-authored
        '**/*.d.ts',
        '**/*.config.*',
        'src/app/**', // pages tested via E2E, not unit tests
      ],
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
})
