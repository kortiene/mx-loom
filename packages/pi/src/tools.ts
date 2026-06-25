/**
 * The tool generator (T205) — canonical descriptors → Pi `ToolDefinition[]`.
 *
 * The core of the Pi binding. {@link createPiToolDefinitions} enumerates
 * {@link CANONICAL_TOOLS} and produces one Pi {@link ToolDefinition} per
 * descriptor, ready for `createAgentSession({ customTools })` or
 * {@link import('./register.js').registerMxTools}. **Generated, never
 * hand-authored**: adding a tenth canonical descriptor surfaces it in Pi with no
 * per-tool edit here.
 *
 * Each tool's `parameters` is the descriptor's draft-07 `input_schema` converted
 * via the §1 {@link jsonSchemaToTypeBox} (fail-closed — a drifted schema throws
 * {@link PiSchemaConversionError} at *build* time, surfacing the drift loudly
 * instead of silently widening the gate). Because TypeBox is not confirmed to
 * validate `parameters` inside Pi's pipeline (T204), each `execute()` also runs a
 * **fail-closed Ajv preflight** against the same `input_schema` before dispatch —
 * the real input gate; the TypeBox schema is only the model-facing shape.
 *
 * Each `execute()` is a thin closure that routes via {@link dispatchCall} (the
 * shared name → registry-handler router), taps audit once ({@link withAudit}, the
 * single result-return chokepoint), and serializes the T102 envelope onto Pi's
 * {@link AgentToolResult}. The whole body is guarded: dispatch + the handlers
 * never throw and `withAudit` is best-effort, so any throw is an adapter bug — it
 * is converted to an `errored('internal', …)` envelope, **never propagated** (a
 * throw marks the Pi tool *failed* and may discard the envelope).
 *
 * Secret-free by construction: the binding holds no secret and starts no child
 * process; every daemon call routes through `ctx.daemon` (an `MxSession`/
 * `MxClient`) so the deny-by-default env allowlist, outbound credential-shaped-arg
 * rejection, and inbound `redactSecrets` all stay in force, and trust/policy/
 * approval enforcement stays out-of-process on the receiving daemon.
 *
 * **Deferred results stay model-driven (baseline).** A `running` /
 * `awaiting_approval` envelope surfaces with its `handle` and the generated prompt
 * guidance; the model resolves it via the generated `mx_await_result` tool. The
 * registry handlers already make this first-class (`mx_delegate_tool` /
 * `mx_run_command` accept `wait_ms` and compose `mx_await_result` inline), so the
 * Pi binding needs no hidden poll loop.
 */
import { withAudit } from '@mx-loom/audit';
import type { AuditTap } from '@mx-loom/audit';
import { CANONICAL_TOOLS, createAjvValidator, errored } from '@mx-loom/registry';
import type { CompiledSchema, SchemaValidator, ToolDescriptor, ToolResult } from '@mx-loom/registry';

import type { BindingContext } from './context.js';
import { dispatchCall, EMPTY_AUDIT_REF } from './dispatch.js';
import type { ToolArgs } from './dispatch.js';
import { jsonSchemaToTypeBox } from './json-schema-to-typebox.js';
import type { ConvertOptions } from './json-schema-to-typebox.js';
import type { AgentToolResult, ToolDefinition, TypeBoxBuilders } from './pi-abi.js';
import { serializePiToolResult } from './serialize.js';

/** Options for {@link createPiToolDefinitions}. */
export interface CreatePiToolDefinitionsOptions {
  /**
   * The injected TypeBox builders (`{ Type, StringEnum }`), resolved by the host
   * from Pi's own tree so a single TypeBox runtime builds every schema. Required —
   * the binding imports no TypeBox/pi-ai instance of its own. See {@link TypeBoxBuilders}.
   */
  builders: TypeBoxBuilders;
  /** Schema-conversion options forwarded to {@link jsonSchemaToTypeBox}. */
  convert?: ConvertOptions;
  /**
   * The JSON Schema validator backing the per-call Ajv preflight. Default: a fresh
   * {@link createAjvValidator} (the same seam the registry loader and T105 use).
   */
  validator?: SchemaValidator;
  /**
   * Override the audit tap (tests). Default: a {@link withAudit} tap over
   * `ctx.auditSink`, fixed with the session `correlation_id`.
   */
  auditTap?: AuditTap;
  /** The descriptor set to generate from. Default {@link CANONICAL_TOOLS} (tests only). */
  descriptors?: readonly ToolDescriptor[];
}

/** Read a string `idempotency_key` from the model's args, if a mutating verb supplied one. */
function idempotencyKeyOf(args: ToolArgs): string | undefined {
  const key = args['idempotency_key'];
  return typeof key === 'string' ? key : undefined;
}

