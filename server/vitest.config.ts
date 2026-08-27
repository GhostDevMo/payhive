import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One database, so files must not race each other. Correctness of the
    // concurrency tests depends on this being off.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./tests/setup.ts'],
    env: {
      NODE_ENV: 'test',
      PAYMENT_PROVIDER: 'mock',
    },
  },
});
