-- T113 / #21 — the queryable index of the two-tier audit (design §7/§8).
--
-- The substrate (signed `com.mxagent.*` Matrix event stream) is the tamper-evident
-- truth; this table is the *mirror* an operator searches. One row per returned
-- tool-result envelope. It stores a strict, NON-SECRET subset: correlation ids
-- (none a secret), the closed-set tool_name/status/error_code, and the
-- approval/idempotency/correlation pointers — never a `result` payload, the
-- free-text `error.message`, or the `approval.summary`.
--
-- Idempotent (every statement `IF NOT EXISTS`) so `migrate()` can run repeatedly.
-- Plain SQL, no migration framework, for M1 minimalism. Single-tenant: NO RLS,
-- NO tenant_id (Multi-tenant RLS is M5 / T502, which keys on `room`).

CREATE TABLE IF NOT EXISTS mx_audit_log (
  id              BIGSERIAL PRIMARY KEY,

  -- audit_ref: the daemon invocation / substrate-truth pointer (nullable — a
  -- local read has an all-null audit_ref; a `running` result may precede the ids).
  invocation_id   TEXT,
  request_id      TEXT,
  room            TEXT,
  event_id        TEXT,

  -- model action
  tool_name       TEXT NOT NULL,
  correlation_id  TEXT,
  idempotency_key TEXT,

  -- outcome / approval (status & error_code validated in code against the closed
  -- T102 sets — TEXT, not a PG ENUM, to avoid a migration on every code change).
  status          TEXT NOT NULL,
  error_code      TEXT,
  approval_request_id TEXT,

  -- bookkeeping + exactly-once
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedup_key       TEXT NOT NULL
);

-- exactly-once mirror (AC 1): a second write of the same emission is a no-op
-- via `INSERT … ON CONFLICT (dedup_key) DO NOTHING`.
CREATE UNIQUE INDEX IF NOT EXISTS mx_audit_log_dedup_key_uq ON mx_audit_log (dedup_key);

-- correlation query paths (AC 2): join a deferred call's lifecycle by
-- invocation, recover a session's results by correlation, scope/sort by room.
CREATE INDEX IF NOT EXISTS mx_audit_log_invocation_idx    ON mx_audit_log (invocation_id);
CREATE INDEX IF NOT EXISTS mx_audit_log_correlation_idx   ON mx_audit_log (correlation_id);
CREATE INDEX IF NOT EXISTS mx_audit_log_room_recorded_idx ON mx_audit_log (room, recorded_at);
