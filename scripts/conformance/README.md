# Conformance bring-up (T007 / #7)

These scripts provision the **live `mx-agent` daemon** the conformance suite
(`packages/toolbelt/test/conformance/`) runs against in CI
(`.github/workflows/conformance.yml`). They are the operator/out-of-band half of
the gate: the toolbelt **never** establishes trust, loads policy, or logs in — it
only issues signed requests and observes the daemon's verdict.

## What runs where

| Tier | Needs | Bring-up | Env the suite reads |
|---|---|---|---|
| 0 — pin identity | daemon A | `bootstrap-daemon-a.sh` | `MXL_CONFORMANCE_SOCKET` |
| 1 — register/list/errors | daemon A | `bootstrap-daemon-a.sh` | `MXL_CONFORMANCE_SOCKET` |
| 2 — `call.start` delegation | daemons A **and** B | `+ bootstrap-daemon-b.sh` | `MXL_CONFORMANCE_ROOM`, `MXL_CONFORMANCE_TARGET_AGENT`, `MXL_CONFORMANCE_TOOL`, `MXL_CONFORMANCE_DENIED_TOOL` |

`MXL_CONFORMANCE=1` (and, for Tier 2, `MXL_CONFORMANCE_TWO_DAEMON=1`) flips the
suite from *skip-when-no-daemon* to *fail-when-no-daemon* — see
`test/conformance/_harness.ts`.

## Provenance (the open decision — Risks #2 in the spec)

The pinned binary and the Tuwunel homeserver live in the **`mx-agent` repo**, not
here. Two options; this directory implements **(b)** by default:

- **(a) self-contained** — vendor a minimal `compose.matrix.yml` + download the
  pinned release binary into mx-loom. No cross-repo coupling, but the homeserver
  fixture can drift from mx-agent's.
- **(b) reuse mx-agent at the pin** *(default)* — `install-mx-agent.sh` downloads
  the pinned **release binary** (the binary, not a `main` build, is what the pin
  means), and `bootstrap-daemon-a.sh` stands up the homeserver via the mx-agent
  `dev/matrix` tooling checked out at the pin. No fixture drift.

Set `MX_AGENT_REPO` / `MX_AGENT_RELEASE_BASE` to point at the real locations in
your environment. Where a value depends on the mx-agent release (asset name, the
exact homeserver compose), the scripts fail loudly rather than guess — a
conformance job that cannot provision must go **red**, never green-by-skip.

## Secret boundary

Throwaway, synthetic users/secrets are generated at job time and never committed.
Matrix tokens and the Ed25519 **private** signing key stay in each daemon's
on-disk state (mode 0600) and its own Matrix session — they never enter the test
process, the toolbelt, the model context, or CI logs. `down.sh` scrubs logs
before any upload.
