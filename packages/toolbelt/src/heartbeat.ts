/**
 * Cancellable liveness heartbeat for {@link import('./session.js').MxSession} (T005).
 *
 * `agent.list` reports a per-agent liveness (`active | stale | offline`) derived
 * from `last_seen_ts`, but nothing refreshes that timestamp on its own, so a
 * registered-but-idle agent decays to `stale`/`offline` while its runtime is
 * alive. This module runs a bounded interval loop whose `tick` refreshes
 * `last_seen_ts`, keeping the agent `active` for the session's lifetime (AC 2).
 *
 * It is intentionally transport-agnostic and timer-injectable, mirroring
 * `retry.ts`'s inject-the-timer discipline so unit tests drive ticks
 * deterministically (advance a fake scheduler) with no real waits. The *what*
 * of a tick — re-`agent.register` (the default), a dedicated `agent.heartbeat`,
 * or a poll — is the session's concern; this loop only schedules and guards it.
 *
 * Failure tolerance: a rejecting tick must never crash the process or surface an
 * unhandled rejection. The loop catches, reports a redaction-safe outcome via
 * {@link HeartbeatOptions.onTick} (code only — never params/secrets), and
 * continues; a transient miss may dip liveness to `stale` and the next success
 * restores `active`.
 */
import { TransportError } from './transport.js';

/** Handle to a running heartbeat — `stop()` is idempotent; no tick fires after it. */
export interface HeartbeatHandle {
  stop(): void;
}

/** Injected scheduler: register `fn` to fire every `ms`, returning a stop handle. */
export type HeartbeatSchedule = (fn: () => void, ms: number) => { stop: () => void };

export interface HeartbeatOptions {
  /** Interval in ms. Must be shorter than the daemon's `active → stale` window. */
  intervalMs: number;
  /** One liveness-refresh tick. Resolves on success; rejects with a `TransportError` on failure. */
  tick: () => Promise<void>;
  /** Injected scheduler (testing seam). Default: a real, unref'd `setInterval` wrapped to a stop handle. */
  schedule?: HeartbeatSchedule;
  /** Redaction-safe notification of each tick outcome — `'ok'` or `{ code }`, never secrets. */
  onTick?: (outcome: 'ok' | { code: string }) => void;
}

function realSchedule(fn: () => void, ms: number): { stop: () => void } {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function codeOf(err: unknown): string {
  return err instanceof TransportError ? err.code : 'internal';
}

/**
 * Start the heartbeat. Ticks fire every `intervalMs`; overlapping ticks are
 * suppressed (a slow tick is never re-entered before it settles). `stop()`
 * cancels the schedule and guarantees no further `tick`/`onTick` after it.
 */
export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  const schedule = opts.schedule ?? realSchedule;
  let stopped = false;
  let inFlight = false;

  const handle = schedule(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void opts
      .tick()
      .then(() => {
        if (!stopped) opts.onTick?.('ok');
      })
      .catch((err: unknown) => {
        if (!stopped) opts.onTick?.({ code: codeOf(err) });
      })
      .finally(() => {
        inFlight = false;
      });
  }, opts.intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      handle.stop();
    },
  };
}
