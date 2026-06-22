import { defineConfig } from 'vitest/config';

/**
 * The registry is a fully static, pure-metadata module (T101): its tests need
 * no daemon, no socket, and no env gating — they are plain unit tests. A single
 * default config is all this package needs (no conformance tier here).
 */
export default defineConfig({
  test: {},
});
