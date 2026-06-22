/**
 * The draft-07 envelope JSON Schema (T102 / #10) — AC 1: "every tool result
 * conforms to the envelope schema".
 *
 * A `status`-discriminated union: a base that requires all six fields, plus an
 * `allOf` of `if status=X then {field presence}` branches mirroring the §4.2
 * table in `./envelope.ts`. `error.code` is constrained to the closed
 * {@link ./errors.ERROR_CODES} set, and per-status the code is further narrowed
 * to the denial-set (`denied`) or fault-set (`error`) — so the status↔code
 * partition is enforced by the schema, not only by the helper types.
 *
 * Compiled once through the **same** Ajv seam T101 ships (`createAjvValidator`,
 * draft-07) — no new validator dependency. The schema is the contract; the
 * constructor helpers' outputs are validated against it.
 */
import { type JsonSchema } from './descriptor.js';
import { DENIAL_CODES, ERROR_CODES, FAULT_CODES } from './errors.js';
import { deepFreeze } from './freeze.js';
import { type CompiledSchema, JSON_SCHEMA_DIALECT, createAjvValidator } from './validator.js';

/** The five envelope statuses (mirrors {@link ./envelope.ToolStatus}). */
const STATUSES = ['ok', 'running', 'awaiting_approval', 'denied', 'error'] as const;
type StatusLiteral = (typeof STATUSES)[number];

const NULL: JsonSchema = { type: 'null' };

/** Field-presence rules for one `status` branch (used inside `allOf` `then`). */
function statusBranch(status: StatusLiteral, presence: Readonly<Record<string, JsonSchema>>): JsonSchema {
  return {
    if: { properties: { status: { const: status } } },
    then: { properties: presence },
  };
}

const schemaDoc: JsonSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  title: 'mx-loom ToolResult envelope',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'result', 'error', 'handle', 'approval', 'audit_ref'],
  properties: {
    status: { enum: [...STATUSES] },
    // `result` is constrained per-status by the `allOf` branches below.
    result: {},
    error: {
      oneOf: [
        NULL,
        {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'message'],
          properties: {
            code: { enum: [...ERROR_CODES] },
            message: { type: 'string' },
          },
        },
      ],
    },
    handle: { type: ['string', 'null'] },
    approval: {
      oneOf: [
        NULL,
        {
          type: 'object',
          additionalProperties: false,
          required: ['request_id', 'risk', 'summary', 'expires_at'],
          properties: {
            request_id: { type: 'string' },
            risk: { enum: ['low', 'medium', 'high'] },
            summary: { type: 'string' },
            expires_at: { type: 'string' },
          },
        },
      ],
    },
    audit_ref: {
      type: 'object',
      additionalProperties: false,
      required: ['invocation_id', 'request_id', 'room', 'event_id'],
      properties: {
        invocation_id: { type: ['string', 'null'] },
        request_id: { type: ['string', 'null'] },
        room: { type: ['string', 'null'] },
        event_id: { type: ['string', 'null'] },
      },
    },
  },
  allOf: [
    statusBranch('ok', {
      result: { type: 'object' },
      error: NULL,
      handle: NULL,
      approval: NULL,
    }),
    statusBranch('running', {
      result: NULL,
      error: NULL,
      handle: { type: 'string' },
      approval: NULL,
    }),
    statusBranch('awaiting_approval', {
      result: NULL,
      error: NULL,
      handle: { type: 'string' },
      approval: { type: 'object' },
    }),
    statusBranch('denied', {
      result: NULL,
      handle: NULL,
      approval: NULL,
      // Non-null error whose code is in the denial-set.
      error: { type: 'object', required: ['code'], properties: { code: { enum: [...DENIAL_CODES] } } },
    }),
    statusBranch('error', {
      result: NULL,
      handle: NULL,
      approval: NULL,
      // Non-null error whose code is in the fault-set.
      error: { type: 'object', required: ['code'], properties: { code: { enum: [...FAULT_CODES] } } },
    }),
  ],
};

// Compile BEFORE freezing: Ajv reads the document but must not be handed a frozen
// graph to traverse-and-annotate.
const compiled: CompiledSchema = createAjvValidator().compile(schemaDoc);

/**
 * The result-envelope contract document (draft-07). Frozen for immutability,
 * consistent with the descriptor set. Exported so bindings/tests can inspect or
 * re-compile it; {@link validateEnvelope} is the ready-to-use validator.
 */
export const ENVELOPE_SCHEMA: JsonSchema = deepFreeze(schemaDoc);

/**
 * Validate `value` against {@link ENVELOPE_SCHEMA}. Returns `true` iff it
 * conforms; on `false`, `validateEnvelope.errors` carries the Ajv error list
 * (field/path only — never values, so no secret is logged).
 */
export const validateEnvelope = ((value: unknown): boolean => {
  const passed = compiled(value);
  (validateEnvelope as CompiledSchema).errors = compiled.errors;
  return passed;
}) as CompiledSchema;
