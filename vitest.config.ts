import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@snow/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    /**
     * The netcode integration tests play whole matches -- up to 4000 ticks of six
     * players plus a host, over a virtual clock. None of that time is spent waiting:
     * it is simulation, so it scales with how loaded the machine is, and the default
     * 5s ceiling is a coin flip on a busy container rather than a real signal.
     *
     * Still bounded, because these tests drive their own clock: anything that misses
     * 30s is stuck, not slow.
     */
    testTimeout: 30_000,
  },
});
