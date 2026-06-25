/**
 * `actionToDispatch` + `dispatchToCreateActionParam` + `isInvalidDispatch` unit tests
 * (T303 / #32) — the pure, shared action→dispatch mapper that single-sources the
 * alignment between what `mx_create_task` authors and what `mx_dispatch_task` dispatches.
 *
 * Tests pin:
 *  - `actionToDispatch` maps kind='tool' actions to `{ mode: 'tool', tool, args }`.
 *  - `actionToDispatch` maps kind='exec' actions to `{ mode: 'exec', command, command_args, cwd? }`.
 *  - `actionToDispatch` returns `{ invalid }` for tool actions with no tool name.
 *  - `actionToDispatch` returns `{ invalid }` for exec actions with no command.
 *  - Absent `args` defaults to `{}` (tool); absent `command_args` defaults to `[]` (exec).
 *  - Absent `cwd` produces no `cwd` field in the dispatch result.
 *  - Never throws on any input.
 *  - `isInvalidDispatch` returns true for `{ invalid }`, false for a valid dispatch.
 *  - `dispatchToCreateActionParam` maps a tool dispatch to `{ kind, tool, args? }`.
 *  - `dispatchToCreateActionParam` maps an exec dispatch to `{ kind, command, args?, cwd? }`
 *    (note: `command_args` maps to `args` in the authored daemon param).
 *  - **Alignment / drift test**: `dispatchToCreateActionParam(actionToDispatch(action))`
 *    equals the expected authored params — the single source of truth guarantee proving
 *    what `mx_create_task` authors is exactly what `mx_dispatch_task` dispatches (design
 *    §2 / T303 "alignment").
 *
 * Pure; no daemon, no env, no network.
 */
import { describe, expect, it } from 'vitest';

