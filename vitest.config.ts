import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/worker/**', 'node_modules/**'],
    environment: 'node',
    silent: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
