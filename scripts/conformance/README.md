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
| 2 (golden) — `policy.golden.toml` enforcement | daemons A **and** B with golden fixture | `bootstrap-daemon-b.sh` + `POLICY_FIXTURE=policy.golden.toml` | above + `MXL_CONFORMANCE_GOLDEN_POLICY=1`, `MXL_CONFORMANCE_ALLOWED_COMMAND`, `MXL_CONFORMANCE_APPROVAL_TOOL`, `MXL_CONFORMANCE_ALLOW_CWD` |
| 2 (golden e2e) — the **M1 exit gate** (T114) | golden fixture + `decide-approval.sh` operator | the golden bring-up above | the golden coordinates → `pnpm --filter @mx-loom/golden test:e2e` |

`MXL_CONFORMANCE=1` (and, for Tier 2, `MXL_CONFORMANCE_TWO_DAEMON=1`) flips the
suite from *skip-when-no-daemon* to *fail-when-no-daemon* — see
`test/conformance/_harness.ts`.

The golden end-to-end test (T114, the M1 exit gate) reuses this same two-daemon
bring-up but with the **canonical** receiver policy — see *Golden-test policy
(T112)* below.

## Golden-test policy (T112 / #20)

Two receiver fixtures live here:

| Fixture | Used by | Shape |
|---|---|---|
| `policy.b.toml` | Tier 2 conformance (T007) | deny-by-default + one allowed tool. No command allowlist, no `network`, no approval gate. Throwaway. |
| `policy.golden.toml` | golden e2e (T114) | **canonical** deny-by-default superset: two named tools (one ungated, one `requires_approval`), one allowlisted command (`allow_commands` + `deny_args_regex` + `allow_cwd` + sandbox + `requires_approval`), `network = "deny"`. |

