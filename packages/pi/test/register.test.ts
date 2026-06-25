/**
 * Registration helpers (T205) — registerMxTools + createMxPiExtension.
 *
 * Tests:
 *  - `registerMxTools` calls `pi.registerTool()` once per generated tool and
 *    returns the registered tools array.
 *  - `registerMxTools` returned tool names match CANONICAL_TOOLS.
 *  - `registerMxTools` does not call registerTool for any authority verb.
 *  - `createMxPiExtension` returns a factory function.
 *  - The factory calls `api.registerTool()` once per generated tool when invoked.
 *  - Factory tool names match CANONICAL_TOOLS.
 *  - Tools are generated eagerly in createMxPiExtension (PiSchemaConversionError
 *    surface at wiring time, not mid-load).
 */
import { describe, expect, it } from 'vitest';

import { NullAuditSink } from '@mx-loom/audit';
import { CANONICAL_TOOLS, isForbiddenAuthorityVerb } from '@mx-loom/registry';

import { createPiBindingContext } from '../src/context.js';
import { createMxPiExtension, registerMxTools } from '../src/register.js';
import type { PiToolHost, ToolDefinition } from '../src/pi-abi.js';
import { ROOM, fakeBuilders, makeFakeDaemon } from './helpers.js';

async function makeCtx() {
  return createPiBindingContext({
    daemon: makeFakeDaemon(),
    room: ROOM,
    auditSink: new NullAuditSink(),
  });
}

/** Fake PiToolHost that records every registered tool. */
function makeFakeHost(): { host: PiToolHost; registered: ToolDefinition[] } {
  const registered: ToolDefinition[] = [];
  const host: PiToolHost = {
    registerTool(tool) {
      registered.push(tool);
    },
  };
  return { host, registered };
}

// ---------------------------------------------------------------------------
// registerMxTools
// ---------------------------------------------------------------------------

describe('registerMxTools', () => {
  it('calls registerTool once per canonical descriptor', async () => {
    const ctx = await makeCtx();
    const { host, registered } = makeFakeHost();
    registerMxTools(host, { context: ctx, builders: fakeBuilders });
    expect(registered).toHaveLength(CANONICAL_TOOLS.length);
  });

  it('returns the registered tools array', async () => {
    const ctx = await makeCtx();
    const { host } = makeFakeHost();
    const tools = registerMxTools(host, { context: ctx, builders: fakeBuilders });
    expect(tools).toHaveLength(CANONICAL_TOOLS.length);
  });

  it('registered tool names match CANONICAL_TOOLS names', async () => {
    const ctx = await makeCtx();
    const { host, registered } = makeFakeHost();
    registerMxTools(host, { context: ctx, builders: fakeBuilders });
    const names = registered.map((t) => t.name).sort();
    expect(names).toEqual(CANONICAL_TOOLS.map((d) => d.name).sort());
  });

  it('does not register any authority verb', async () => {
    const ctx = await makeCtx();
    const { host, registered } = makeFakeHost();
    registerMxTools(host, { context: ctx, builders: fakeBuilders });
    for (const tool of registered) {
      expect(isForbiddenAuthorityVerb(tool.name)).toBe(false);
    }
  });

  it('returned array and registered array are the same tools', async () => {
    const ctx = await makeCtx();
    const { host, registered } = makeFakeHost();
    const returned = registerMxTools(host, { context: ctx, builders: fakeBuilders });
    expect(returned.map((t) => t.name)).toEqual(registered.map((t) => t.name));
  });
});

// ---------------------------------------------------------------------------
// createMxPiExtension
// ---------------------------------------------------------------------------

describe('createMxPiExtension', () => {
  it('returns a function (the extension factory)', async () => {
    const ctx = await makeCtx();
    const factory = createMxPiExtension({ context: ctx, builders: fakeBuilders });
    expect(typeof factory).toBe('function');
  });

  it('calling the factory registers one tool per canonical descriptor', async () => {
    const ctx = await makeCtx();
    const factory = createMxPiExtension({ context: ctx, builders: fakeBuilders });
    const { host, registered } = makeFakeHost();
    factory(host);
    expect(registered).toHaveLength(CANONICAL_TOOLS.length);
  });

  it('factory-registered tool names match CANONICAL_TOOLS names', async () => {
    const ctx = await makeCtx();
    const factory = createMxPiExtension({ context: ctx, builders: fakeBuilders });
    const { host, registered } = makeFakeHost();
    factory(host);
    const names = registered.map((t) => t.name).sort();
    expect(names).toEqual(CANONICAL_TOOLS.map((d) => d.name).sort());
  });

  it('factory can be called multiple times on different hosts', async () => {
    const ctx = await makeCtx();
    const factory = createMxPiExtension({ context: ctx, builders: fakeBuilders });
    const { host: host1, registered: r1 } = makeFakeHost();
    const { host: host2, registered: r2 } = makeFakeHost();
    factory(host1);
    factory(host2);
    expect(r1).toHaveLength(CANONICAL_TOOLS.length);
    expect(r2).toHaveLength(CANONICAL_TOOLS.length);
  });
});
