import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The jsdom environment is the suite's largest cost: it was created once
    // per test file, which meant twenty-one of them. The `vmThreads` pool
    // creates it once per worker instead, while still isolating the files
    // from each other — the isolation `isolate: false` would give up is
    // what keeps a module-level mock in one file out of the next.
    pool: 'vmThreads',
  },
});
