import { defineConfig } from 'vitest/config'

/**
 * Smoke suite for the real plugin body: unlike `vitest.config.ts` (the fast,
 * pure-logic `tests/` suite) this one imports `src/index.ts` against a stubbed
 * cordis context and drives its HTTP route handler over a temporary harness
 * home. Run with `pnpm smoke` after `pnpm build`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.spec.ts'],
  },
})
