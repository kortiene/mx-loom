import { defineConfig } from 'vitest/config';

/**
 * The GOLDEN end-to-end config (T114) — selected via `pnpm test:e2e`.
 *
 * Includes ONLY `test/**\/*.e2e.test.ts` — the cross-binding golden arms (MCP +
 * Claude shim), the audit arm, the T201 ADK MCPToolset acceptance arm, the T202
 * ADK LongRunningFunctionTool acceptance arm, and the T204 Pi capability smoke.
 * The golden arms gate themselves on the same env contract as the conformance harness
 * (`MXL_CONFORMANCE_TWO_DAEMON` + `MXL_CONFORMANCE_GOLDEN_POLICY` + fixture
 * coordinates, see `test/_golden-harness.ts`); the ADK arms are additionally opted in
 * with `MXL_ADK_MCP_E2E=1` / `MXL_ADK_LONG_RUNNING_E2E=1` and a real `google-adk` install:
 *   - no flag + no daemon → clean skip (harmless locally; never blocks a PR);
 *   - `MXL_CONFORMANCE_TWO_DAEMON=1` + no daemon → hard failure (the M1-exit gate).
 * The Pi smoke has its own optional fail-not-skip flag, `MXL_PI_CAPABILITY_E2E=1`,
 * and otherwise skips when no `@earendil-works/pi-coding-agent` package is available.
 *
 * Timeouts are generous and files run serially: each held step waits for the
 * out-of-band operator decision plus the daemon's re-authorize-at-release, and the
 * live daemon must not be overwhelmed with concurrent room/state events.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
