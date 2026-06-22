import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSocketPath } from '../src/ipc/socket-path.js';

describe('resolveSocketPath', () => {
  it('honors an explicit override above everything else', () => {
    expect(
      resolveSocketPath({ socketPath: '/tmp/custom.sock', env: { XDG_RUNTIME_DIR: '/run/user/1000' } }),
    ).toBe('/tmp/custom.sock');
  });

  it('uses $XDG_RUNTIME_DIR when set', () => {
    expect(resolveSocketPath({ env: { XDG_RUNTIME_DIR: '/run/user/1000' } })).toBe(
      join('/run/user/1000', 'mx-agent', 'daemon.sock'),
    );
  });

  it('falls back to $TMPDIR when XDG_RUNTIME_DIR is unset (macOS)', () => {
    expect(resolveSocketPath({ env: { TMPDIR: '/var/folders/xx/T/' } })).toBe(
      join('/var/folders/xx/T/', 'mx-agent', 'daemon.sock'),
    );
  });
});
