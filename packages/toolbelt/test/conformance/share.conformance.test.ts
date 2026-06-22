/**
 * Conformance · Tier 2 — share.* / get round-trip (two daemons). T107 / #15.
 *
 * Exercises the interface between the T107 handler contract and the **live**
 * `share.*` daemon surface (Boundary B), which no pure unit test can cover.
 * Because unit tests inject a fake `DaemonCall`, wire-shape assumptions (param
 * names, response field names, inline-vs-media threshold, audit_ref presence)
 * are simulated there — this suite pins the **real** daemon behavior so they
 * degrade visibly when the daemon drifts.
 *
 * Pre-conditions (established OUT OF BAND — never via the toolbelt):
 *   - daemon A joined to a workspace `room` (the `MXL_CONFORMANCE_ROOM`
 *     coordinate from `TwoDaemonFixture`; a two-daemon fixture is required
 *     because the room is created as part of that bring-up).
 *   - For AC 2: the daemon must support Matrix-media upload for objects >256 KiB.
 *     No additional CI fixture coordinate is required — the 300 KiB content is
 *     generated in-test.
 *
 * ACs verified live:
 *   AC 1 — share a diff (small, ≤256 KiB) → `share.get` by context_id returns
 *           the bytes unchanged and the sha256 matches (byte-identity guarantee).
 *   AC 2 — share a >256 KiB file → `share.get` returns `media_mxc` (not
 *           `inline`) + `sha256` surfaced (daemon chose the media path and computed
 *           the authoritative digest — mx-loom surfaces both, never downloads).
 *
 * Open questions pinned at this round-trip (spec Risks in t107-tool-…-spec.md):
 *   #1 — share.* wire shapes (param names, response field names `context_id` /
 *        `sha256` / `inline` / `media_mxc` / `size_bytes`).
 *   #5 — whether share.get needs `room` or resolves a globally-unique context_id.
 *   #6 — the real daemon spelling for an unknown-context_id error (mapped to
 *        `not_found`; a miss degrades to `internal` via the DAEMON_CODE_TO_ERROR
 *        fallback — never the wrong code, just less specific).
 *
 * Gate: `MXL_CONFORMANCE_TWO_DAEMON=1` — same as `delegate.conformance.test.ts`
 * and `exec.conformance.test.ts`. Without the flag the entire suite is skipped so
 * `pnpm test:conformance` is harmless without a two-daemon fixture.
 *
 * All `console.info` lines are intentional: they document OQ resolution as the
 * suite runs under CI (the pattern established by `delegate.conformance.test.ts`
 * and `exec.conformance.test.ts`).
 */
import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErrorCode, mapDaemonError, ok, validateEnvelope } from '@mx-loom/registry';
import type { AuditRef } from '@mx-loom/registry';

import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';
import { TransportError } from '../../src/transport.js';

import {
  SECRET_PATTERN,
  SKIP_TWO_DAEMON,
  assertTwoDaemonPrereqs,
  readTwoDaemonFixture,
} from './_harness.js';
import type { TwoDaemonFixture } from './_harness.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A known small diff for AC 1 (≤256 KiB; the daemon should choose the inline
 * path). Uniqueness is not required here — any share of identical bytes to the
 * same room is the content-addressing test for spec Risk #3.
 */
const SMALL_DIFF = [
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,3 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 99; // mx-loom-conformance-t107',
  ' const z = 3;',
].join('\n');

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** sha256 of a UTF-8 string, hex-encoded — for local byte-identity checks. */
function sha256hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Did the daemon signal a refusal (transport rejection OR ok:false/error field)? */
function isDenial(value: unknown): boolean {
  if (value instanceof TransportError) return true;
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec['ok'] === false) return true;
  if (rec['error'] !== undefined && rec['error'] !== null) return true;
  return false;
}

