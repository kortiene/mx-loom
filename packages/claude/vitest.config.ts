import { defineConfig } from 'vitest/config';

/**
 * The Claude binding's converter (T111) is a pure, synchronous, dependency-light
 * transformation of static descriptors — its tests need no daemon, no socket, and
 * no env gating, so a single default config is all this package needs (mirrors
 * `packages/registry/vitest.config.ts`). The Claude SDK e2e arrives with T110.
 */
export default defineConfig({
  test: {},
});
