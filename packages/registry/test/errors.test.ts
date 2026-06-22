/**
 * Closed error taxonomy + mappers (T102 / #10) — AC 2.
 *
 * Tests pin:
 * - ERROR_CODES is exactly the nine documented codes (closed-set regression).
 * - DENIAL_CODES ∪ FAULT_CODES partitions ERROR_CODES with no overlap or gap.
 * - isErrorCode accepts every code and rejects near-misses.
 * - mapTransportError is exhaustive over the full toolbelt TransportErrorCode set.
 * - mapDaemonError maps every known daemon identifier and falls back to 'internal'.
 *
 * Pure unit tests; no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import {
  DENIAL_CODES,
  ERROR_CODES,
  FAULT_CODES,
  isErrorCode,
  mapDaemonError,
  mapTransportError,
  type ErrorCode,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// ERROR_CODES closed-set — AC 2
// ---------------------------------------------------------------------------

describe('ERROR_CODES — closed set (AC 2)', () => {
  const EXPECTED = new Set([
    'policy_denied',
    'untrusted_key',
    'approval_denied',
    'approval_expired',
    'timeout',
    'not_found',
    'invalid_args',
    'target_offline',
    'internal',
  ]);

  it('contains exactly 9 codes', () => {
    expect(ERROR_CODES).toHaveLength(9);
  });

  it('contains exactly the documented nine codes (order-insensitive)', () => {
    expect(new Set(ERROR_CODES)).toEqual(EXPECTED);
  });

  it('contains no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('each code is a non-empty string', () => {
    for (const code of ERROR_CODES) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// DENIAL_CODES / FAULT_CODES — partition of ERROR_CODES
// ---------------------------------------------------------------------------

describe('DENIAL_CODES and FAULT_CODES partition ERROR_CODES', () => {
  it('DENIAL_CODES contains exactly 4 codes', () => {
    expect(DENIAL_CODES).toHaveLength(4);
  });

  it('FAULT_CODES contains exactly 5 codes', () => {
    expect(FAULT_CODES).toHaveLength(5);
  });

  it('DENIAL_CODES ∪ FAULT_CODES equals ERROR_CODES', () => {
    const union = new Set([...DENIAL_CODES, ...FAULT_CODES]);
    expect(union).toEqual(new Set(ERROR_CODES));
  });

  it('DENIAL_CODES ∩ FAULT_CODES is empty (no overlap)', () => {
    const denialSet = new Set<ErrorCode>(DENIAL_CODES);
    for (const code of FAULT_CODES) {
      expect(denialSet.has(code)).toBe(false);
    }
  });

  it('every code in DENIAL_CODES is in ERROR_CODES', () => {
    const allCodes = new Set(ERROR_CODES);
    for (const code of DENIAL_CODES) {
      expect(allCodes.has(code)).toBe(true);
    }
  });

  it('every code in FAULT_CODES is in ERROR_CODES', () => {
    const allCodes = new Set(ERROR_CODES);
    for (const code of FAULT_CODES) {
      expect(allCodes.has(code)).toBe(true);
    }
  });

  it('DENIAL_CODES contains the governance-denial codes', () => {
    const d = new Set(DENIAL_CODES);
    expect(d.has('policy_denied')).toBe(true);
    expect(d.has('untrusted_key')).toBe(true);
    expect(d.has('approval_denied')).toBe(true);
    expect(d.has('approval_expired')).toBe(true);
  });

  it('FAULT_CODES contains the operational-fault codes', () => {
    const f = new Set(FAULT_CODES);
    expect(f.has('timeout')).toBe(true);
    expect(f.has('not_found')).toBe(true);
    expect(f.has('invalid_args')).toBe(true);
    expect(f.has('target_offline')).toBe(true);
    expect(f.has('internal')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isErrorCode — runtime guard
// ---------------------------------------------------------------------------

describe('isErrorCode', () => {
  it('returns true for every documented error code', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code), `should accept: ${code}`).toBe(true);
    }
  });

  it('returns false for near-misses (wrong casing)', () => {
    expect(isErrorCode('POLICY_DENIED')).toBe(false);
    expect(isErrorCode('Internal')).toBe(false);
    expect(isErrorCode('TIMEOUT')).toBe(false);
  });

  it('returns false for strings not in the set', () => {
    expect(isErrorCode('denied')).toBe(false);
    expect(isErrorCode('cancelled')).toBe(false);
    expect(isErrorCode('rejected')).toBe(false);
    expect(isErrorCode('error')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });

  it('returns false for non-string inputs', () => {
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode({})).toBe(false);
    expect(isErrorCode([])).toBe(false);
    expect(isErrorCode(true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapTransportError — exhaustive over the toolbelt's TransportErrorCode set
//
// The `never`-default switch in errors.ts fails the BUILD if a new transport
// code is added without a mapping. These tests pin the current mapping so a
// future change is a deliberate, reviewed choice.
// ---------------------------------------------------------------------------

describe('mapTransportError — exhaustive mapping (AC 2)', () => {
  // Every transport code the toolbelt currently exposes. If the toolbelt adds
  // a new code, mapTransportError will fail to compile until it is handled —
  // and this table must then be extended here too.
  const TRANSPORT_CODES = [
    'not_running',
    'connect_failed',
    'timeout',
    'closed',
    'frame',
    'protocol',
    'rpc',
    'invalid_args',
  ] as const;

  it('maps every TransportErrorCode to a valid ErrorCode', () => {
    for (const code of TRANSPORT_CODES) {
      const mapped = mapTransportError(code);
      expect(isErrorCode(mapped), `${code} → '${mapped}' must be a valid ErrorCode`).toBe(true);
    }
  });

  it('maps timeout → timeout (1:1)', () => {
    expect(mapTransportError('timeout')).toBe('timeout');
  });

  it('maps invalid_args → invalid_args (1:1)', () => {
    expect(mapTransportError('invalid_args')).toBe('invalid_args');
  });

  it('maps not_running → internal (local fabric unreachable)', () => {
    expect(mapTransportError('not_running')).toBe('internal');
  });

  it('maps connect_failed → internal (local fabric fault)', () => {
    expect(mapTransportError('connect_failed')).toBe('internal');
  });

  it('maps closed → internal (connection dropped before response)', () => {
    expect(mapTransportError('closed')).toBe('internal');
  });

  it('maps frame → internal (malformed wire frame)', () => {
    expect(mapTransportError('frame')).toBe('internal');
  });

  it('maps protocol → internal (invalid JSON-RPC envelope)', () => {
    expect(mapTransportError('protocol')).toBe('internal');
  });

  it('maps rpc → internal (daemon error object — use mapDaemonError for specificity)', () => {
    expect(mapTransportError('rpc')).toBe('internal');
  });

  it('never maps a transport code to target_offline (that is a daemon-level outcome)', () => {
    for (const code of TRANSPORT_CODES) {
      expect(mapTransportError(code)).not.toBe('target_offline');
    }
  });

  it('never maps a transport code to a denial code', () => {
    const denialSet = new Set(DENIAL_CODES);
    for (const code of TRANSPORT_CODES) {
      expect(denialSet.has(mapTransportError(code) as (typeof DENIAL_CODES)[number])).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// mapDaemonError — known codes + internal fallback
// ---------------------------------------------------------------------------

describe('mapDaemonError — daemon code mapping', () => {
  it('returns a valid ErrorCode for a null input', () => {
    expect(isErrorCode(mapDaemonError(null))).toBe(true);
  });

  it('returns internal for null (no code extractable)', () => {
    expect(mapDaemonError(null)).toBe('internal');
  });

  it('returns internal for undefined', () => {
    expect(mapDaemonError(undefined)).toBe('internal');
  });

  it('returns internal for an empty object', () => {
    expect(mapDaemonError({})).toBe('internal');
  });

  it('returns internal for a completely unknown string code', () => {
    expect(mapDaemonError('TOTALLY_UNKNOWN_CODE_XYZ')).toBe('internal');
  });

  it('never throws regardless of input', () => {
    const weirdInputs = [null, undefined, '', {}, [], 42, true, { code: 42 }, { error: null }, { data: { code: false } }];
    for (const input of weirdInputs) {
      expect(() => mapDaemonError(input)).not.toThrow();
    }
  });

  it('always returns a valid ErrorCode', () => {
    const inputs = [null, undefined, '', 'policy_denied', 'unknown', { error: { code: 'untrusted_key' } }, { code: 'timeout' }];
    for (const input of inputs) {
      expect(isErrorCode(mapDaemonError(input))).toBe(true);
    }
  });

  // Governance denial codes.
  it('maps "policy_denied" string → policy_denied', () => {
    expect(mapDaemonError('policy_denied')).toBe('policy_denied');
  });

  it('maps "denied_by_policy" → policy_denied', () => {
    expect(mapDaemonError('denied_by_policy')).toBe('policy_denied');
  });

  it('maps "policy" → policy_denied', () => {
    expect(mapDaemonError('policy')).toBe('policy_denied');
  });

  it('maps "untrusted_key" → untrusted_key', () => {
    expect(mapDaemonError('untrusted_key')).toBe('untrusted_key');
  });

  it('maps "untrusted" → untrusted_key', () => {
    expect(mapDaemonError('untrusted')).toBe('untrusted_key');
  });

  it('maps "unknown_key" → untrusted_key', () => {
    expect(mapDaemonError('unknown_key')).toBe('untrusted_key');
  });

  it('maps "approval_denied" → approval_denied', () => {
    expect(mapDaemonError('approval_denied')).toBe('approval_denied');
  });

  it('maps "approval_rejected" → approval_denied', () => {
    expect(mapDaemonError('approval_rejected')).toBe('approval_denied');
  });

  it('maps "approval_expired" → approval_expired', () => {
    expect(mapDaemonError('approval_expired')).toBe('approval_expired');
  });

  it('maps "approval_timeout" → approval_expired', () => {
    expect(mapDaemonError('approval_timeout')).toBe('approval_expired');
  });

  // Operational fault codes.
  it('maps "timeout" → timeout', () => {
    expect(mapDaemonError('timeout')).toBe('timeout');
  });

  it('maps "not_found" → not_found', () => {
    expect(mapDaemonError('not_found')).toBe('not_found');
  });

  it('maps "unknown_agent" → not_found', () => {
    expect(mapDaemonError('unknown_agent')).toBe('not_found');
  });

  it('maps "unknown_tool" → not_found', () => {
    expect(mapDaemonError('unknown_tool')).toBe('not_found');
  });

  it('maps "no_such_invocation" → not_found', () => {
    expect(mapDaemonError('no_such_invocation')).toBe('not_found');
  });

  it('maps "invalid_args" → invalid_args', () => {
    expect(mapDaemonError('invalid_args')).toBe('invalid_args');
  });

  it('maps "invalid_arguments" → invalid_args', () => {
    expect(mapDaemonError('invalid_arguments')).toBe('invalid_args');
  });

  it('maps "invalid_params" → invalid_args', () => {
    expect(mapDaemonError('invalid_params')).toBe('invalid_args');
  });

  it('maps "target_offline" → target_offline', () => {
    expect(mapDaemonError('target_offline')).toBe('target_offline');
  });

  it('maps "agent_offline" → target_offline', () => {
    expect(mapDaemonError('agent_offline')).toBe('target_offline');
  });

  it('maps "offline" → target_offline', () => {
    expect(mapDaemonError('offline')).toBe('target_offline');
  });

  it('maps "unreachable" → target_offline', () => {
    expect(mapDaemonError('unreachable')).toBe('target_offline');
  });

  it('maps "internal" → internal', () => {
    expect(mapDaemonError('internal')).toBe('internal');
  });

  // Code extraction from various object shapes.
  it('extracts code from a CallResponse{ok:false, error:{code}} shape', () => {
    expect(mapDaemonError({ error: { code: 'policy_denied' } })).toBe('policy_denied');
  });

  it('extracts code from a JSON-RPC error {code, message, data} shape with string data', () => {
    expect(mapDaemonError({ code: -32600, message: 'err', data: 'untrusted_key' })).toBe('untrusted_key');
  });

  it('extracts code from a JSON-RPC error {data:{code}} shape', () => {
    expect(mapDaemonError({ code: -32600, message: 'err', data: { code: 'not_found' } })).toBe('not_found');
  });

  it('extracts a top-level string code field', () => {
    expect(mapDaemonError({ code: 'timeout' })).toBe('timeout');
  });

  // Normalisation: dot-separated codes and uppercase snake_case.
  it('normalises "POLICY_DENIED" (uppercase snake_case) → policy_denied', () => {
    // Lowercasing makes "POLICY_DENIED" → "policy_denied" → matches the table.
    expect(mapDaemonError('POLICY_DENIED')).toBe('policy_denied');
  });

  it('normalises "policy.denied" (dot separator) → policy_denied', () => {
    // Non-alphanumeric chars (the dot) are replaced with `_` → "policy_denied".
    expect(mapDaemonError('policy.denied')).toBe('policy_denied');
  });

  it('normalises "APPROVAL_EXPIRED" (uppercase) → approval_expired', () => {
    expect(mapDaemonError('APPROVAL_EXPIRED')).toBe('approval_expired');
  });

  it('maps "trust_denied" → untrusted_key (synonym in the daemon table)', () => {
    expect(mapDaemonError('trust_denied')).toBe('untrusted_key');
  });

  it('extracts code when the "error" field is a direct string ({ error: "code" } shape)', () => {
    // extractDaemonCode: `typeof err === 'string'` branch — distinct from the
    // `{ error: { code } }` (object) shape that is already tested above.
    expect(mapDaemonError({ error: 'policy_denied' })).toBe('policy_denied');
    expect(mapDaemonError({ error: 'untrusted_key' })).toBe('untrusted_key');
    expect(mapDaemonError({ error: 'target_offline' })).toBe('target_offline');
  });

  it('normalises "policy--denied" (multiple consecutive dashes) → policy_denied', () => {
    // /[^a-z0-9]+/g collapses "--" to a single "_", producing "policy_denied".
    expect(mapDaemonError('policy--denied')).toBe('policy_denied');
  });

  it('normalises "approval..expired" (dot-dot separator) → approval_expired', () => {
    expect(mapDaemonError('approval..expired')).toBe('approval_expired');
  });

  it('returns internal for an array input (arrays are objects but lack the expected code fields)', () => {
    expect(mapDaemonError(['policy_denied'])).toBe('internal');
  });

  it('returns internal when data.code is a number rather than a string', () => {
    // extractDaemonCode: `typeof dataCode === 'string'` guard rejects numeric codes.
    expect(mapDaemonError({ code: -32600, message: 'err', data: { code: 42 } })).toBe('internal');
  });

  it('returns internal when the top-level code field is a number (not a string)', () => {
    // The check is `typeof obj.code === 'string'`, so numeric JSON-RPC codes alone
    // yield internal; a string daemon code in `data` is still extractable separately.
    expect(mapDaemonError({ code: -32600, message: 'err' })).toBe('internal');
  });
});
