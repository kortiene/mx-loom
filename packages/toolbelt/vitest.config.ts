import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Default vitest config for the fast unit/integration suite.
 *
 * The conformance suite (`test/conformance/**`, T007 / #7) is EXCLUDED here so
 * `pnpm test` stays daemon-free and fast — the live conformance tiers are run
 * separately via `pnpm test:conformance` (see `vitest.conformance.config.ts`).
 * The harness gate-logic unit test (`test/conformance-harness.test.ts`) lives
 * outside that dir, so it still runs here.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/conformance/**'],
  },
});
