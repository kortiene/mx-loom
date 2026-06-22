import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { IpcClient } from '../src/ipc/client.js';
import { resolveSocketPath } from '../src/ipc/socket-path.js';

// Live integration test against a running mx-agent daemon. Gated on the socket
// existing so CI (and machines without a daemon) skip cleanly; runs when a
// daemon is up (e.g. `mx-agent daemon start`).
const socketPath = resolveSocketPath();
const live = existsSync(socketPath);

describe.skipIf(!live)('IpcClient against the live mx-agent daemon', () => {
  it('round-trips daemon.status over the real socket', async () => {
    const client = new IpcClient();
    try {
      const status = await client.status();
      expect(status.running).toBe(true);
      expect(typeof status.version).toBe('string');
      expect(status.socket_path).toBe(socketPath);
    } finally {
      await client.close();
    }
  });
});
