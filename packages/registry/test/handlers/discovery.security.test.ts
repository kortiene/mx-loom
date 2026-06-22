/**
 * Security invariants for the T104 discovery handlers (`mxFindAgents` /
 * `mxDescribeAgent`) and the `agent-projection.ts` module (design §4.7, §6,
 * §2 / the secret-free output boundary).
 *
 * Tests pin:
 * - `matrix_user_id`, `device_id`, `signing_key_id`, `signing_public_key`, and
 *   `state_rev` are ABSENT from every `mxFindAgents` agent-summary output.
 * - The same forbidden fields are ABSENT from every `mxDescribeAgent` agent-detail.
 * - An extra, unexpected field in the daemon payload (e.g. a synthetic secret)
 *   does NOT appear in the projected output (allowlist-by-construction).
 * - The `mx_find_agents` and `mx_describe_agent` `input_schema`s declare no
 *   credential-shaped property (the T101 loader already enforces this, but an
 *   explicit regression here catches a future descriptor edit).
 * - The discovery handlers are purely read-only: they issue no approve / decide /
 *   mutate RPC.
 * - Resolved ok envelopes pass `redactSecrets` unchanged (no false-positive
 *   redaction of projected agent fields).
 * - Resolved ok envelopes are deeply frozen.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { redactSecrets } from '@mx-loom/toolbelt';

import {
  MX_DESCRIBE_AGENT,
  MX_FIND_AGENTS,
  mxDescribeAgent,
  mxFindAgents,
  type DaemonCall,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_FIELDS = ['matrix_user_id', 'device_id', 'signing_key_id', 'signing_public_key', 'state_rev'];

/** An AgentState with ALL noisy / sensitive fields populated. */
const FULL_AGENT_STATE = {
  agent_id: 'ag_sec_01',
  kind: 'worker',
  status: 'online',
  capabilities: ['code_execution'],
  tools: ['run_tests'],
  workspace: { cwd: '/tmp', project_id: 'proj_1', git_commit: 'abc123' },
  load: { running_invocations: 0, max_invocations: 4 },
  last_seen_ts: 1_700_000_000,
  // Fields that MUST NOT reach the model context (non-secret but noisy identifiers).
  matrix_user_id: '@ag_sec_01:homeserver',
  device_id: 'DEVICE_SEC_01',
  signing_key_id: 'ed25519:KEY_ID_01',
  signing_public_key: 'ed25519:AABB==',
  state_rev: 42,
  // Synthetic extra field (not in AgentState at all) to verify allowlist.
  __unexpected_extra: 'should_not_appear',
};

const TOOLS_RESPONSE = {
  agent_id: 'ag_sec_01',
  kind: 'worker',
  status: 'online',
  capabilities: ['code_execution'],
  tools: ['run_tests'],
  schemas: [{ name: 'run_tests', input_schema: { type: 'object' }, output_schema: { type: 'object' } }],
};

const LIST_RESPONSE = [{ agent: FULL_AGENT_STATE, liveness: 'active' }];

function makeFindDeps(listResp: unknown): { daemon: DaemonCall } {
  return {
    daemon: {
      call: async () => listResp,
    },
  };
}

