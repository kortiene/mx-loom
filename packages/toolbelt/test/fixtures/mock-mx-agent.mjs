#!/usr/bin/env node
/**
 * Fixture CLI for CliClient tests. Simulates mx-agent --json behavior.
 * Behavior is driven by the non-flag argv segments joined with spaces.
 *
 * Synthetic values only — no real tokens, credentials, or secrets.
 */

// Synthetic AgentState returned by agent.register and agent.list (T005 session tests).
// Field names match agent-state.ts AgentState; values are all synthetic/non-secret.
const MOCK_AGENT_STATE = {
  agent_id: 'agent-fixture-session-001',
  kind: 'runtime',
  matrix_user_id: '@session-fixture:localhost',
  device_id: 'DEVFIXTURE',
  signing_key_id: 'mxagent-ed25519:FIXTUREKEYID',
  signing_public_key: 'Zml4dHVyZS1wdWJsaWMta2V5LWJhc2U2NA==', // synthetic base64
  status: 'active',
  capabilities: [],
  tools: [],
  workspace: {},
  load: { running_invocations: 0, max_invocations: 10 },
  last_seen_ts: 1_700_001_000_000,
  state_rev: 1,
};

const args = process.argv.slice(2);

// Non-flag segments identify the command; strip --xxx and bare - from argv.
const nonFlags = args.filter((a) => !a.startsWith('--') && a !== '-');
const hasInputJson = args.includes('--input-json') && args.includes('-');
const cmd = nonFlags.join(' ');

async function main() {
  let stdinData = '';
  if (hasInputJson) {
    for await (const chunk of process.stdin) {
      stdinData += String(chunk);
    }
  }

  switch (cmd) {
    case 'daemon status': {
      process.stdout.write(
        JSON.stringify({
          running: true,
          pid: 12345,
          uptime_seconds: 3600,
          socket_path: '/tmp/mx-agent/daemon.sock',
          version: '0.2.1',
        }),
      );
      break;
    }

    case 'daemon ping':
      process.stdout.write(JSON.stringify({ pong: true }));
      break;

    case 'mock wrapped':
      // Returns {jsonrpc, id, result} envelope — CliClient should unwrap to .result
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { answer: 42 } }));
      break;

    case 'mock rpc error':
      // JSON-RPC error on stdout — normalizeExit maps to TransportError('rpc')
      process.stdout.write(JSON.stringify({ error: { code: -32601, message: 'method not found' } }));
      break;

    case 'mock stderr error':
      // JSON-RPC error on stderr, non-zero exit — normalizeExit maps to TransportError('rpc')
      process.stderr.write(JSON.stringify({ error: { code: -32600, message: 'invalid request from stderr' } }));
      process.exit(1);
      break;

    case 'mock hang':
      // Keep the event loop alive until the parent kills this process with SIGKILL
      // (timeout test). A bare `await new Promise(() => {})` drains the event loop
      // and lets Node.js exit with code 0; a long-interval timer prevents that.
      await new Promise(() => setInterval(() => {}, 60_000));
      break;

    case 'mock no json':
      // Non-zero exit + non-JSON stdout — TransportError('protocol')
      process.stdout.write('this is not valid JSON output\n');
      process.exit(1);
      break;

    case 'mock empty exit0':
      // Exit 0 with empty stdout — TransportError('protocol')
      process.exit(0);
      break;

    case 'mock signal':
      // Die with SIGTERM — TransportError('protocol') with signal info
      process.kill(process.pid, 'SIGTERM');
      break;

    case 'mock echo stdin':
      // Echo raw stdin back to stdout (params-via-stdin test)
      process.stdout.write(stdinData);
      break;

    case 'mock dump env':
      // Output process.env as JSON (env allowlist test)
      process.stdout.write(JSON.stringify(process.env));
      break;

    case 'mock null result':
      // {result: null} — CliClient should unwrap to null (not the wrapper object)
      process.stdout.write(JSON.stringify({ result: null }));
      break;

    case 'mock array result':
      // Bare array — no `result` field, so returned as-is (array is not a wrapper)
      process.stdout.write(JSON.stringify([1, 2, 3]));
      break;

    case 'mock rpc error nonzero':
      // JSON-RPC error on stdout AND non-zero exit — should still map to 'rpc'
      process.stdout.write(JSON.stringify({ error: { code: -32603, message: 'internal error' } }));
      process.exit(1);
      break;

    case 'mock oversized':
      // Write > MAX_FRAME_BYTES (16 MB) to trigger the parent's overflow guard.
      // Parent sends SIGKILL once the threshold is exceeded; we don't need to finish.
      process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 42));
      break;

    case 'mock dump argv':
      // Output process.argv.slice(2) as JSON so the parent can verify param values
      // are absent from argv (never-on-argv E2E proof). The parent strips flags
      // before routing via methodToArgv; this case must be reachable via 'mock dump argv'.
      process.stdout.write(JSON.stringify(process.argv.slice(2)));
      break;

    case 'mock leak secret':
      // Simulates a daemon bug: returns a token-shaped value in the result.
      // MxClient inbound redaction (T008) must replace it with REDACTION_PLACEHOLDER
      // before it reaches the caller. SYNTHETIC value — not a real token.
      process.stdout.write(JSON.stringify({ result: { ok: true, leaked: 'ghp_FAKEleaked_by_daemon_bug_0000' } }));
      break;

    case 'agent register':
      // Simulates daemon agent.register: params arrive via stdin (--input-json -).
      // Returns the synthetic AgentState wrapped in a {result} envelope so
      // CliClient.unwrapResult() extracts the AgentState (matching IPC behavior).
      // stdinData is already drained by the hasInputJson block above.
      process.stdout.write(JSON.stringify({ result: MOCK_AGENT_STATE }));
      break;

    case 'agent list':
      // Simulates daemon agent.list: returns one entry for the fixture agent as active.
      process.stdout.write(
        JSON.stringify({ result: [{ agent: MOCK_AGENT_STATE, liveness: 'active' }] }),
      );
      break;

    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(127);
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
