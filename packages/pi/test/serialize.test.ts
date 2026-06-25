/**
 * Envelope serializer (T205) — all five statuses, field preservation, no failure flag.
 *
 * Tests:
 *  - All five statuses (ok, running, awaiting_approval, denied, error) each produce
 *    an AgentToolResult with the full envelope in BOTH content[0].text AND details.
 *  - `denied` / `running` / `awaiting_approval` are NOT failures (no error flag or
 *    terminate flag set); only `status:"error"` carries an error-code.
 *  - `handle` is present in both channels for running/awaiting_approval.
 *  - `approval` fields (request_id, risk, summary, expires_at) are in both channels
 *    for awaiting_approval.
 *  - `error.code` from the closed taxonomy is preserved in both channels for denied/error.
 *  - All DENIAL_CODES produce a complete envelope in both channels.
 *  - All FAULT_CODES produce a complete envelope in both channels.
 *  - `audit_ref` is always present (including the all-null EMPTY_AUDIT_REF).
 *  - content[0].text is valid JSON that equals details.
 *  - `terminate` is never set (no mx-loom verb ends a Pi turn).
 */
import { describe, expect, it } from 'vitest';

import {
  DENIAL_CODES,
  FAULT_CODES,
  type AuditRef,
  awaitingApproval,
  denied,
  errored,
  ok,
  running,
} from '@mx-loom/registry';

import { serializePiToolResult } from '../src/serialize.js';

const AUDIT: AuditRef = {
  invocation_id: 'inv_ser',
  request_id: 'req_ser',
  room: '!room:server',
  event_id: '$evt_ser',
};

const EMPTY_AUDIT: AuditRef = Object.freeze({
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
});

// ---------------------------------------------------------------------------
// All five statuses — envelope in both content and details; no failure flag
// ---------------------------------------------------------------------------

const STATUS_CASES = [
  { name: 'ok', result: ok({ value: 42 }, AUDIT) },
  { name: 'running', result: running('inv_handle_1', AUDIT) },
  {
    name: 'awaiting_approval',
    result: awaitingApproval(
      'inv_handle_2',
      { request_id: 'req_ap', risk: 'high', summary: 'approval needed', expires_at: '2099-01-01T00:00:00Z' },
      AUDIT,
    ),
  },
  { name: 'denied', result: denied('policy_denied', 'not allowlisted', AUDIT) },
  { name: 'error', result: errored('timeout', 'daemon timed out', AUDIT) },
];

