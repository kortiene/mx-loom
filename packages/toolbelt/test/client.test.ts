import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IpcClient } from '../src/ipc/client.js';
import { IpcError } from '../src/ipc/errors.js';
import { encodeFrame, FrameDecoder } from '../src/ipc/framing.js';

interface Req {
  id: string;
  method: string;
  params?: unknown;
}
type Handler = (req: Req, socket: Socket) => void;

function mockDaemon(socketPath: string, handler: Handler): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) handler(JSON.parse(frame) as Req, socket);
      });
      socket.on('error', () => {
        /* client close races — ignore */
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

function reply(socket: Socket, id: string, result: unknown): void {
  socket.write(encodeFrame(JSON.stringify({ jsonrpc: '2.0', id, result })));
}
function replyError(socket: Socket, id: string, code: number, message: string): void {
  socket.write(encodeFrame(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })));
}

describe('IpcClient (mock daemon)', () => {
  let dir: string;
  let sock: string;
  let server: Server | undefined;
  let client: IpcClient | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-ipc-'));
    sock = join(dir, 'd.sock');
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a request and correlates the response by id', async () => {
    server = await mockDaemon(sock, (req, s) => reply(s, req.id, { echoed: req.method, params: req.params }));
    client = new IpcClient({ socketPath: sock });
    await expect(client.call('daemon.status', { a: 1 })).resolves.toEqual({
      echoed: 'daemon.status',
      params: { a: 1 },
    });
  });

  it('correlates concurrent calls even when replies arrive out of order', async () => {
    server = await mockDaemon(sock, (req, s) => {
      setTimeout(() => reply(s, req.id, req.method), req.method === 'slow' ? 40 : 1);
    });
    client = new IpcClient({ socketPath: sock });
    const results = await Promise.all([client.call('slow'), client.call('fast')]);
    expect(results).toEqual(['slow', 'fast']);
  });

  it('maps a JSON-RPC error to IpcError(rpc)', async () => {
    server = await mockDaemon(sock, (req, s) => replyError(s, req.id, -32601, 'method not found'));
    client = new IpcClient({ socketPath: sock });
    await expect(client.call('nope')).rejects.toMatchObject({ code: 'rpc' });
  });

  it('times out when the daemon never responds', async () => {
    server = await mockDaemon(sock, () => {
      /* swallow the request */
    });
    client = new IpcClient({ socketPath: sock });
    await expect(client.call('hang', undefined, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('surfaces a malformed (non-JSON) response frame as an IpcError', async () => {
    server = await mockDaemon(sock, (_req, s) => s.write(encodeFrame('this is not json')));
    client = new IpcClient({ socketPath: sock });
    await expect(client.call('x')).rejects.toBeInstanceOf(IpcError);
  });

  it('reports not_running when the socket does not exist', async () => {
    client = new IpcClient({ socketPath: join(dir, 'absent.sock') });
    await expect(client.call('x', undefined, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'not_running' });
  });
});
