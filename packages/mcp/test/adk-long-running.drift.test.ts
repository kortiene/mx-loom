/**
 * ADK `LongRunningFunctionTool` approval shim — STATIC contract drift guard
 * (T202 / #24).
 *
 * The shim lives in `examples/adk/long_running_tools.py`. Because Google ADK is
 * Python and derives a tool's declaration from the wrapped function's signature,
 * the shim hand-mirrors several pieces of the canonical `@mx-loom/registry`
 * contract as Python constants:
 *   - the two deferred verbs it wraps (`LONG_RUNNING_TOOL_NAMES`);
 *   - the T102 status partition (`_TERMINAL_STATUSES` / `_PENDING_STATUSES`);
 *   - the four secret-free approval fields it projects (`_APPROVAL_FIELDS`);
 *   - the always-present audit-ref keys (`_EMPTY_AUDIT_REF`);
 *   - the idempotency-key prefix (`_IDEMPOTENCY_KEY_PREFIX`);
 *   - the resolver verb (`_AWAIT_RESULT_TOOL_NAME`).
 *
 * A divergent Python mirror is a latent contract break: the shim could project an
 * approval field that no longer exists, miss a new status, or wrap a tool the
 * registry no longer ships. This suite parses those Python literals as TEXT (no
 * Python interpreter required, so it runs on every CI) and pins each against the
 * exported registry oracle — the *single source of truth*. Any drift fails here
 * rather than silently shipping a stale shim.
 *
 * The companion behavioral suite (`adk-long-running.behavior.test.ts`) exercises
 * the live Python disposition policy + wrapper *signatures* under a `python3`
 * subprocess; this suite is the static, interpreter-free half.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_KEY_RE,
  ENVELOPE_SCHEMA,
  IDEMPOTENCY_KEY_PREFIX,
  MODEL_FACING_ALLOWLIST,
  MX_AWAIT_RESULT,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  isForbiddenAuthorityVerb,
} from '@mx-loom/registry';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const shimSource = readFileSync(resolve(repoRoot, 'examples/adk/long_running_tools.py'), 'utf8');

/** Strip Python `#` comments so a brace inside a comment cannot end a literal early. */
function stripPyComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

/**
 * Extract the quoted strings inside `NAME[: ann] = ( ... )` / `{ ... }` /
 * `frozenset({ ... })`. The `[^=]*` tolerates a type annotation (e.g.
 * `: Dict[str, Any]`) between the name and the assignment. For a dict literal the
 * values here are all `None` (unquoted), so the captured quoted strings are the
 * KEYS — exactly what the audit-ref check wants.
 */