describe('all five statuses: envelope in content[0].text and details', () => {
  it.each(STATUS_CASES)('$name: details matches the envelope', ({ result }) => {
    const out = serializePiToolResult(result);
    const details = out.details as Record<string, unknown>;
    expect(details['status']).toBe(result.status);
    expect(details['result']).toEqual(result.result);
    expect(details['error']).toEqual(result.error);
    expect(details['handle']).toEqual(result.handle);
    expect(details['approval']).toEqual(result.approval);
    expect(details['audit_ref']).toEqual(result.audit_ref);
  });

  it.each(STATUS_CASES)('$name: content[0].text is valid JSON equal to details', ({ result }) => {
    const out = serializePiToolResult(result);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]?.type).toBe('text');
    const fromText = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
    expect(fromText).toEqual(out.details);
  });

  it.each(STATUS_CASES)('$name: terminate is not set', ({ result }) => {
    const out = serializePiToolResult(result);
    expect(out.terminate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Specific status field checks
// ---------------------------------------------------------------------------

describe('running: handle is present in both channels', () => {
  it('handle field is set in details and content[0].text', () => {
    const out = serializePiToolResult(running('inv_running_42', AUDIT));
    const details = out.details as { status: string; handle: string };
    expect(details.status).toBe('running');
    expect(details.handle).toBe('inv_running_42');
    const fromText = JSON.parse(out.content[0]!.text) as { handle: string };
    expect(fromText.handle).toBe('inv_running_42');
  });
});

describe('awaiting_approval: handle + approval in both channels', () => {
  it('status is awaiting_approval with handle and approval object', () => {
    const approval = {
      request_id: 'req_ap_2',
      risk: 'medium' as const,
      summary: 'needs review',
      expires_at: '2099-12-31T00:00:00Z',
    };
    const result = awaitingApproval('inv_ap_2', approval, AUDIT);
    const out = serializePiToolResult(result);
    const details = out.details as {
      status: string;
      handle: string;
      approval: { request_id: string; risk: string };
    };
    expect(details.status).toBe('awaiting_approval');
    expect(details.handle).toBe('inv_ap_2');
    expect(details.approval.request_id).toBe('req_ap_2');
    expect(details.approval.risk).toBe('medium');

    const fromText = JSON.parse(out.content[0]!.text) as { approval: { request_id: string } };
    expect(fromText.approval.request_id).toBe('req_ap_2');
  });
});

describe('denied: error.code is preserved (not mapped to failure flag)', () => {
  it('policy_denied: status denied, error.code policy_denied, no terminate', () => {
    const out = serializePiToolResult(denied('policy_denied', 'not allowed', AUDIT));
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('denied');
    expect(d.error.code).toBe('policy_denied');
    expect(out.terminate).toBeUndefined();
  });

  it('untrusted_key: status denied, error.code untrusted_key', () => {
    const out = serializePiToolResult(denied('untrusted_key', 'key not in trust store', AUDIT));
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('denied');
    expect(d.error.code).toBe('untrusted_key');
  });
});

describe('error: fault code preserved in both channels', () => {
  it('timeout: status error, error.code timeout', () => {
    const out = serializePiToolResult(errored('timeout', 'timed out', AUDIT));
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('timeout');
    const fromText = JSON.parse(out.content[0]!.text) as { error: { code: string } };
    expect(fromText.error.code).toBe('timeout');
  });

  it('invalid_args: status error, error.code invalid_args', () => {
    const out = serializePiToolResult(errored('invalid_args', 'bad args', AUDIT));
    const d = out.details as { error: { code: string } };
    expect(d.error.code).toBe('invalid_args');
  });
});

// ---------------------------------------------------------------------------
// All DENIAL_CODES and FAULT_CODES — envelope is complete in both channels
// ---------------------------------------------------------------------------

describe('all DENIAL_CODES: envelope in both channels, status denied', () => {
  it.each(DENIAL_CODES)('%s: details carries complete envelope', (code) => {
    const out = serializePiToolResult(denied(code, `denial for ${code}`, AUDIT));
    const d = out.details as { status: string; error: { code: string }; audit_ref: unknown };
    expect(d.status).toBe('denied');
    expect(d.error.code).toBe(code);
    expect(d.audit_ref).toEqual(AUDIT);
    expect(JSON.parse(out.content[0]!.text)).toEqual(d);
  });
});

describe('all FAULT_CODES: envelope in both channels, status error', () => {
  it.each(FAULT_CODES)('%s: details carries complete envelope', (code) => {
    const out = serializePiToolResult(errored(code, `fault for ${code}`, AUDIT));
    const d = out.details as { status: string; error: { code: string }; audit_ref: unknown };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe(code);
    expect(d.audit_ref).toEqual(AUDIT);
    expect(JSON.parse(out.content[0]!.text)).toEqual(d);
  });
});

// ---------------------------------------------------------------------------
// audit_ref — always present, including the all-null EMPTY_AUDIT_REF
// ---------------------------------------------------------------------------

describe('audit_ref: always present', () => {
  it('non-null audit_ref is preserved in details', () => {
    const out = serializePiToolResult(ok({ x: 1 }, AUDIT));
    expect((out.details as { audit_ref: AuditRef }).audit_ref).toEqual(AUDIT);
  });

  it('all-null EMPTY_AUDIT_REF round-trips through both channels', () => {
    const out = serializePiToolResult(errored('not_found', 'unknown', EMPTY_AUDIT));
    const d = out.details as { audit_ref: AuditRef };
    expect(d.audit_ref).toEqual(EMPTY_AUDIT);
    const fromText = JSON.parse(out.content[0]!.text) as { audit_ref: AuditRef };
    expect(fromText.audit_ref).toEqual(EMPTY_AUDIT);
  });
});
