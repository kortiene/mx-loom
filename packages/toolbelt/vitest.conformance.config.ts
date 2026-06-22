import { defineConfig } from 'vitest/config';

/**
 * Conformance suite config (T007 / #7) — selected via `pnpm test:conformance`.
 *
 * Includes ONLY `test/conformance/**\/*.conformance.test.ts`, so the suite is
 * selectable independently of the fast `pnpm test` run. The tiers gate
 * themselves on `MXL_CONFORMANCE` / `MXL_CONFORMANCE_TWO_DAEMON` (see
 * `test/conformance/_harness.ts`):
 *   - no flag + no daemon → clean skip (harmless locally);
 *   - `MXL_CONFORMANCE=1` + no daemon → hard failure (the CI gate).
 *
 * Timeouts are generous and files run serially: `agent.register` waits for
 * Matrix `/sync` (~29s locally) and the live daemon must not be overwhelmed with
 * concurrent room/state events.
 */
export default defineConfig({
  test: {
    include: ['test/conformance/**/*.conformance.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
