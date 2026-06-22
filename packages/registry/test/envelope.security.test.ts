/**
 * Security invariants for the T102 envelope contract (design §4.7, §6).
 *
 * Tests pin:
 * - Mutating descriptors (mx_delegate_tool, mx_run_command) declare
 *   idempotency_key; read/sync verbs do NOT.
 * - The registry loads clean with idempotency_key present (field passes the
 *   secret-free-shape check enforced at construction).
 * - No envelope field name is credential-shaped.
 * - A constructed envelope round-trips through the toolbelt's redactSecrets
 *   guard unchanged (no false-positive redaction of audit_ref ids or result).
 * - Approval block confers no authority: it has no approve/decide field.
 *
 * Pure unit tests; no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { assertNoCredentialShapedArgs, CREDENTIAL_KEY_RE, redactSecrets } from '@mx-loom/toolbelt';

import {
  awaitingApproval,
  CANONICAL_M1_TOOLS,
  CREDENTIAL_KEY_RE as REGISTRY_CREDENTIAL_KEY_RE,
  denied,
  errored,
  findCredentialShapedProperty,
  loadRegistry,
  MX_AWAIT_RESULT,
  MX_DELEGATE_TOOL,
  MX_DESCRIBE_AGENT,
  MX_FIND_AGENTS,
  MX_GET_CONTEXT,
  MX_RUN_COMMAND,
  MX_SHARE_CONTEXT,
  ok,
  running,
  type ApprovalInfo,
  type AuditRef,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const nullAuditRef: AuditRef = {
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
};

const fullAuditRef: AuditRef = {
  invocation_id: 'inv_01',
  request_id: 'req_01',
  room: '!room:server',
  event_id: '$event01',
};

const approval: ApprovalInfo = {
  request_id: 'req_ap',
  risk: 'low',
  summary: 'Run ls on /tmp',
  expires_at: '2026-06-22T14:00:00Z',
};

// ---------------------------------------------------------------------------
// Mutating descriptors declare idempotency_key; read verbs do NOT
// ---------------------------------------------------------------------------

describe('idempotency_key field — only on mutating descriptors', () => {
  it('mx_delegate_tool input_schema declares idempotency_key', () => {
    const props = (MX_DELEGATE_TOOL.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('idempotency_key');
  });

  it('mx_run_command input_schema declares idempotency_key', () => {
    const props = (MX_RUN_COMMAND.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('idempotency_key');
  });

  it('mx_delegate_tool idempotency_key is optional (not in required)', () => {
    const required = (MX_DELEGATE_TOOL.input_schema as { required?: string[] }).required ?? [];
    expect(required).not.toContain('idempotency_key');
  });

  it('mx_run_command idempotency_key is optional (not in required)', () => {
    const required = (MX_RUN_COMMAND.input_schema as { required?: string[] }).required ?? [];
    expect(required).not.toContain('idempotency_key');
  });

  it('mx_delegate_tool idempotency_key is typed as string', () => {
    const props = (MX_DELEGATE_TOOL.input_schema as { properties: Record<string, { type: string }> }).properties;
    expect(props.idempotency_key?.type).toBe('string');
  });

  it('mx_run_command idempotency_key is typed as string', () => {
    const props = (MX_RUN_COMMAND.input_schema as { properties: Record<string, { type: string }> }).properties;
    expect(props.idempotency_key?.type).toBe('string');
  });

  // Read / sync verbs must NOT declare idempotency_key (they are non-mutating).
  const READ_VERBS = [MX_FIND_AGENTS, MX_DESCRIBE_AGENT, MX_AWAIT_RESULT, MX_SHARE_CONTEXT, MX_GET_CONTEXT];

  it('mx_find_agents does NOT declare idempotency_key', () => {
    const props = (MX_FIND_AGENTS.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).not.toHaveProperty('idempotency_key');
  });

  it('mx_describe_agent does NOT declare idempotency_key', () => {
    const props = (MX_DESCRIBE_AGENT.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).not.toHaveProperty('idempotency_key');
  });

  it('mx_await_result does NOT declare idempotency_key', () => {
    const props = (MX_AWAIT_RESULT.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).not.toHaveProperty('idempotency_key');
  });

  it('mx_share_context does NOT declare idempotency_key', () => {
    const props = (MX_SHARE_CONTEXT.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).not.toHaveProperty('idempotency_key');
  });

  it('mx_get_context does NOT declare idempotency_key', () => {
    const props = (MX_GET_CONTEXT.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).not.toHaveProperty('idempotency_key');
  });

  it('exactly 2 of the 7 P0 verbs declare idempotency_key', () => {
    const count = CANONICAL_M1_TOOLS.filter((d) => {
      const props = (d.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      return 'idempotency_key' in props;
    }).length;
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Registry loads clean — idempotency_key passes the secret-free-shape check
// ---------------------------------------------------------------------------

describe('registry loads clean with idempotency_key (secret-free-shape check)', () => {
  it('loadRegistry() does not throw (idempotency_key is not credential-shaped)', () => {
    expect(() => loadRegistry()).not.toThrow();
  });

  it('mx_delegate_tool input_schema has no credential-shaped property (toolbelt oracle)', () => {
    expect(findCredentialShapedProperty(MX_DELEGATE_TOOL.input_schema, CREDENTIAL_KEY_RE)).toBeUndefined();
  });

  it('mx_run_command input_schema has no credential-shaped property (toolbelt oracle)', () => {
    expect(findCredentialShapedProperty(MX_RUN_COMMAND.input_schema, CREDENTIAL_KEY_RE)).toBeUndefined();
  });

  it('"idempotency_key" does not match CREDENTIAL_KEY_RE', () => {
    expect(CREDENTIAL_KEY_RE.test('idempotency_key')).toBe(false);
  });

  it('"idempotency_key" does not match registry CREDENTIAL_KEY_RE', () => {
    expect(REGISTRY_CREDENTIAL_KEY_RE.test('idempotency_key')).toBe(false);
  });

  it('all canonical descriptors still pass the global security check with idempotency_key present', () => {
    for (const d of CANONICAL_M1_TOOLS) {
      const offender = findCredentialShapedProperty(d.input_schema, CREDENTIAL_KEY_RE);
      expect(offender, `${d.name}.input_schema must not declare credential-shaped fields`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Envelope field names are not credential-shaped
// ---------------------------------------------------------------------------

describe('envelope field names — no credential-shaped names', () => {
  const ENVELOPE_FIELDS = ['status', 'result', 'error', 'handle', 'approval', 'audit_ref'] as const;
  const AUDIT_REF_FIELDS = ['invocation_id', 'request_id', 'room', 'event_id'] as const;
  const ERROR_FIELDS = ['code', 'message'] as const;
  const APPROVAL_FIELDS = ['request_id', 'risk', 'summary', 'expires_at'] as const;

  it('no top-level envelope field name is credential-shaped', () => {
    for (const name of ENVELOPE_FIELDS) {
      expect(CREDENTIAL_KEY_RE.test(name), `'${name}' should not be credential-shaped`).toBe(false);
    }
  });

  it('no audit_ref field name is credential-shaped', () => {
    for (const name of AUDIT_REF_FIELDS) {
      expect(CREDENTIAL_KEY_RE.test(name), `'${name}' should not be credential-shaped`).toBe(false);
    }
  });

  it('no error field name is credential-shaped', () => {
    for (const name of ERROR_FIELDS) {
      expect(CREDENTIAL_KEY_RE.test(name), `'${name}' should not be credential-shaped`).toBe(false);
    }
  });

  it('no approval field name is credential-shaped', () => {
    for (const name of APPROVAL_FIELDS) {
      expect(CREDENTIAL_KEY_RE.test(name), `'${name}' should not be credential-shaped`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Constructed envelopes pass through redactSecrets unchanged
//
// The toolbelt's inbound redactSecrets guard (T008) walks result values and
// replaces credential-shaped strings with '«redacted»'. A well-formed envelope
// carries no credential-shaped values, so it must emerge unchanged.
// ---------------------------------------------------------------------------

describe('redactSecrets pass-through — no false-positive redaction', () => {
  it('ok() envelope is unchanged after redactSecrets', () => {
    const envelope = ok({ count: 3, label: 'deploy' }, fullAuditRef);
    const redacted = redactSecrets(envelope);
    expect(redacted).toEqual(envelope);
  });

  it('running() envelope is unchanged after redactSecrets', () => {
    const envelope = running('inv_handle_42', fullAuditRef);
    const redacted = redactSecrets(envelope);
    expect(redacted).toEqual(envelope);
  });

  it('awaitingApproval() envelope is unchanged after redactSecrets', () => {
    const envelope = awaitingApproval('inv_ap', approval, fullAuditRef);
    const redacted = redactSecrets(envelope);
    expect(redacted).toEqual(envelope);
  });

  it('denied() envelope is unchanged after redactSecrets', () => {
    const envelope = denied('policy_denied', 'blocked by policy', fullAuditRef);
    const redacted = redactSecrets(envelope);
    expect(redacted).toEqual(envelope);
  });

  it('errored() envelope is unchanged after redactSecrets', () => {
    const envelope = errored('timeout', 'deadline exceeded', fullAuditRef);
    const redacted = redactSecrets(envelope);
    expect(redacted).toEqual(envelope);
  });

  it('audit_ref ids (inv_*, req_*, !room:*) are not redacted', () => {
    const envelope = ok({ x: 1 }, fullAuditRef);
    const redacted = redactSecrets(envelope) as { audit_ref: AuditRef };
    expect(redacted.audit_ref.invocation_id).toBe('inv_01');
    expect(redacted.audit_ref.request_id).toBe('req_01');
    expect(redacted.audit_ref.room).toBe('!room:server');
    expect(redacted.audit_ref.event_id).toBe('$event01');
  });

  it('redactSecrets fires no onRedact callback for a clean envelope', () => {
    const redactedPaths: string[] = [];
    redactSecrets(ok({ count: 1 }, fullAuditRef), (path) => redactedPaths.push(path));
    expect(redactedPaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Approval block confers no authority
// ---------------------------------------------------------------------------

describe('approval block — reports governance outcome, confers no authority', () => {
  it('ApprovalInfo has no "approve", "decide", "grant", or "token" field', () => {
    const forbiddenFields = ['approve', 'decide', 'grant', 'accept', 'reject', 'token'];
    for (const field of forbiddenFields) {
      expect((approval as unknown as Record<string, unknown>)[field]).toBeUndefined();
    }
  });

  it('approval.risk is a read-only informational field (not an authority level)', () => {
    const e = awaitingApproval('h', approval, nullAuditRef);
    expect(e.approval?.risk).toBe('low');
    // The field is frozen — mutation is a no-op / throws.
    expect(() => {
      (e.approval as unknown as Record<string, unknown>).risk = 'high';
    }).toThrow();
  });

  it('a params object containing an envelope does not trigger assertNoCredentialShapedArgs', () => {
    const envelope = ok({ result: 'safe text' }, nullAuditRef);
    // Handlers might pass envelope-shaped data as params; ensure no false rejections.
    expect(() => assertNoCredentialShapedArgs({ result: envelope })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Boundary A invariant — no credential reaches the model via the envelope
// ---------------------------------------------------------------------------

describe('Boundary A — secret-free envelope output', () => {
  it('an error message containing a fake token IS redacted by redactSecrets (defense-in-depth)', () => {
    // A mapper must never echo raw daemon payloads verbatim. If one accidentally
    // did, the inbound redact guard must catch it. This test verifies the guard
    // works — it does NOT imply T102 helpers produce such messages (they do not).
    const leakyEnvelope = {
      status: 'error' as const,
      result: null,
      error: { code: 'internal' as const, message: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      handle: null,
      approval: null,
      audit_ref: nullAuditRef,
    };
    const redacted = redactSecrets(leakyEnvelope) as typeof leakyEnvelope;
    // The token-shaped message value is replaced with the placeholder.
    expect(redacted.error?.message).toBe('«redacted»');
  });

  it('an ok result containing a fake token IS redacted by redactSecrets', () => {
    const leakyEnvelope = ok({ output: 'syt_AAAAAAAAAAAAAAAAAAAAAAAA' }, nullAuditRef);
    const redacted = redactSecrets(leakyEnvelope) as { result: { output: string } };
    expect(redacted.result.output).toBe('«redacted»');
  });
});