function pyQuotedSeq(name: string): string[] {
  const clean = stripPyComments(shimSource);
  const re = new RegExp(`${name}[^=\\n]*=\\s*(?:frozenset\\()?[\\(\\{]([\\s\\S]*?)[\\)\\}]`, 'm');
  const match = re.exec(clean);
  expect(match, `missing Python literal ${name}`).not.toBeNull();
  return [...(match![1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

/** Extract a single `NAME = "value"` Python string literal. */
function pyString(name: string): string {
  const clean = stripPyComments(shimSource);
  const match = new RegExp(`${name}[^=\\n]*=\\s*"([^"]+)"`, 'm').exec(clean);
  expect(match, `missing Python string literal ${name}`).not.toBeNull();
  return match![1] ?? '';
}

/** Derive the pending vs terminal status partition straight from the envelope schema. */
function statusPartitionFromSchema(): { pending: string[]; terminal: string[]; all: string[] } {
  const schema = ENVELOPE_SCHEMA as unknown as {
    properties: { status: { enum: string[] } };
    allOf: ReadonlyArray<{
      if: { properties: { status: { const: string } } };
      then: { properties: { handle?: { type?: string | string[] } } };
    }>;
  };
  const pending: string[] = [];
  const terminal: string[] = [];
  for (const branch of schema.allOf) {
    const status = branch.if.properties.status.const;
    const handleType = branch.then.properties.handle?.type;
    // A deferred/pending status is the one whose branch requires a string `handle`.
    const handleIsString = handleType === 'string' || (Array.isArray(handleType) && handleType.includes('string'));
    (handleIsString ? pending : terminal).push(status);
  }
  return { pending: pending.sort(), terminal: terminal.sort(), all: [...schema.properties.status.enum].sort() };
}

describe('T202 ADK long-running shim — wrapped-verb mirror', () => {
  it('LONG_RUNNING_TOOL_NAMES is exactly the two deferred mutating verbs (canonical names preserved)', () => {
    expect(pyQuotedSeq('LONG_RUNNING_TOOL_NAMES')).toEqual([MX_DELEGATE_TOOL.name, MX_RUN_COMMAND.name]);
  });

  it('both wrapped verbs are model-facing, deferred, and never authority/credential-shaped', () => {
    for (const descriptor of [MX_DELEGATE_TOOL, MX_RUN_COMMAND]) {
      // Long-running is only sound for a deferred verb (it returns a handle).
      expect(descriptor.async_semantics, `${descriptor.name} is not deferred`).toBe('deferred');
      expect((MODEL_FACING_ALLOWLIST as readonly string[]).includes(descriptor.name)).toBe(true);
      expect(isForbiddenAuthorityVerb(descriptor.name), `${descriptor.name} is an authority verb`).toBe(false);
      expect(CREDENTIAL_KEY_RE.test(descriptor.name), `${descriptor.name} is credential-shaped`).toBe(false);
    }
  });

  it('the resume path uses the canonical mx_await_result resolver, not an authority verb', () => {
    const awaitName = pyString('_AWAIT_RESULT_TOOL_NAME');
    expect(awaitName).toBe(MX_AWAIT_RESULT.name);
    expect(isForbiddenAuthorityVerb(awaitName)).toBe(false);
    expect((MODEL_FACING_ALLOWLIST as readonly string[]).includes(awaitName)).toBe(true);
  });
});

describe('T202 ADK long-running shim — T102 contract mirror', () => {
  it('mirrors the envelope status partition (terminal/pending) from the schema', () => {
    const partition = statusPartitionFromSchema();
    expect(pyQuotedSeq('_TERMINAL_STATUSES').sort()).toEqual(partition.terminal);
    expect(pyQuotedSeq('_PENDING_STATUSES').sort()).toEqual(partition.pending);
    // Union must be the full closed status set — a new status forces a shim update.
    const union = [...new Set([...pyQuotedSeq('_TERMINAL_STATUSES'), ...pyQuotedSeq('_PENDING_STATUSES')])].sort();
    expect(union).toEqual(partition.all);
    expect(partition.terminal).toEqual(['denied', 'error', 'ok']);
    expect(partition.pending).toEqual(['awaiting_approval', 'running']);
  });

  it('projects approval through exactly the secret-free ApprovalInfo fields', () => {
    const approvalSchema = (
      ENVELOPE_SCHEMA as unknown as {
        properties: { approval: { oneOf: ReadonlyArray<{ type?: string; required?: string[] }> } };
      }
    ).properties.approval;
    const required = approvalSchema.oneOf.find((s) => s.type === 'object')?.required ?? [];
    expect(pyQuotedSeq('_APPROVAL_FIELDS')).toEqual(required);
    // No projected approval field may be credential-shaped (secret-free boundary).
    for (const field of pyQuotedSeq('_APPROVAL_FIELDS')) {
      expect(CREDENTIAL_KEY_RE.test(field), `approval field is credential-shaped: ${field}`).toBe(false);
    }
  });

  it('mirrors the always-present audit_ref keys from the schema', () => {
    const auditRequired =
      (
        ENVELOPE_SCHEMA as unknown as { properties: { audit_ref: { required: string[] } } }
      ).properties.audit_ref.required;
    expect(pyQuotedSeq('_EMPTY_AUDIT_REF')).toEqual(auditRequired);
  });

  it('mirrors the idempotency-key prefix and keeps it non-credential-shaped', () => {
    const prefix = pyString('_IDEMPOTENCY_KEY_PREFIX');
    expect(prefix).toBe(IDEMPOTENCY_KEY_PREFIX);
    // The key is a dedup nonce, not a credential: the prefix must not read as one.
    expect(CREDENTIAL_KEY_RE.test(prefix)).toBe(false);
  });
});