function makeDescribeDeps(): { daemon: DaemonCall } {
  return {
    daemon: {
      call: async (method) => {
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        return LIST_RESPONSE;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// mxFindAgents — forbidden field absence in agent summaries
// ---------------------------------------------------------------------------

describe('mxFindAgents — secret and noisy fields are absent from agent summaries', () => {
  it('matrix_user_id is absent from every AgentSummary in the output', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const json = JSON.stringify(result);
    expect(json).not.toContain('matrix_user_id');
    expect(json).not.toContain('@ag_sec_01:homeserver');
  });

  it('device_id is absent from every AgentSummary', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const json = JSON.stringify(result);
    expect(json).not.toContain('device_id');
    expect(json).not.toContain('DEVICE_SEC_01');
  });

  it('signing_key_id is absent from every AgentSummary', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const json = JSON.stringify(result);
    expect(json).not.toContain('signing_key_id');
    expect(json).not.toContain('KEY_ID_01');
  });

  it('signing_public_key is absent from every AgentSummary', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const json = JSON.stringify(result);
    expect(json).not.toContain('signing_public_key');
  });

  it('state_rev is absent from every AgentSummary', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const json = JSON.stringify(result);
    expect(json).not.toContain('state_rev');
  });

  it('an unexpected extra field in the daemon payload does NOT appear in the summary', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const json = JSON.stringify(result);
    expect(json).not.toContain('__unexpected_extra');
    expect(json).not.toContain('should_not_appear');
  });

  it('all forbidden fields are absent in a single serialization check', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const json = JSON.stringify(result);
    for (const field of FORBIDDEN_FIELDS) {
      expect(json).not.toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// mxDescribeAgent — forbidden field absence in agent detail
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — secret and noisy fields are absent from agent detail', () => {
  it('matrix_user_id is absent from the AgentDetail in the output', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const json = JSON.stringify(result);
    expect(json).not.toContain('matrix_user_id');
    expect(json).not.toContain('@ag_sec_01:homeserver');
  });

  it('device_id is absent from the AgentDetail', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const json = JSON.stringify(result);
    expect(json).not.toContain('device_id');
    expect(json).not.toContain('DEVICE_SEC_01');
  });

  it('signing_key_id is absent from the AgentDetail', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const json = JSON.stringify(result);
    expect(json).not.toContain('signing_key_id');
    expect(json).not.toContain('KEY_ID_01');
  });

  it('signing_public_key is absent from the AgentDetail', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const json = JSON.stringify(result);
    expect(json).not.toContain('signing_public_key');
  });

  it('state_rev is absent from the AgentDetail', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const json = JSON.stringify(result);
    expect(json).not.toContain('state_rev');
  });

  it('an unexpected extra field in the list row does NOT appear in the agent detail', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const json = JSON.stringify(result);
    expect(json).not.toContain('__unexpected_extra');
    expect(json).not.toContain('should_not_appear');
  });

  it('all forbidden fields are absent in a single serialization check', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const json = JSON.stringify(result);
    for (const field of FORBIDDEN_FIELDS) {
      expect(json).not.toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// Input schema has no credential-shaped fields
// ---------------------------------------------------------------------------

describe('mx_find_agents descriptor — no credential-shaped input property', () => {
  const inputProps = Object.keys(
    (MX_FIND_AGENTS.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
  );

  it('input_schema has no property named "token", "key", "secret", "password", or "credential"', () => {
    const credentialPatterns = ['token', 'key', 'secret', 'password', 'credential'];
    for (const field of inputProps) {
      for (const pattern of credentialPatterns) {
        expect(field.toLowerCase().includes(pattern)).toBe(false);
      }
    }
  });
});

describe('mx_describe_agent descriptor — no credential-shaped input property', () => {
  const inputProps = Object.keys(
    (MX_DESCRIBE_AGENT.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
  );

  it('input_schema has no property named "token", "key", "secret", "password", or "credential"', () => {
    const credentialPatterns = ['token', 'key', 'secret', 'password', 'credential'];
    for (const field of inputProps) {
      for (const pattern of credentialPatterns) {
        expect(field.toLowerCase().includes(pattern)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only: handlers issue no mutating RPCs
// ---------------------------------------------------------------------------

describe('discovery handlers — read-only: no mutating RPCs', () => {
  const MUTATION_METHODS = ['trust.add', 'trust.revoke', 'policy.update', 'approval.decide', 'approval.grant', 'agent.register', 'agent.deregister'];

  it('mxFindAgents calls no mutating daemon methods', async () => {
    const called: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        called.push(method);
        return LIST_RESPONSE;
      },
    };
    await mxFindAgents({}, { daemon: spy });
    for (const m of called) {
      expect(MUTATION_METHODS.includes(m)).toBe(false);
    }
  });

  it('mxDescribeAgent calls no mutating daemon methods', async () => {
    const called: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        called.push(method);
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        return LIST_RESPONSE;
      },
    };
    await mxDescribeAgent({ agent_id: 'ag_sec_01' }, { daemon: spy });
    for (const m of called) {
      expect(MUTATION_METHODS.includes(m)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// redactSecrets pass-through — no false-positive redaction of discovery fields
// ---------------------------------------------------------------------------

describe('discovery handlers — redactSecrets pass-through', () => {
  it('mxFindAgents ok envelope is unchanged after redactSecrets', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('mxDescribeAgent ok envelope is unchanged after redactSecrets', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('mxFindAgents result agent_id is not redacted (non-credential-shaped value)', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const redacted = redactSecrets(result) as typeof result;
    const agents = (redacted.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents[0]!.agent_id).toBe('ag_sec_01');
  });

  it('redactSecrets fires no onRedact callback for a clean mxFindAgents envelope', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    const redactedPaths: string[] = [];
    redactSecrets(result, (path) => redactedPaths.push(path));
    expect(redactedPaths).toHaveLength(0);
  });

  it('redactSecrets fires no onRedact callback for a clean mxDescribeAgent envelope', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    const redactedPaths: string[] = [];
    redactSecrets(result, (path) => redactedPaths.push(path));
    expect(redactedPaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Immutability — discovery envelopes are deeply frozen
// ---------------------------------------------------------------------------

describe('discovery handlers — resolved envelopes are deeply frozen', () => {
  it('mxFindAgents ok envelope is frozen at the top level', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('mxFindAgents ok audit_ref is frozen', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('mxDescribeAgent ok envelope is frozen at the top level', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('mutation of a frozen mxFindAgents envelope field throws in strict mode', async () => {
    const result = await mxFindAgents({}, makeFindDeps(LIST_RESPONSE));
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });

  it('mutation of a frozen mxDescribeAgent envelope field throws in strict mode', async () => {
    const result = await mxDescribeAgent({ agent_id: 'ag_sec_01' }, makeDescribeDeps());
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });
});
