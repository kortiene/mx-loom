import { defineConfig } from 'vitest/config';

/**
 * The Pi binding (T205) is generated from static descriptors and exercised
 * against an injected fake `DaemonCall` + an ABI-shaped fake TypeBox builder set
 * (the spec's Testing Plan #8: "Use the Pi SDK if the peer is installed; otherwise
 * an ABI-shaped fake"), so its daemon-free unit/integration tests need no daemon,
 * no socket, no real Pi/TypeBox install, and no env gating — a single default
 * config (mirroring `packages/mcp`/`packages/claude`/`packages/registry`).
 *
 * The live "a Pi agent calls `mx_delegate_tool`" arm lands in `@mx-loom/golden`
 * (`test/t205-pi-binding.e2e.test.ts`, gated behind `MXL_PI_BINDING_E2E=1` + the
 * two-daemon flags) in the dedicated e2e phase.
 */
export default defineConfig({
  test: {},
});
