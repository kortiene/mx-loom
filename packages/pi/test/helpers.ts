/**
 * Shared test helpers for the Pi binding daemon-free suite (T205).
 *
 * Centralises the fakeBuilders (ABI-shaped `{ Type, StringEnum }`) and
 * the `makeFakeDaemon` factory so every focused test file imports one
 * symbol rather than duplicating the infrastructure.
 *
 * Nothing here holds or imports a secret, a TypeBox instance, or a Pi
 * instance — the helpers are all plain objects / factory functions.
 */
import type { DaemonCall } from '@mx-loom/registry';
import type { TypeBoxBuilders } from '../src/pi-abi.js';

export const ROOM = '!pi-test-room:server';

/** Marker symbol used by the fake `Type.Optional` to mark properties optional. */
const OPTIONAL = Symbol('optional');

/**
 * ABI-shaped fake of `{ Type, StringEnum }` that emits plain JSON-Schema-like
 * objects matching the wire shape Pi's real TypeBox + pi-ai `StringEnum` produce.
 * Output is directly inspectable without installing TypeBox.
 */
export const fakeBuilders: TypeBoxBuilders = {
  Type: {
    Object(properties, options = {}) {
      const required = Object.entries(properties)
        .filter(([, schema]) => !(schema as Record<symbol, unknown>)[OPTIONAL])
        .map(([key]) => key);
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...options,
      };
    },
    Optional(schema) {
      return { ...(schema as Record<string, unknown>), [OPTIONAL]: true };
    },
    String(options = {}) {
      return { type: 'string', ...options };
    },
    Integer(options = {}) {
      return { type: 'integer', ...options };
    },
    Number(options = {}) {
      return { type: 'number', ...options };
    },
    Boolean(options = {}) {
      return { type: 'boolean', ...options };
    },
    Array(items, options = {}) {
      return { type: 'array', items, ...options };
    },
  },
  StringEnum(values, options = {}) {
    return { type: 'string', enum: [...values], ...options };
  },
};

/** Stub daemon responses sufficient for all twelve canonical verbs (M1 + M3 task). */
export function makeFakeDaemon(
  onCall?: (method: string, params: unknown) => void,
): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      onCall?.(method, params ?? null);
      switch (method) {
        case 'agent.list':
          return [];
        case 'agent.tools':
          return {
            schemas: [
              { name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } },
            ],
          };
        case 'invocation.get':
          return { state: 'ok', result: { polled: true } };
        case 'invocation.cancel':
          return { ok: true, cancelled: true };
        case 'call.start':
          return {
            ok: true,
            result: { passed: true },
            audit_ref: {
              invocation_id: 'inv_1',
              request_id: 'req_1',
              room: ROOM,
              event_id: '$evt_1',
            },
          };
        case 'exec.start':
          return {
            ok: true,
            result: { exit_code: 0, stdout: 'done' },
            audit_ref: {
              invocation_id: 'inv_exec',
              request_id: 'req_exec',
              room: ROOM,
              event_id: '$evt_exec',
            },
          };
        case 'share.file':
        case 'share.diff':
        case 'share.env':
          return { context_id: 'ctx_1', sha256: 'abc123' };
        case 'share.get':
          return { context_id: 'ctx_1', kind: 'file' };
        case 'workspace.status':
          return { room_id: ROOM, name: 'test workspace', encrypted: false };
        // M3 (T301) — task-DAG verbs.
        case 'task.create':
        case 'task.update':
          return {
            task_id: 'task_pi_stub_1',
            title: 'Pi stub task',
            state: 'proposed',
            depends_on: [],
            blocks: [],
            action: null,
            audit_ref: {
              invocation_id: 'inv_pi_t1',
              request_id: 'req_pi_t1',
              room: ROOM,
              event_id: '$pi_tevt_1',
            },
          };
        case 'task.list':
          return { tasks: [] };
        case 'task.graph':
          return [];
        default:
          throw new Error(`unexpected daemon method in pi test: ${method}`);
      }
    },
  };
}
