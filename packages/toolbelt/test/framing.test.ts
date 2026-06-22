import { describe, expect, it } from 'vitest';

import { IpcError } from '../src/ipc/errors.js';
import { encodeFrame, FrameDecoder, HEADER_BYTES, MAX_FRAME_BYTES } from '../src/ipc/framing.js';

describe('framing', () => {
  it('encodes a 4-byte big-endian length prefix + utf8 body', () => {
    const frame = encodeFrame('hi');
    expect(frame.length).toBe(HEADER_BYTES + 2);
    expect(frame.readUInt32BE(0)).toBe(2);
    expect(frame.subarray(HEADER_BYTES).toString('utf8')).toBe('hi');
  });

  it('round-trips a single frame', () => {
    const decoder = new FrameDecoder();
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'daemon.status' });
    expect(decoder.push(encodeFrame(payload))).toEqual([payload]);
    expect(decoder.pending).toBe(0);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame('hello world');
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]); // partial header
    expect(decoder.push(frame.subarray(2, 6))).toEqual([]); // rest of header + partial body
    expect(decoder.push(frame.subarray(6))).toEqual(['hello world']);
    expect(decoder.pending).toBe(0);
  });

  it('returns multiple frames from one chunk and keeps a trailing partial', () => {
    const decoder = new FrameDecoder();
    const c = encodeFrame('ccc');
    const combined = Buffer.concat([encodeFrame('a'), encodeFrame('bb'), c.subarray(0, 3)]);
    expect(decoder.push(combined)).toEqual(['a', 'bb']);
    expect(decoder.pending).toBe(3);
    expect(decoder.push(c.subarray(3))).toEqual(['ccc']);
  });

  it('throws IpcError(frame) on an oversized inbound length prefix', () => {
    const bad = Buffer.alloc(HEADER_BYTES);
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(bad)).toThrow(IpcError);
    try {
      new FrameDecoder().push(bad);
      expect.unreachable();
    } catch (err) {
      expect((err as IpcError).code).toBe('frame');
    }
  });

  it('throws when encoding a payload larger than MAX_FRAME_BYTES', () => {
    expect(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(IpcError);
  });
});
