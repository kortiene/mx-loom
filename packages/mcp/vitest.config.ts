import { defineConfig } from 'vitest/config';

/**
 * The MCP binding (T109) is generated from static descriptors and exercised
 * against an injected fake `DaemonCall` + the SDK's in-memory transport pair, so
 * its unit/integration tests need no daemon, no socket, and no env gating — a
 * single default config (mirroring `packages/claude`/`packages/registry`). The
 * live two-daemon MCP conformance arm + the stdio-bin integration land in the
 * dedicated tests phase, gated behind `MXL_CONFORMANCE_TWO_DAEMON=1`.
 */
export default defineConfig({
  test: {},
});