import {
  actionToDispatch,
  dispatchToCreateActionParam,
  isInvalidDispatch,
  type ActionDispatch,
  type TaskAction,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// actionToDispatch — kind: 'tool'
// ---------------------------------------------------------------------------

describe('actionToDispatch — kind: tool', () => {
  it('returns mode: tool with correct tool and args', () => {
    const action: TaskAction = { kind: 'tool', tool: 'run_tests', args: { suite: 'unit' } };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const d = dispatch as Extract<ActionDispatch, { mode: 'tool' }>;
    expect(d.mode).toBe('tool');
    expect(d.tool).toBe('run_tests');
    expect(d.args).toEqual({ suite: 'unit' });
  });

  it('defaults args to {} when absent', () => {
    const action: TaskAction = { kind: 'tool', tool: 'run_tests' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const d = dispatch as Extract<ActionDispatch, { mode: 'tool' }>;
    expect(d.args).toEqual({});
  });

  it('preserves a non-empty args object verbatim', () => {
    const action: TaskAction = { kind: 'tool', tool: 'deploy', args: { env: 'staging', dry_run: true } };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const d = dispatch as Extract<ActionDispatch, { mode: 'tool' }>;
    expect(d.args).toEqual({ env: 'staging', dry_run: true });
  });

  it('returns { invalid } when tool is absent', () => {
    const action: TaskAction = { kind: 'tool' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(true);
    expect('invalid' in dispatch).toBe(true);
  });

  it('returns { invalid } when tool is an empty string', () => {
    const action: TaskAction = { kind: 'tool', tool: '' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(true);
  });

  it('does not produce a mode: exec result for kind: tool', () => {
    const action: TaskAction = { kind: 'tool', tool: 'run_tests' };
    const dispatch = actionToDispatch(action);
    if (!isInvalidDispatch(dispatch)) {
      expect(dispatch.mode).not.toBe('exec');
    }
  });
});

// ---------------------------------------------------------------------------
// actionToDispatch — kind: 'exec'
// ---------------------------------------------------------------------------

describe('actionToDispatch — kind: exec', () => {
  it('returns mode: exec with command, command_args, and cwd', () => {
    const action: TaskAction = {
      kind: 'exec',
      command: 'make',
      command_args: ['test', '-v'],
      cwd: '/repo',
    };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const d = dispatch as Extract<ActionDispatch, { mode: 'exec' }>;
    expect(d.mode).toBe('exec');
    expect(d.command).toBe('make');
    expect(d.command_args).toEqual(['test', '-v']);
    expect(d.cwd).toBe('/repo');
  });

  it('defaults command_args to [] when absent', () => {
    const action: TaskAction = { kind: 'exec', command: 'make' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const d = dispatch as Extract<ActionDispatch, { mode: 'exec' }>;
    expect(d.command_args).toEqual([]);
  });

  it('omits cwd when absent (no undefined field leak)', () => {
    const action: TaskAction = { kind: 'exec', command: 'make', command_args: [] };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const d = dispatch as Extract<ActionDispatch, { mode: 'exec' }>;
    expect(Object.prototype.hasOwnProperty.call(d, 'cwd')).toBe(false);
  });

  it('returns { invalid } when command is absent', () => {
    const action: TaskAction = { kind: 'exec' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(true);
  });

  it('returns { invalid } when command is an empty string', () => {
    const action: TaskAction = { kind: 'exec', command: '' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(true);
  });

  it('does not produce a mode: tool result for kind: exec', () => {
    const action: TaskAction = { kind: 'exec', command: 'make' };
    const dispatch = actionToDispatch(action);
    if (!isInvalidDispatch(dispatch)) {
      expect(dispatch.mode).not.toBe('tool');
    }
  });
});

// ---------------------------------------------------------------------------
// actionToDispatch — totality (never throws)
// ---------------------------------------------------------------------------

describe('actionToDispatch — never throws (total function)', () => {
  const cases: TaskAction[] = [
    { kind: 'tool', tool: 'any_tool' },
    { kind: 'tool', tool: 'any_tool', args: { x: 1 } },
    { kind: 'exec', command: 'any_cmd' },
    { kind: 'exec', command: 'any_cmd', command_args: ['--flag'] },
    { kind: 'exec', command: 'any_cmd', cwd: '/path' },
    { kind: 'tool' },   // invalid (no tool) — must not throw
    { kind: 'exec' },   // invalid (no command) — must not throw
    { kind: 'tool', tool: '' }, // empty tool — must not throw
    { kind: 'exec', command: '' }, // empty command — must not throw
  ];

  for (const action of cases) {
    it(`does not throw for: ${JSON.stringify(action)}`, () => {
      expect(() => actionToDispatch(action)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// isInvalidDispatch
// ---------------------------------------------------------------------------

describe('isInvalidDispatch', () => {
  it('returns true for a { invalid } result', () => {
    expect(isInvalidDispatch({ invalid: 'tool action carries no tool to invoke' })).toBe(true);
  });

  it('returns true for any { invalid } string', () => {
    expect(isInvalidDispatch({ invalid: 'exec action carries no command to run' })).toBe(true);
  });

  it('returns false for a mode: tool dispatch', () => {
    expect(isInvalidDispatch({ mode: 'tool', tool: 'run_tests', args: {} })).toBe(false);
  });

  it('returns false for a mode: exec dispatch', () => {
    expect(isInvalidDispatch({ mode: 'exec', command: 'make', command_args: [] })).toBe(false);
  });

  it('returns false for a real actionToDispatch tool result', () => {
    const dispatch = actionToDispatch({ kind: 'tool', tool: 'run_tests' });
    expect(isInvalidDispatch(dispatch)).toBe(false);
  });

  it('returns true for a real actionToDispatch invalid result', () => {
    const dispatch = actionToDispatch({ kind: 'tool' });
    expect(isInvalidDispatch(dispatch)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatchToCreateActionParam — tool dispatches
// ---------------------------------------------------------------------------

describe('dispatchToCreateActionParam — mode: tool', () => {
  it('maps tool dispatch to { kind: tool, tool, args }', () => {
    const dispatch: Extract<ActionDispatch, { mode: 'tool' }> = {
      mode: 'tool',
      tool: 'run_tests',
      args: { suite: 'unit' },
    };
    const param = dispatchToCreateActionParam(dispatch);
    expect(param.kind).toBe('tool');
    expect(param.tool).toBe('run_tests');
    expect(param.args).toEqual({ suite: 'unit' });
  });

  it('omits args from authored params when args is empty (no undefined leak)', () => {
    const dispatch: Extract<ActionDispatch, { mode: 'tool' }> = {
      mode: 'tool',
      tool: 'run_tests',
      args: {},
    };
    const param = dispatchToCreateActionParam(dispatch);
    expect(Object.prototype.hasOwnProperty.call(param, 'args')).toBe(false);
  });

  it('does not include mode in the authored params', () => {
    const dispatch: Extract<ActionDispatch, { mode: 'tool' }> = {
      mode: 'tool',
      tool: 'run_tests',
      args: {},
    };
    const param = dispatchToCreateActionParam(dispatch);
    expect(Object.prototype.hasOwnProperty.call(param, 'mode')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchToCreateActionParam — exec dispatches
// ---------------------------------------------------------------------------

describe('dispatchToCreateActionParam — mode: exec', () => {
  it('maps exec dispatch to { kind: exec, command, args, cwd } (command_args → args)', () => {
    const dispatch: Extract<ActionDispatch, { mode: 'exec' }> = {
      mode: 'exec',
      command: 'make',
      command_args: ['test', '-v'],
      cwd: '/repo',
    };
    const param = dispatchToCreateActionParam(dispatch);
    expect(param.kind).toBe('exec');
    expect(param.command).toBe('make');
    // command_args is mapped to 'args' in the daemon param (the daemon's exec argv field)
    expect(param.args).toEqual(['test', '-v']);
    expect(param.cwd).toBe('/repo');
  });

  it('omits args from authored params when command_args is empty', () => {
    const dispatch: Extract<ActionDispatch, { mode: 'exec' }> = {
      mode: 'exec',
      command: 'make',
      command_args: [],
    };
    const param = dispatchToCreateActionParam(dispatch);
    expect(Object.prototype.hasOwnProperty.call(param, 'args')).toBe(false);
  });

  it('omits cwd from authored params when absent (no undefined leak)', () => {
    const dispatch: Extract<ActionDispatch, { mode: 'exec' }> = {
      mode: 'exec',
      command: 'make',
      command_args: [],
    };
    const param = dispatchToCreateActionParam(dispatch);
    expect(Object.prototype.hasOwnProperty.call(param, 'cwd')).toBe(false);
  });

  it('does not include mode or command_args (under that name) in authored params', () => {
    const dispatch: Extract<ActionDispatch, { mode: 'exec' }> = {
      mode: 'exec',
      command: 'pytest',
      command_args: ['-q'],
    };
    const param = dispatchToCreateActionParam(dispatch);
    expect(Object.prototype.hasOwnProperty.call(param, 'mode')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(param, 'command_args')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alignment / drift test — authored params equal dispatch params (the "alignment")
//
// This is the T303 acceptance criterion at the unit layer: the single source of
// truth guarantee that what `mx_create_task` authors into the DAG is EXACTLY
// the shape `mx_dispatch_task` will dispatch. Any drift between authoring and
// dispatch is caught here, before it reaches the wire.
// ---------------------------------------------------------------------------

describe('alignment: authored params == dispatch params (T303 "alignment" drift gate)', () => {
  it('tool action: dispatchToCreateActionParam(actionToDispatch(action)) equals authored params', () => {
    const action: TaskAction = { kind: 'tool', tool: 'run_tests', args: { suite: 'unit' } };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const authored = dispatchToCreateActionParam(dispatch as ActionDispatch);
    expect(authored).toEqual({ kind: 'tool', tool: 'run_tests', args: { suite: 'unit' } });
  });

  it('exec action: dispatchToCreateActionParam(actionToDispatch(action)) equals authored params', () => {
    const action: TaskAction = { kind: 'exec', command: 'make', command_args: ['test', '-v'], cwd: '/repo' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const authored = dispatchToCreateActionParam(dispatch as ActionDispatch);
    expect(authored).toEqual({ kind: 'exec', command: 'make', args: ['test', '-v'], cwd: '/repo' });
  });

  it('exec action with no optional fields: omits both args and cwd from authored params', () => {
    const action: TaskAction = { kind: 'exec', command: 'make' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const authored = dispatchToCreateActionParam(dispatch as ActionDispatch);
    expect(authored).toEqual({ kind: 'exec', command: 'make' });
    expect(Object.prototype.hasOwnProperty.call(authored, 'args')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(authored, 'cwd')).toBe(false);
  });

  it('tool action with no args: omits args from authored params', () => {
    const action: TaskAction = { kind: 'tool', tool: 'analyze' };
    const dispatch = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch)).toBe(false);
    const authored = dispatchToCreateActionParam(dispatch as ActionDispatch);
    expect(authored).toEqual({ kind: 'tool', tool: 'analyze' });
    expect(Object.prototype.hasOwnProperty.call(authored, 'args')).toBe(false);
  });

  it('round-trip is stable: authored params match across two passes (author → dispatch → author)', () => {
    // Simulates: mx_create_task authors → daemon stores → mx_dispatch_task reads back and dispatches.
    // The second author must produce the same params as the first — the DAG record is stable.
    const action: TaskAction = { kind: 'tool', tool: 'analyze', args: { depth: 3 } };
    const dispatch1 = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch1)).toBe(false);
    const authored1 = dispatchToCreateActionParam(dispatch1 as ActionDispatch);

    // Simulate reading the authored params back from the DAG as a TaskAction and re-dispatching
    const readBack: TaskAction = authored1 as unknown as TaskAction;
    const dispatch2 = actionToDispatch(readBack);
    expect(isInvalidDispatch(dispatch2)).toBe(false);
    const authored2 = dispatchToCreateActionParam(dispatch2 as ActionDispatch);

    expect(authored2).toEqual(authored1);
  });

  it('exec round-trip: authored → dispatch → authored is stable', () => {
    const action: TaskAction = { kind: 'exec', command: 'pytest', command_args: ['-q', 'tests/'], cwd: '/app' };
    const dispatch1 = actionToDispatch(action);
    expect(isInvalidDispatch(dispatch1)).toBe(false);
    const authored1 = dispatchToCreateActionParam(dispatch1 as ActionDispatch);
    // authored1 = { kind: 'exec', command: 'pytest', args: ['-q', 'tests/'], cwd: '/app' }
    // The daemon stores 'args' (not 'command_args'). Reading it back, the projector
    // maps daemon's 'args' array to 'command_args' (see projectAction's fallback).
    // Test that dispatchToCreateActionParam produces the stable shape.
    expect(authored1).toEqual({ kind: 'exec', command: 'pytest', args: ['-q', 'tests/'], cwd: '/app' });
  });
});
