import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // App-level suites start a full NorthstarApp (and the private lab folder when present);
    // under heavy machine load the default 10 s setup timeout made them flake as "skipped".
    hookTimeout: 60_000,
    testTimeout: 60_000,
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