`bootstrap-daemon-b.sh` chooses the fixture via **`POLICY_FIXTURE`** (default
`policy.b.toml`, so the green Tier-2 gate is byte-identical). Set
`POLICY_FIXTURE=policy.golden.toml` for the golden bring-up. Under the golden
fixture the bring-up now (T114) **registers the approval tool as a published tool**
on daemon B, **enables guarded exec** for the allowlisted command (best-effort; see
OQ #5 below), and **`emit_output`s** the full golden coordinate set
(`golden_policy`, `approval_tool`/`approval_gated_tool`, `allowed_command`,
`allow_cwd`) so the golden e2e suite (`@mx-loom/golden`) and the staged T112 AC 2
tests have everything they need.

**Substitution contract.** Every environment-specific value in the fixture is a
`@@…@@` placeholder substituted at bring-up from throwaway synthetic values; the
committed file carries no real ids/tokens/keys. The bring-up `sed`-fills each
from an env coordinate (defaults in parentheses):

| Placeholder | Env coordinate | Meaning |
|---|---|---|
| `@@ALLOW_TOOL@@` | `MXL_CONFORMANCE_TOOL` (`run_tests@1.0.0`) | low-risk named tool — ungated happy path |
| `@@APPROVAL_TOOL@@` | `MXL_CONFORMANCE_APPROVAL_TOOL` (`release@1.0.0`) | high-risk named tool — `requires_approval`; must be DISTINCT from the deny tool (`deploy@1.0.0`) since the policy lists allow+approval and the deny tool stays deny-by-default |
| `@@ALLOW_COMMAND@@` | `MXL_CONFORMANCE_ALLOWED_COMMAND` (`echo`) | the one allowlisted, approval-gated command |
| `@@ALLOW_CWD@@` | `MXL_CONFORMANCE_ALLOW_CWD` (`$CONF_STATE_DIR/b/data`) | cwd the command may run in |
| `@@SANDBOX_BACKEND@@` | `MXL_CONFORMANCE_SANDBOX_BACKEND` (`bubblewrap`) | tight sandbox backend (`bubblewrap`/`docker`/`podman`) |

The bring-up **fails loudly** if any `@@UPPER_CASE@@` coordinate is left
unsubstituted — a half-filled policy must go red, never load partially.

**Branch mapping (what each entry drives in T114):**

- `@@ALLOW_TOOL@@`, `requires_approval=false` → `mx_delegate_tool` succeeds, no gate.
- `@@APPROVAL_TOOL@@` / `@@ALLOW_COMMAND@@`, `requires_approval=true` → held (`awaiting_approval`) → operator `approval.decide` → `ok` / `denied`.
- anything unlisted (`default="deny"`) → `policy_denied`.
- an allowed command whose args trip `deny_args_regex` → `policy_denied`.

**Grammar status.** `policy.golden.toml` is authored against the design's named
keys (`mx-agent-tool-fabric-design.md` §6 layers 3/4); the **real** `v0.2.1`
`policy.toml` schema is not yet pinned (three in-repo sources disagree — see the
fixture header). AC 1 ("fixture loads on the target daemon") is the forcing
function; the verified grammar is recorded in
[`docs/mx-agent-surface-v0.2.1.md`](../../docs/mx-agent-surface-v0.2.1.md) and
staged behind `MXL_CONFORMANCE_TWO_DAEMON=1` until a live daemon is available.

**Secret-free rule.** Both fixtures are committed to git and carry no Matrix
tokens, no Ed25519 keys, no provider keys, no `GH_TOKEN`, and no real room/agent
ids — by construction (placeholders only). `network = "deny"` further bounds any
run from exfiltrating outward.

## Golden end-to-end (T114 / #22) — the M1 exit gate

The golden e2e test (`packages/golden`, `@mx-loom/golden`) reuses the golden
two-daemon bring-up plus one extra operator script. It is the one test that
exercises every boundary: a scripted Claude-SDK cognition delegates a named tool
**and** a guarded command to daemon B across the room → the receiver's approval gate
→ an out-of-band operator decision → the result returns → the audit rows land — run
through **both** bindings (`@mx-loom/mcp` and `@mx-loom/claude`).

### `decide-approval.sh` — the out-of-band operator

```
decide-approval.sh <approve|deny> [--match <substr>]
```

Runs as **daemon B's operator** (B's isolated `XDG_RUNTIME_DIR`/`XDG_DATA_HOME`,
exactly as `bootstrap-daemon-b.sh` does for `trust approve`) and issues
`approval.decide` via the `mx-agent` CLI. It **never** touches any `@mx-loom/*`
model-facing surface — `approval.decide` / `trust.*` / `policy.*` are operator
authority and are structurally absent from the model tool set. The golden harness
shells out to it at the exact moment a step is held, so the operator decision lives
strictly **between the hold and the resolve** — the test stays deterministic (no
guessing bot). `--match <tool-or-command-name>` targets the right pending request
when several are in flight (e.g. approve `release@1.0.0`, deny it on the next leg).
The CLI vocabulary (`approval list/approve/deny`) is localized at the top of the
script so a wrong v0.2.1 spelling is a one-line fix (OQ #2); a wrong spelling, or no
pending request within the budget, exits non-zero → the golden run goes **red**.

### Running the gate

```sh
scripts/conformance/install-mx-agent.sh "$MX_AGENT_VERSION"
# bring up daemon A (exports socket + room), then daemon B with the golden fixture
# (exports agent + tool + denied_tool + approval_tool + allowed_command + allow_cwd):
POLICY_FIXTURE=policy.golden.toml scripts/conformance/bootstrap-daemon-b.sh
MXL_CONFORMANCE_TWO_DAEMON=1 \
MXL_CONFORMANCE_GOLDEN_POLICY=1 \
MXL_CONFORMANCE_ROOM=… MXL_CONFORMANCE_TARGET_AGENT=… \
MXL_CONFORMANCE_TOOL=… MXL_CONFORMANCE_APPROVAL_TOOL=… \
MXL_CONFORMANCE_DENIED_TOOL=… MXL_CONFORMANCE_ALLOWED_COMMAND=… MXL_CONFORMANCE_ALLOW_CWD=… \
  pnpm --filter @mx-loom/golden test:e2e
```

The CI `golden` job (`.github/workflows/conformance.yml`, `workflow_dispatch` →
`run_golden`) wires all of this from the bootstrap step outputs; `run_audit_pg` adds
a Postgres service so the audit arm asserts the live `PostgresAuditSink` mirror too.
The suite **skips cleanly** with no fixture and goes **red** (never silently green)
when the fixture is demanded but unreachable.

### OQ #5 — guarded-exec enable

The policy `[exec]` block is the receiver-side enable; whether a separate daemon
toggle is also required is **unverified**. `bootstrap-daemon-b.sh` attempts a
localized `mx-agent exec enable` best-effort and warns (never dies) on a spelling
miss — so the golden test surfaces the real behavior **red** (S6/S7) rather than the
bring-up failing on an unpinned subcommand. Pin/correct it at the live round-trip.

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
