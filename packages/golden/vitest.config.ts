import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Default (fast, daemon-free) config for `@mx-loom/golden`.
 *
 * The golden end-to-end arms (`*.e2e.test.ts`) need the live two-daemon fixture,
 * so they are **excluded** from the default `pnpm test` run and selected only by
 * `pnpm test:e2e` (see `vitest.e2e.config.ts`). What runs here is the daemon-free
 * gate-logic unit suite (`golden-harness.test.ts`) — the pure skip / fail-not-skip
 * decision the e2e gate relies on — so the wiring is verifiable on a developer
 * laptop and in fast CI without standing up a daemon pair.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.e2e.test.ts'],
  },
});
