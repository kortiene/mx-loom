/**
 * Conformance · Tier 0 — pin identity (single daemon). T007 / #7.
 *
 * The cheapest, most fundamental conformance check: the live daemon under test
 * **is** the pinned substrate. `daemon.status.version` must equal
 * `.mx-agent-version` (the single source of truth). A daemon that is not the
 * pinned version is itself drift → red, so the rest of the suite is never
 * interpreted against the wrong substrate.
 *
 * Also asserts the full `DaemonStatus` shape that `MxClient.status()` depends
 * on: every field the toolbelt types expect must be present and well-typed so
 * surface drift (a field renamed or dropped between daemon versions) is caught
 * here — not silently passed as a TypeScript `any`.
 *
 * Runs through the public toolbelt client (`createClient` → `MxClient.status`),
 * the same path real callers use — not a raw socket.
 *
 * @see ../../../docs/mx-agent-pin.md (the pin-bump gate)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';

import {
  CONFORMANCE_REQUIRED,
  DAEMON_REACHABLE,
  SECRET_PATTERN,
  SKIP_SINGLE_DAEMON,
  assertSingleDaemonPrereqs,
  normalizeVersion,
  readPinnedVersion,
} from './_harness.js';

describe.skipIf(SKIP_SINGLE_DAEMON)('conformance · Tier 0 — pin identity', () => {
  let client: MxClient;

  beforeAll(() => {
    // Fail-not-skip: under MXL_CONFORMANCE=1 a missing daemon is a HARD failure.
    assertSingleDaemonPrereqs();
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  it('daemon.status.version equals the pinned .mx-agent-version (a non-pinned daemon is drift)', async () => {
    const pin = readPinnedVersion();
    const status = await client.status({ timeoutMs: 30_000 });
    expect(typeof status.version).toBe('string');
    expect(normalizeVersion(status.version)).toBe(pin.normalized);
  });

  it('daemon.status returns the full DaemonStatus shape the toolbelt types depend on (field-level drift check)', async () => {
    // MxClient.status() is typed against DaemonStatus (src/ipc/types.ts). A field
    // rename or removal between daemon versions is a TypeScript non-error (the cast
    // is `as DaemonStatus`) but a runtime drift that the rest of the suite would
    // interpret against wrong field names. This test catches that drift at the
    // boundary before the rest of the suite runs.
    const status = await client.status({ timeoutMs: 30_000 });

    // running: the daemon the suite tests against must be up.
    expect(status.running).toBe(true);

    // pid: a positive integer — the live process id.
    expect(typeof status.pid).toBe('number');
    expect(Number.isInteger(status.pid)).toBe(true);
    expect(status.pid).toBeGreaterThan(0);

    // uptime_seconds: non-negative float.
    expect(typeof status.uptime_seconds).toBe('number');
    expect(status.uptime_seconds).toBeGreaterThanOrEqual(0);

    // socket_path: non-empty string.
    expect(typeof status.socket_path).toBe('string');
    expect(status.socket_path.length).toBeGreaterThan(0);

    // version: already checked above; just assert presence here.
    expect(typeof status.version).toBe('string');
    expect(status.version.length).toBeGreaterThan(0);

    // sync: present and well-typed (the daemon logs this when healthy).
    if (status.sync !== undefined) {
      expect(typeof status.sync.state).toBe('string');
      expect(typeof status.sync.total_syncs).toBe('number');
      expect(typeof status.sync.consecutive_failures).toBe('number');
      // A healthy daemon must not show consecutive failures at suite start.
      expect(status.sync.consecutive_failures).toBe(0);
    }

    // Secret boundary: daemon.status is operational metadata; no token-shaped
    // value should appear in the response (consistent with the Tier 1 check).
    expect(JSON.stringify(status)).not.toMatch(SECRET_PATTERN);
  });

  it('the conformance gate is wired correctly (flag + reachability are consistent)', () => {
    // A guard on the harness itself: if the daemon is reachable OR conformance is
    // required, this tier must be running (not skipped). If neither holds, the
    // describe.skipIf above would have skipped this block, so reaching here means
    // at least one is true.
    expect(CONFORMANCE_REQUIRED || DAEMON_REACHABLE).toBe(true);
  });
});
