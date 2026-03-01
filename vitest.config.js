import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/services/firebase.js'],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});