/** First Ajv error rendered secret-free: JSON-pointer path + keyword/message only, never a value. */
function invalidArgsMessage(name: string, validate: CompiledSchema): string {
  const errors = Array.isArray(validate.errors) ? validate.errors : [];
  const first = errors[0] as { instancePath?: string; message?: string } | undefined;
  if (first !== undefined) {
    const where =
      typeof first.instancePath === 'string' && first.instancePath.length > 0
        ? ` at ${first.instancePath}`
        : '';
    const why = typeof first.message === 'string' && first.message.length > 0 ? `: ${first.message}` : '';
    return `invalid arguments for ${name}${where}${why}`;
  }
  return `invalid arguments for ${name}`;
}

/**
 * Generate the (non-empty, tool-naming) prompt metadata for a descriptor.
 * Deferred verbs get the explicit "resolve the handle via `mx_await_result`" hint.
 */
function promptFor(descriptor: ToolDescriptor): { promptSnippet: string; promptGuidelines: string[] } {
  const name = descriptor.name;
  const guidelines = [`${name}: ${descriptor.description}`];
  if (descriptor.async_semantics === 'deferred') {
    guidelines.push(
      `${name} may return status "running" or "awaiting_approval" with a "handle". When it does, ` +
        `call mx_await_result with that handle to obtain the terminal result — do not retry ${name}.`,
    );
  }
  guidelines.push(
    `Read the returned envelope's "status"/"error": "denied" is a governance outcome to replan ` +
      `around (not a transport error to retry); "ok" carries the result.`,
  );
  return { promptSnippet: `${name} — ${descriptor.description}`, promptGuidelines: guidelines };
}

/**
 * Build one Pi {@link ToolDefinition} for a descriptor, closing over the binding
 * context, the converted schema, the compiled Ajv validator, and the audit tap.
 */
function buildToolDefinition(
  descriptor: ToolDescriptor,
  ctx: BindingContext,
  tap: AuditTap,
  validator: SchemaValidator,
  builders: TypeBoxBuilders,
  convert: ConvertOptions,
): ToolDefinition {
  // Fail-closed at build time: a drifted schema throws PiSchemaConversionError
  // here, never silently widening the model's input surface.
  const parameters = jsonSchemaToTypeBox(descriptor.input_schema, builders, convert);
  // Compile the Ajv preflight once (the real input gate — TypeBox is model-facing only).
  const validate = validator.compile(descriptor.input_schema);
  const { promptSnippet, promptGuidelines } = promptFor(descriptor);

  // Preflight + dispatch, self-guarded so it never throws.
  const produce = async (args: ToolArgs): Promise<ToolResult> => {
    try {
      if (!validate(args)) {
        return errored('invalid_args', invalidArgsMessage(descriptor.name, validate), EMPTY_AUDIT_REF);
      }
      return await dispatchCall(descriptor.name, args, ctx);
    } catch {
      // Handlers/dispatch never throw; reaching here is an adapter bug.
      return errored('internal', `pi binding adapter error in ${descriptor.name}`, EMPTY_AUDIT_REF);
    }
  };

  return {
    name: descriptor.name,
    // Pi's `label` is a short human title; the description is the model-facing text.
    label: descriptor.name,
    description: descriptor.description,
    promptSnippet,
    promptGuidelines,
    parameters,
    async execute(toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult> {
      try {
        const args = (params ?? {}) as ToolArgs;
        const envelope = await produce(args);
        const idempotency_key = idempotencyKeyOf(args);
        // The SINGLE result-return chokepoint's audit tap (best-effort).
        const audited = await tap(envelope, {
          tool_name: descriptor.name,
          call_id: toolCallId,
          ...(idempotency_key !== undefined ? { idempotency_key } : {}),
        });
        return serializePiToolResult(audited);
      } catch {
        // `produce` is self-guarded and `withAudit` is best-effort, so a throw here
        // can only be an adapter bug — convert to `internal`, NEVER propagate (a
        // throw would mark the Pi tool failed and discard the envelope).
        return serializePiToolResult(
          errored('internal', `pi binding adapter error in ${descriptor.name}`, EMPTY_AUDIT_REF),
        );
      }
    },
  };
}

/**
 * Build the generated Pi {@link ToolDefinition}[] for the thirteen canonical `mx_*`
 * verbs, bound to a secret-free {@link BindingContext}.
 *
 * @throws {PiSchemaConversionError} at build time if a descriptor's `input_schema`
 * uses a construct outside the supported subset (fail-closed).
 */
export function createPiToolDefinitions(
  ctx: BindingContext,
  options: CreatePiToolDefinitionsOptions,
): ToolDefinition[] {
  const validator = options.validator ?? createAjvValidator();
  const convert = options.convert ?? {};
  const tap =
    options.auditTap ??
    withAudit(
      ctx.auditSink,
      ctx.correlationId !== undefined ? { correlation_id: ctx.correlationId } : {},
    );
  const descriptors = options.descriptors ?? CANONICAL_TOOLS;

  return descriptors.map((descriptor) =>
    buildToolDefinition(descriptor, ctx, tap, validator, options.builders, convert),
  );
}
