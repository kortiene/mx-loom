/**
 * Wire framing for the mx-agent daemon IPC: a 4-byte big-endian length prefix
 * followed by a UTF-8 JSON payload. Verified empirically against mx-agent
 * v0.2.1 (see docs/mx-agent-surface-v0.2.1.md).
 */
import { IpcError } from './errors.js';

export const HEADER_BYTES = 4;

/** Hard cap on a single frame, guarding against a garbage length prefix. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Encode a payload string as a length-prefixed frame. */
export function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new IpcError('frame', `outbound frame too large: ${body.length} > ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder: feed arbitrary chunks via {@link push}, receive zero or
 * more complete frame payloads. Partial frames are buffered across chunk
 * boundaries; an implausibly large length prefix throws `IpcError('frame')`.
 */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: string[] = [];
    for (;;) {
      if (this.#buf.length < HEADER_BYTES) break;
      const len = this.#buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new IpcError('frame', `inbound frame length ${len} exceeds max ${MAX_FRAME_BYTES}`);
      }
      if (this.#buf.length < HEADER_BYTES + len) break;
      out.push(this.#buf.subarray(HEADER_BYTES, HEADER_BYTES + len).toString('utf8'));
      this.#buf = this.#buf.subarray(HEADER_BYTES + len);
    }
    return out;
  }

  /** Bytes currently buffered awaiting a complete frame. */
  get pending(): number {
    return this.#buf.length;
  }
}
