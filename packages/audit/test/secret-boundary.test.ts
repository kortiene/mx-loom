/**
 * Secret-subset guarantee (T113 / #21) — design §4.7/§6, mx-loom invariant.
 *
 * The mirror stores a strict NON-SECRET subset of the envelope. These tests pin
 * that structurally: even when the envelope's `result` payload, `error.message`,
 * and `approval.summary` are stuffed with token-shaped values, no projected row
 * column carries them — because the projection never reads those fields. They
 * also pin that a sink-failure log never leaks the DSN.
 */
import { describe, expect, it } from 'vitest';

import { awaitingApproval, denied, ok, type ApprovalInfo, type AuditRef } from '@mx-loom/registry';

import { auditRowFrom, logAuditFailure, withAudit, type AuditContext, type AuditSink } from '../src/index.js';

// A battery of well-known secret-value shapes (GitHub, Matrix, Slack, Anthropic,
// OpenAI, AWS, PEM). None of these may ever appear in a row.
const SECRETS = [
  'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
  'github_pat_11ABCDEF0123456789_abcdefghijklmnop',
  'syt_dXNlcg_abcdefghijklmnop_0a1b2c',
  'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AKIAIOSFODNN7EXAMPLE',
  '-----BEGIN RSA PRIVATE KEY-----',
];

const REF: AuditRef = { invocation_id: 'inv_1', request_id: 'req_1', room: '!r:s', event_id: '$e' };
const CTX: AuditContext = { tool_name: 'mx_delegate_tool', call_id: 'c1', correlation_id: 'corr_1', idempotency_key: 'idk_1' };

/** Every string-valued field of a row, flattened for inspection. */
function rowStrings(row: Record<string, unknown>): string[] {
  return Object.values(row).filter((v): v is string => typeof v === 'string');
}

describe('row never carries a secret-shaped value', () => {
  for (const secret of SECRETS) {
    it(`a result payload containing ${secret.slice(0, 8)}… never reaches a row column`, () => {
      const row = auditRowFrom(ok({ token: secret, nested: { k: secret } }, REF), CTX);
      for (const s of rowStrings(row as unknown as Record<string, unknown>)) {
        expect(s).not.toContain(secret);
      }
    });
  }

  it('error.message is never persisted (only the closed-set error_code is)', () => {
    const secret = SECRETS[0]!;
    const row = auditRowFrom(denied('policy_denied', `leaked: ${secret}`, REF), CTX);
    expect(row.error_code).toBe('policy_denied');
    for (const s of rowStrings(row as unknown as Record<string, unknown>)) {
      expect(s).not.toContain(secret);
    }
  });

  it('approval.summary is never persisted (only approval_request_id is)', () => {
    const secret = SECRETS[0]!;
    const approval: ApprovalInfo = { request_id: 'apr_1', risk: 'high', summary: `secret ${secret}`, expires_at: '2026-06-22T00:00:00Z' };
    const row = auditRowFrom(awaitingApproval('h', approval, REF), CTX);
    expect(row.approval_request_id).toBe('apr_1');
    for (const s of rowStrings(row as unknown as Record<string, unknown>)) {
      expect(s).not.toContain(secret);
    }
  });

  it('the row has no result / error_message / approval_summary column at all', () => {
    const row = auditRowFrom(ok({ secret: SECRETS[0] }, REF), CTX);
    expect(row).not.toHaveProperty('result');
    expect(row).not.toHaveProperty('error_message');
    expect(row).not.toHaveProperty('approval_summary');
  });
});

describe('sink-failure logging never leaks the DSN', () => {
  it('logAuditFailure logs the failure class + dedup_key only', () => {
    const messages: string[] = [];
    const orig = console.warn;
    console.warn = (m?: unknown) => void messages.push(String(m));
    try {
      const dsn = 'postgres://user:s3cr3tpw@db:5432/audit';
      logAuditFailure(new Error(dsn), 'c1:ok:inv_1');
      for (const m of messages) {
        expect(m).not.toContain('s3cr3tpw');
        expect(m).not.toContain(dsn);
        expect(m).toContain('dedup_key=c1:ok:inv_1');
      }
    } finally {
      console.warn = orig;
    }
  });

  it('logAuditFailure does not throw on a non-Error value (string, object)', () => {
    const messages: string[] = [];
    const orig = console.warn;
    console.warn = (m?: unknown) => void messages.push(String(m));
    try {
      expect(() => logAuditFailure('plain string error', 'c2:error:inv_2')).not.toThrow();
      expect(() => logAuditFailure({ code: 42 }, 'c3:ok:∅')).not.toThrow();
      expect(() => logAuditFailure(undefined, 'c4:denied:inv_4')).not.toThrow();
      // non-Error values should still include the dedup_key
      expect(messages.some((m) => m.includes('dedup_key=c2:error:inv_2'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it('logAuditFailure does not throw on null (boundary of falsy non-Error values)', () => {
    const messages: string[] = [];
    const orig = console.warn;
    console.warn = (m?: unknown) => void messages.push(String(m));
    try {
      expect(() => logAuditFailure(null, 'c5:ok:∅')).not.toThrow();
      expect(messages.some((m) => m.includes('dedup_key=c5:ok:∅'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it('withAudit routes a sink throw through a secret-free logger', async () => {
    const dsn = 'postgres://user:s3cr3tpw@db:5432/audit';
    const throwing: AuditSink = { record: () => Promise.reject(new Error(dsn)) };
    const seen: Array<{ err: unknown; dedupKey: string }> = [];
    const tap = withAudit(throwing, { correlation_id: 'corr_1' }, (err, dedupKey) => seen.push({ err, dedupKey }));
    await tap(ok({}, REF), { tool_name: 'mx_delegate_tool', call_id: 'c1' });
    // The logger receives the dedup_key (secret-free); it is the logger's job to
    // not print the error verbatim — logAuditFailure prints only the class.
    expect(seen[0]?.dedupKey).toBe('c1:ok:inv_1');
  });
});
