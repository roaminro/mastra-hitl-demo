import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Real-LLM tests delegate, suspend for approval, then resume — allow time.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
