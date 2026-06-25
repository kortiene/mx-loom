/**
 * `SessionDescriptor` — the non-secret resume handle (T302, design §7).
 *
 * The crash-recovery boundary is the durable task DAG: *ephemeral cognition state*
 * (scratchpad, conversation, retrieved knowledge) is runtime-private and lost when a
 * runtime dies; *durable coordination state* (the signed task plan of record) survives
 * on the substrate. The promised property — "a runtime can die and a new one resumes
 * from task state" — needs exactly one thing to cross the restart boundary: a small,
 * **non-secret** record the prior process persists and hands back to {@link import('./resume.js').resumeSession}.
 *
 * It is **allowlist-by-construction** and carries *only* non-secret coordination
 * handles — `agent_id`, `room`, `correlation_id`, an optional `kind`, and an opaque
 * task {@link TaskCursor}. It deliberately carries **no** Matrix token, Ed25519
 * signing key, device secret, provider key, or `GH_TOKEN`; those stay daemon-held and
 * never cross Boundary A. Identity continuity across a restart is the daemon's job at
 * re-`agent.register`, not the descriptor's, so the descriptor stores only the
 * non-secret `agent_id`, never any key material.
 *
 * Both {@link serializeSessionDescriptor} and {@link parseSessionDescriptor} route the
 * record through the toolbelt's {@link assertNoCredentialShapedArgs} guard on **write
 * and read**, so a malformed or poisoned descriptor can never smuggle a credential
 * across the boundary; an unexpected `v` fails **closed** (`invalid_args`).
 *
 * Where the host persists the serialized descriptor (disk, an app store, an env
 * handle) is the host's responsibility (spec OQ #5); mx-loom defines the shape,
 * validates it is non-secret, and accepts it as input.
 */
import { assertNoCredentialShapedArgs } from './guards.js';
import { TransportError } from './transport.js';

/** The only descriptor schema version this build understands. */
export const SESSION_DESCRIPTOR_VERSION = 1 as const;

/**
 * The last task-state cursor the prior process observed — the resumption token that
 * lets a resumed session distinguish "already observed" from "new" (spec OQ #6).
 *
 * The exact cursor semantics are **pending the two-daemon round-trip**: it may be an
 * explicit monotonic `state_rev` (the `AgentState.state_rev` precedent), an opaque
 * daemon continuation `token`, or a `since` timestamp. Both fields are optional and
 * the type is localized here so the round-trip pins it in one place; the poll backend
 * advances `state_rev` as a high-water mark and dedups deltas against it.
 */
export interface TaskCursor {
  /** Highest observed monotonic task `state_rev`, or absent at genesis. */
  readonly state_rev?: number;
  /** Opaque daemon continuation / `since` token, when the daemon provides one. */
  readonly token?: string;
}

/**
 * The non-secret record persisted across a runtime restart. The *only* thing that
 * crosses the restart boundary.
 */
export interface SessionDescriptor {
  /** The agent identity to resume against (daemon-assigned at first register). */
  readonly agent_id: string;
  /** The workspace/room the plan is scoped to — the resumption key (spec OQ #4). */
  readonly room: string;
  /** Reused so audit correlates across the restart (design §7). */
  readonly correlation_id: string;
  /** Agent kind, replayed into re-register so the upsert is faithful. */
  readonly kind?: string;
  /** The last task-state cursor the prior process observed. */
  readonly cursor?: TaskCursor;
  /** Descriptor schema version, for forward-compat. */
  readonly v: typeof SESSION_DESCRIPTOR_VERSION;
}

function fail(message: string): never {
  // Reuse the closed transport taxonomy so a bad descriptor surfaces as the same
  // `invalid_args` the credential guard raises — never a bespoke error type.
  throw new TransportError('invalid_args', message);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`session descriptor field '${field}' must be a non-empty string`);
  }
  return value;
}

/** Validate + normalise a raw cursor; absent → `undefined`. Never carries extra fields. */
function readCursor(value: unknown): TaskCursor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail("session descriptor field 'cursor' must be an object");
  }
  const obj = value as Record<string, unknown>;
  const state_rev = obj['state_rev'];
  const token = obj['token'];
  if (state_rev !== undefined && (typeof state_rev !== 'number' || !Number.isFinite(state_rev))) {
    fail("session descriptor field 'cursor.state_rev' must be a finite number");
  }
  if (token !== undefined && typeof token !== 'string') {
    fail("session descriptor field 'cursor.token' must be a string");
  }
  return {
    ...(state_rev !== undefined ? { state_rev: state_rev as number } : {}),
    ...(token !== undefined ? { token: token as string } : {}),
  };
}

/**
 * Validate that `value` is a well-formed, **non-secret** {@link SessionDescriptor},
 * returning a freshly built record that carries **only** the named, allowlisted
 * fields (so an unexpected field on the input can never ride along). Throws
 * `TransportError('invalid_args')` on a bad shape, an unsupported `v`, or a
 * credential-shaped field. Pure; the single validation chokepoint reused by both
 * serialize and parse.
 */
export function assertSessionDescriptor(value: unknown): SessionDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('session descriptor must be an object');
  }
  const obj = value as Record<string, unknown>;

  // Reject any credential-shaped key/value anywhere in the **raw** input — so a
  // poisoned descriptor (e.g. a smuggled `auth_token` field, or a `sk-ant-…` value)
  // is rejected as `invalid_args` rather than silently dropped by the allowlist below.
  // A clean descriptor passes untouched.
  assertNoCredentialShapedArgs(obj, '$descriptor');

  // Fail closed on an unknown/missing version *before* anything else — a descriptor
  // from a future writer must never be silently coerced.
  if (obj['v'] !== SESSION_DESCRIPTOR_VERSION) {
    fail(`unsupported session descriptor version (expected ${SESSION_DESCRIPTOR_VERSION})`);
  }

  const agent_id = readNonEmptyString(obj['agent_id'], 'agent_id');
  const room = readNonEmptyString(obj['room'], 'room');
  const correlation_id = readNonEmptyString(obj['correlation_id'], 'correlation_id');
  const kind = obj['kind'];
  if (kind !== undefined && typeof kind !== 'string') {
    fail("session descriptor field 'kind' must be a string");
  }
  const cursor = readCursor(obj['cursor']);

  // Built allowlist-by-construction: only the named, validated fields survive, so a
  // benign extra field on the input never rides along into the persisted record.
  const descriptor: SessionDescriptor = {
    v: SESSION_DESCRIPTOR_VERSION,
    agent_id,
    room,
    correlation_id,
    ...(kind !== undefined ? { kind: kind as string } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
  return descriptor;
}

/**
 * Serialize a {@link SessionDescriptor} to a JSON string for the host to persist.
 * Validates non-secret + well-formed first; only the allowlisted fields are emitted.
 */
export function serializeSessionDescriptor(descriptor: SessionDescriptor): string {
  return JSON.stringify(assertSessionDescriptor(descriptor));
}

/**
 * Parse + validate a persisted descriptor string back into a {@link SessionDescriptor}.
 * A non-JSON string, a bad shape, an unsupported `v`, or a credential-shaped field all
 * fail closed with `TransportError('invalid_args')`.
 */
export function parseSessionDescriptor(json: string): SessionDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('session descriptor is not valid JSON');
  }
  return assertSessionDescriptor(parsed);
}