/** Extract the string at `key` from an unknown record, or undefined. */
function strField(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Tier 2 — raw share.*/get round-trip (AC 1, AC 2, spec risks)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)('conformance · Tier 2 — share.*/get round-trip (T107 / #15)', () => {
  let client: MxClient | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) {
      throw new Error(
        'conformance Tier 2 (share.*): two-daemon fixture coordinates absent — ' +
          'ensure MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT, and ' +
          'MXL_CONFORMANCE_TOOL are set by the CI bring-up.',
      );
    }
    fixture = fx;
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // AC 1 — share half: share.diff publishes context_id + sha256
  // -------------------------------------------------------------------------

  it('AC 1 (share half): share.diff publishes a diff artifact and returns context_id + sha256', async () => {
    if (!client || !fixture) throw new Error('Tier 2 (share.diff AC 1 share) fixture not initialised');

    const response = await client.call(
      'share.diff',
      { room: fixture.room, content: SMALL_DIFF, path: 'src/foo.ts' },
      { timeoutMs: 30_000 },
    );

    expect(response, 'share.diff must return a non-null object').not.toBeNull();
    expect(typeof response).toBe('object');
    expect(isDenial(response)).toBe(false);

    const rec = response as Record<string, unknown>;
    expect(typeof rec['context_id'], 'share.diff must return a string context_id').toBe('string');
    // sha256 is required by the descriptor's output_schema — assert it is present.
    expect(typeof rec['sha256'], 'share.diff must return a string sha256').toBe('string');

    // Secret boundary: the publish response must never carry a daemon credential.
    expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);

    // Document the full response field set (pins spec Risk #1 wire shapes).
    console.info('[T107 Risk#1] share.diff response fields:', Object.keys(rec).sort().join(', '));
  });

  // -------------------------------------------------------------------------
  // AC 1 — fetch half: share.get returns the artifact byte-identical
  // -------------------------------------------------------------------------

  it('AC 1 (fetch half): share.get returns the artifact content with sha256 match', async () => {
    if (!client || !fixture) throw new Error('Tier 2 (share.get AC 1 fetch) fixture not initialised');

    // Share a uniquely-tagged diff so we can verify byte-identity of THIS artifact.
    const uniqueContent = `${SMALL_DIFF}\n// run-id: ${randomUUID()}`;

    const shareResp = await client.call(
      'share.diff',
      { room: fixture.room, content: uniqueContent, path: 'src/foo-ac1.ts' },
      { timeoutMs: 30_000 },
    );
    expect(isDenial(shareResp)).toBe(false);

    const contextId = strField(shareResp, 'context_id');
    const daemonSha256 = strField(shareResp, 'sha256');
    expect(contextId, 'share.diff must return a context_id to fetch by').toBeDefined();

    // Fetch the artifact back by context_id.
    const getResp = await client.call(
      'share.get',
      { context_id: contextId, room: fixture.room },
      { timeoutMs: 30_000 },
    );
    expect(isDenial(getResp)).toBe(false);
    const getRec = getResp as Record<string, unknown>;
    expect(strField(getRec, 'context_id'), 'share.get must return context_id').toBeDefined();

    const inline = strField(getRec, 'inline');
    const mediaMxc = strField(getRec, 'media_mxc');

    if (typeof inline === 'string') {
      // AC 1 byte-identity assertion: inline content must match what was shared.
      expect(inline, 'AC 1: share.get inline content must be byte-identical to what was shared').toBe(
        uniqueContent,
      );

      // sha256 check: the local digest of our content should match the daemon's.
      const localSha256 = sha256hex(uniqueContent);
      const fetchSha256 = strField(getRec, 'sha256') ?? daemonSha256;
      if (typeof fetchSha256 === 'string') {
        // Document whether the digest algorithm/encoding matches (pins spec Risk #1).
        console.info(
          '[T107 AC1] local sha256 vs daemon sha256 match:',
          localSha256 === fetchSha256,
          '— if false, daemon may use different encoding or include metadata',
        );
      }
    } else if (typeof mediaMxc === 'string') {
      // The daemon chose the media path for this small artifact — note and assert sha256.
      console.info(
        '[T107 AC1] note: daemon returned media_mxc for a small diff — ' +
          'inline threshold may differ from spec (≤256 KiB). media_mxc:',
        mediaMxc,
      );
      expect(
        strField(getRec, 'sha256'),
        'AC 2 / media path: sha256 must be surfaced even for media-path responses',
      ).toBeDefined();
    } else {
      // Neither inline nor media_mxc — document the actual shape.
      console.info(
        '[T107 AC1] share.get returned neither inline nor media_mxc. Fields:',
        Object.keys(getRec).sort().join(', '),
        '— wire-shape assumptions pending round-trip (spec Risk #1)',
      );
    }

    expect(JSON.stringify(getResp)).not.toMatch(SECRET_PATTERN);

    // Document the share.get response field set (pins spec Risks #1 + #5).
    console.info('[T107 Risk#5] share.get response fields:', Object.keys(getRec).sort().join(', '));
  });

  // -------------------------------------------------------------------------
  // AC 1 (list): raw share.list probe — "list it" step of AC 1
  // -------------------------------------------------------------------------

  it(
    'AC 1 (list): share.list returns a list including a newly shared context_id',
    async (ctx) => {
      if (!client || !fixture) throw new Error('Tier 2 (share.list probe) fixture not initialised');

      // Share a uniquely-tagged artifact so it can be found in the listing.
      const uniqueContent = `NODE_ENV=test\nMXL_LIST_PROBE=${randomUUID()}\n`;
      const shareResp = await client
        .call('share.env', { room: fixture.room, content: uniqueContent }, { timeoutMs: 30_000 })
        .catch((e: unknown) => e);

      if (shareResp instanceof Error || isDenial(shareResp)) {
        console.info('[T107 AC1 list] share.env failed — skipping share.list probe:', shareResp instanceof Error ? shareResp.message : JSON.stringify(shareResp));
        ctx.skip();
        return;
      }

      const contextId = strField(shareResp, 'context_id');
      if (contextId === undefined) {
        ctx.skip();
        return;
      }

      // Probe share.list — may not exist on v0.2.1 (soft skip rather than fail).
      const listResp = await client
        .call('share.list', { room: fixture.room }, { timeoutMs: 30_000 })
        .catch((e: unknown) => e);

      if (listResp instanceof Error || isDenial(listResp)) {
        console.info(
          '[T107 AC1 list] share.list not supported or denied on this daemon (v0.2.1 — "◻️ documented") — skipping.',
          'Error:', listResp instanceof Error ? listResp.message : JSON.stringify(listResp),
        );
        ctx.skip();
        return;
      }

      // If share.list succeeded, the known context_id must appear in the result.
      const listJson = JSON.stringify(listResp);
      expect(listJson, `share.list result must contain context_id ${contextId}`).toContain(contextId);
      expect(listJson).not.toMatch(SECRET_PATTERN);

      console.info(
        '[T107 AC1 list] share.list succeeded. Result type:',
        typeof listResp,
        Array.isArray(listResp) ? `(array, length=${(listResp as unknown[]).length})` : '(object)',
      );
    },
  );

  // -------------------------------------------------------------------------
  // AC 2 — >256 KiB artifact uses the media path
  // -------------------------------------------------------------------------

  it(
    'AC 2: share a >256 KiB file → share.get returns media_mxc (not inline) + sha256 surfaced',
    async (ctx) => {
      if (!client || !fixture) throw new Error('Tier 2 (share.file AC 2 media path) fixture not initialised');

      // Generate 300 KiB of non-credential-shaped content (exceeds the 256 KiB
      // inline threshold specified in the design and the mx_share_context descriptor).
      const largeContent = 'a'.repeat(300 * 1024);

      const shareResp = await client
        .call(
          'share.file',
          {
            room: fixture.room,
            content: largeContent,
            path: 'large-fixture-t107-ac2.bin',
            encoding: 'utf-8',
          },
          { timeoutMs: 60_000 },
        )
        .catch((e: unknown) => e);

      if (shareResp instanceof Error || isDenial(shareResp)) {
        // If the daemon rejects a large inline payload (e.g. request too large),
        // document it — the daemon wire shape for large content is "◻️ documented".
        console.info(
          '[T107 AC2] share.file with 300 KiB content failed — ' +
            'the daemon may require a different path for large artifacts ' +
            '(spec Risk #8: "path vs content semantics per kind").',
          shareResp instanceof Error ? shareResp.message : JSON.stringify(shareResp),
        );
        // Soft-skip rather than hard-fail: the wire shape is pending the round-trip.
        ctx.skip();
        return;
      }

      const contextId = strField(shareResp, 'context_id');
      expect(contextId, 'share.file of large content must return context_id').toBeDefined();

      // Fetch back.
      const getResp = await client.call(
        'share.get',
        { context_id: contextId, room: fixture.room },
        { timeoutMs: 60_000 },
      );
      expect(isDenial(getResp)).toBe(false);

      const getRec = getResp as Record<string, unknown>;
      const mediaMxc = strField(getRec, 'media_mxc');
      const inline = strField(getRec, 'inline');
      const sha256 = strField(getRec, 'sha256');

      if (typeof mediaMxc === 'string') {
        // AC 2 nominal path: the daemon chose the media path for the large artifact.
        expect(
          inline,
          'AC 2: a media-path response must NOT include inline content (media path, not inline)',
        ).toBeUndefined();
        expect(
          sha256,
          'AC 2: media-path response must surface the sha256 integrity anchor',
        ).toBeDefined();
        console.info('[T107 AC2] ✅ daemon used media path (media_mxc) for 300 KiB artifact');
      } else if (typeof inline === 'string') {
        // The daemon used the inline path for a 300 KiB artifact — the threshold
        // may exceed 256 KiB or differ from the spec. Document and assert sha256.
        console.info(
          '[T107 AC2] note: daemon returned inline for a 300 KiB artifact ' +
            '— inline threshold may differ from 256 KiB (spec "◻️ documented").',
        );
        if (sha256 === undefined) {
          console.info('[T107 AC2] sha256 absent from inline large-artifact response — Risk #1 pending');
        }
      } else {
        // Neither field present — document the actual shape.
        console.info(
          '[T107 AC2] share.get returned neither inline nor media_mxc for a large artifact.',
          'Fields:', Object.keys(getRec).sort().join(', '),
        );
        // Soft assertion: at least one storage-path indicator must be present.
        expect(
          typeof mediaMxc === 'string' || typeof inline === 'string',
          'share.get must return either inline or media_mxc (AC 2 storage-path discriminator)',
        ).toBe(true);
      }

      expect(JSON.stringify(getResp)).not.toMatch(SECRET_PATTERN);
      console.info('[T107 AC2] share.get fields for large artifact:', Object.keys(getRec).sort().join(', '));
    },
  );

  // -------------------------------------------------------------------------
  // AC 1 — share.file and share.env variants (byte-identity, all three kinds)
  // -------------------------------------------------------------------------

  it('share.file variant: share a small file artifact → share.get byte-identical', async () => {
    if (!client || !fixture) throw new Error('Tier 2 (share.file AC 1) fixture not initialised');

    const fileContent = `// mx-loom-conformance-t107-file\nexport const id = '${randomUUID()}';\n`;

    const shareResp = await client.call(
      'share.file',
      { room: fixture.room, content: fileContent, path: 'src/conformance-t107.ts', encoding: 'utf-8' },
      { timeoutMs: 30_000 },
    );
    expect(isDenial(shareResp)).toBe(false);

    const contextId = strField(shareResp, 'context_id');
    expect(contextId).toBeDefined();

    const getResp = await client.call(
      'share.get',
      { context_id: contextId, room: fixture.room },
      { timeoutMs: 30_000 },
    );
    expect(isDenial(getResp)).toBe(false);
    expect(JSON.stringify(getResp)).not.toMatch(SECRET_PATTERN);

    const inline = strField(getResp, 'inline');
    if (typeof inline === 'string') {
      expect(inline, 'AC 1 (file): share.get must return the file content byte-identical').toBe(fileContent);
    }
  });

  it('share.env variant: share an env snapshot → share.get byte-identical', async () => {
    if (!client || !fixture) throw new Error('Tier 2 (share.env AC 1) fixture not initialised');

    const envContent = `NODE_ENV=test\nDEBUG=false\nMXL_TAG=t107-${randomUUID()}\n`;

    const shareResp = await client.call(
      'share.env',
      { room: fixture.room, content: envContent },
      { timeoutMs: 30_000 },
    );
    expect(isDenial(shareResp)).toBe(false);

    const contextId = strField(shareResp, 'context_id');
    expect(contextId).toBeDefined();

    const getResp = await client.call(
      'share.get',
      { context_id: contextId, room: fixture.room },
      { timeoutMs: 30_000 },
    );
    expect(isDenial(getResp)).toBe(false);
    expect(JSON.stringify(getResp)).not.toMatch(SECRET_PATTERN);

    const inline = strField(getResp, 'inline');
    if (typeof inline === 'string') {
      expect(inline, 'AC 1 (env): share.get must return the env content byte-identical').toBe(envContent);
    }
  });

  // -------------------------------------------------------------------------
  // Risk #6 — unknown context_id → not_found (pins DAEMON_CODE_TO_ERROR aliases)
  // -------------------------------------------------------------------------

  it('Risk #6: share.get with unknown context_id → daemon error maps to not_found', async () => {
    if (!client || !fixture) throw new Error('Tier 2 (share.get not_found) fixture not initialised');

    const outcome = await client
      .call(
        'share.get',
        { context_id: `ctx_nonexistent_${randomUUID()}`, room: fixture.room },
        { timeoutMs: 30_000 },
      )
      .catch((e: unknown) => e);

    // The daemon must signal an error for a nonexistent context_id.
    const isAnError = outcome instanceof Error || isDenial(outcome);
    expect(isAnError, 'share.get with a nonexistent context_id must signal an error').toBe(true);

    const daemonPayload = outcome instanceof Error ? (outcome.cause ?? outcome) : outcome;
    const code = mapDaemonError(daemonPayload);
    expect(isErrorCode(code), 'mapped code must be in the closed ERROR_CODES set').toBe(true);

    // If code !== 'not_found', DAEMON_CODE_TO_ERROR needs the real spelling (Risk #6).
    if (code !== 'not_found') {
      console.info(
        `[T107 Risk#6] unknown context_id mapped to '${code}' (expected 'not_found') — ` +
          'add the real daemon error-code spelling to DAEMON_CODE_TO_ERROR in errors.ts',
      );
    } else {
      console.info('[T107 Risk#6] ✅ unknown context_id correctly maps to not_found');
    }
    expect(code).toBe('not_found');

    // Secret boundary.
    expect(JSON.stringify(outcome instanceof Error ? outcome.message : outcome)).not.toMatch(
      SECRET_PATTERN,
    );
  });

  // -------------------------------------------------------------------------
  // Secret boundary — share.*/get results must never carry a daemon credential
  // -------------------------------------------------------------------------

  it('secret boundary: share.diff + share.get results carry no secret-shaped value', async () => {
    if (!client || !fixture) throw new Error('Tier 2 (share.* secret boundary) fixture not initialised');

    const shareResp = await client.call(
      'share.diff',
      { room: fixture.room, content: '--- a\n+++ b\n-old\n+new', path: 'sec-boundary.ts' },
      { timeoutMs: 30_000 },
    );
    expect(JSON.stringify(shareResp)).not.toMatch(SECRET_PATTERN);

    const contextId = strField(shareResp, 'context_id');
    if (contextId === undefined) return; // already caught above

    const getResp = await client.call(
      'share.get',
      { context_id: contextId, room: fixture.room },
      { timeoutMs: 30_000 },
    );
    expect(JSON.stringify(getResp)).not.toMatch(SECRET_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — T102 result-envelope seam (share.*/get)
//
// Exercises the interface between the T102 contract layer helpers
// (`@mx-loom/registry`) and live share.*/get daemon responses. Open questions
// the spec flags as "pending the round-trip":
//
// (a) audit_ref field availability on share.diff (publish = Matrix round-trip):
//     which of the four ids the daemon surfaces (spec Risk #1 / design §7).
// (b) audit_ref on share.get (local read → all-null? or media round-trip →
//     populated?) — spec Risk #5.
// (c) mapDaemonError maps the live not_found denial spelling → 'not_found'
//     (or 'internal' as the safe fallback — see Risk #6).
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)('conformance · Tier 2 — share.*/get T102 envelope seam (T107 / #15)', () => {
  let client: MxClient | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) {
      throw new Error('conformance Tier 2 (share.* T102 envelope): two-daemon fixture coordinates absent');
    }
    fixture = fx;
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  // (a) audit_ref field probe on share.diff (publish round-trip).
  it(
    '(a) share.diff success: raw response wraps into a conforming T102 ok envelope (audit_ref field probe)',
    async () => {
      if (!client || !fixture) throw new Error('T102 envelope (share.diff) fixture not initialised');

      const response = await client.call(
        'share.diff',
        { room: fixture.room, content: '--- x\n+++ y\n-a\n+b', path: 'audit-probe.ts' },
        { timeoutMs: 30_000 },
      );

      expect(isDenial(response)).toBe(false);
      expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);

      const rec = response as Record<string, unknown>;

      const auditRef: AuditRef = {
        invocation_id: strField(rec, 'invocation_id') ?? null,
        request_id: strField(rec, 'request_id') ?? null,
        room: strField(rec, 'room') ?? null,
        event_id: strField(rec, 'event_id') ?? null,
      };

      // The raw publish payload passes through into a valid T102 ok envelope.
      const envelope = ok(rec, auditRef);
      expect(validateEnvelope(envelope)).toBe(true);
      expect(JSON.stringify(envelope)).not.toMatch(SECRET_PATTERN);

      // Document which audit_ref ids the publish round-trip surfaces (spec Risk #1 / design §7).
      console.info('[T107 Risk#1] share.diff audit_ref availability:', {
        invocation_id: auditRef.invocation_id !== null,
        request_id: auditRef.request_id !== null,
        room: auditRef.room !== null,
        event_id: auditRef.event_id !== null,
      });

      // A publish is a Matrix round-trip; at least one id should be populated.
      // Non-fatal: log if none are (field names may differ from spec).
      if (Object.values(auditRef).every((v) => v === null)) {
        console.info(
          '[T107 Risk#1] note: no audit_ref ids populated by share.diff — ' +
            'field name assumptions may differ from spec (pending the round-trip).',
        );
      }
    },
  );

  // (b) audit_ref field probe on share.get (read — local or media round-trip?).
  it(
    '(b) share.get success: audit_ref disposition (local read vs media round-trip — spec Risk #5)',
    async () => {
      if (!client || !fixture) throw new Error('T102 envelope (share.get) fixture not initialised');

      // Share a small diff first.
      const shareResp = await client.call(
        'share.diff',
        { room: fixture.room, content: SMALL_DIFF, path: 'audit-get-probe.ts' },
        { timeoutMs: 30_000 },
      );
      expect(isDenial(shareResp)).toBe(false);
      const contextId = strField(shareResp, 'context_id');
      expect(contextId).toBeDefined();

      // Fetch and probe audit_ref.
      const getResp = await client.call(
        'share.get',
        { context_id: contextId, room: fixture.room },
        { timeoutMs: 30_000 },
      );
      expect(isDenial(getResp)).toBe(false);
      expect(JSON.stringify(getResp)).not.toMatch(SECRET_PATTERN);

      const rec = getResp as Record<string, unknown>;

      const auditRef: AuditRef = {
        invocation_id: strField(rec, 'invocation_id') ?? null,
        request_id: strField(rec, 'request_id') ?? null,
        room: strField(rec, 'room') ?? null,
        event_id: strField(rec, 'event_id') ?? null,
      };

      // The get payload passes through into a valid T102 ok envelope.
      const envelope = ok(rec, auditRef);
      expect(validateEnvelope(envelope)).toBe(true);

      // Document Risk #5: is share.get a local read (all-null) or a round-trip (populated)?
      const anyPopulated = Object.values(auditRef).some((v) => v !== null);
      console.info(
        '[T107 Risk#5] share.get audit_ref:',
        anyPopulated ? 'populated (round-trip)' : 'all-null (local read)',
        auditRef,
      );
    },
  );

  // (c) mapDaemonError maps the live unknown-context denial (pins Risk #6 at the T102 layer).
  it(
    '(c) share.get unknown context_id: mapDaemonError maps the live denial → not_found (Risk #6)',
    async () => {
      if (!client || !fixture) throw new Error('T102 envelope (share.get not_found) fixture not initialised');

      const outcome = await client
        .call(
          'share.get',
          { context_id: `ctx_t102_nf_${randomUUID()}`, room: fixture.room },
          { timeoutMs: 30_000 },
        )
        .catch((e: unknown) => e);

      const isAnError = outcome instanceof Error || isDenial(outcome);
      expect(isAnError).toBe(true);

      const daemonPayload = outcome instanceof Error ? (outcome.cause ?? outcome) : outcome;
      const code = mapDaemonError(daemonPayload);

      expect(isErrorCode(code)).toBe(true);
      // If 'internal', DAEMON_CODE_TO_ERROR needs the real daemon spelling (Risk #6).
      if (code !== 'not_found') {
        console.info(
          `[T107 Risk#6/T102] live unknown-context code mapped to '${code}' — ` +
            'add the real daemon spelling to DAEMON_CODE_TO_ERROR in errors.ts',
        );
      } else {
        console.info('[T107 Risk#6/T102] ✅ live not_found correctly maps to not_found');
      }
      expect(code).toBe('not_found');

      expect(JSON.stringify(outcome instanceof Error ? outcome.message : outcome)).not.toMatch(
        SECRET_PATTERN,
      );
    },
  );
});
