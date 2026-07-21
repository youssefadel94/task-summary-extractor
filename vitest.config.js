import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    // Some tests spawn real subprocesses (ffmpeg for the video/media suites,
    // Chromium for the PDF renderer). Bounding the worker pool keeps good
    // parallelism for the fast tests while preventing many heavy subprocesses
    // from oversubscribing the CPU and crashing workers under load.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 6, minForks: 1 } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/services/firebase.js'],
      // Ratchet thresholds: set just below current coverage (~58%) so the suite
      // guards against regressions. Raise these as coverage climbs.
      thresholds: { lines: 55, functions: 55, branches: 45 },
    },
  },
});
