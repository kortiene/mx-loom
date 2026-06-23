# T112 · minimal v1 `policy.toml` fixture

> Issue #20 · `area/policy` `priority/P0` `type/chore` · Estimate **S** · Milestone **M1 — Delegation MVP** · Source `docs/backlog.md` (`T112`).
> Dependencies: **none**. **Unblocks #29 (T114 — GOLDEN end-to-end)**, which lists T112 in its blocked-by set. Adjacent to **#7 (T007 — conformance suite)**, whose throwaway `scripts/conformance/policy.b.toml` was authored explicitly to "converge on T112 later," and to **#14 (T106 — `mx_run_command`)**, whose exec conformance test already assumes a receiver `policy.toml` with an `allow_commands` entry.
> Out of scope: policy authoring UI/CLI (**M4 / T402**).

## Problem Statement

The golden end-to-end test (T114) is the M1 exit gate: a Claude-SDK agent delegates a **named tool** *and* a **guarded command** to a second registered agent across a Matrix room, the high-risk path **hits an approval gate**, an operator approves, and the result returns — exercised through **both** the MCP server (T109) and the Claude native shim (T110). For that test to be deterministic and meaningful, the **receiving** daemon (call it daemon B) must enforce a *known, fixed* policy: it has to **allow** exactly what the happy path needs, **gate** the high-risk path behind approval, and **deny** everything else by default so the policy-denied branch is a real enforcement decision rather than a missing registration.

That policy is a `policy.toml` file loaded on daemon B. It is the single most load-bearing piece of the golden test's environment, and it does not exist yet in canonical form. What exists today is a deliberately throwaway fixture — `scripts/conformance/policy.b.toml` — written for the Tier-2 conformance bring-up (`call.start` round-trip). Its own header says it is "scoped to the conformance bring-up ONLY. The canonical golden-test policy is T112 (M1) — converge on it later." It models only a deny-by-default default plus a single `[[allow]] tool=…` block; it has **no** allowlisted command, **no** `network = "deny"`, and **no** `requires_approval` gate. It therefore cannot drive the approval-gated branch or the guarded-exec branch the golden test requires.

T112 closes that gap: it produces the **canonical, deny-by-default v1 `policy.toml` fixture** for the golden test — allowing two named tools and one allowlisted command, denying network egress, and putting `requires_approval` on the high-risk path — and **verifies it actually loads and enforces on the pinned `mx-agent v0.2.1` daemon**.

The structural fact that shapes everything below: **enforcement is out-of-process, on the receiver, and mx-loom never touches this file.** Policy is a coordination-plane concern owned by the daemon (design §1, §6 layer 3). mx-loom holds no policy, parses no TOML, and makes no allow/deny decision — it only emits a signed request and *observes* the daemon's verdict as a normalized envelope (`status: ok | awaiting_approval | denied`, `error.code: policy_denied`). So this issue adds **no TypeScript** to any `packages/*` module. It is a daemon-side fixture file plus the operator/bring-up plumbing that loads it, plus a live verification that the fixture's grammar is real.

## Goals

- Author a **canonical, deny-by-default `policy.toml` fixture** for the golden test's receiver daemon that:
  - **Allows two named tools** for `mx_delegate_tool` — one low-risk (no approval), one high-risk (`requires_approval = true`).
  - **Allows one command** for `mx_run_command` (guarded exec) — behind an explicit `allow_commands` allowlist, with `deny_args_regex`, `allow_cwd`, a tight sandbox backend, and `network = "deny"` (design §6 layer 4).
  - Sets **`network = "deny"`** as the egress default.
  - Puts **`requires_approval` on the high-risk path** so the golden test's approval branch is driven by real receiver policy, not a test hook.
  - **Denies everything else by default** (`default = "deny"`), so the policy-denied branch is a genuine enforcement decision.
- **Verify the fixture loads on the pinned daemon (AC 1).** Load the fixture on a live `mx-agent v0.2.1` daemon and confirm it parses and is accepted — this is the forcing function that *pins the real `policy.toml` grammar*, which is currently **unverified** (see Risks #1).
- **Drive both the allowed and approval-gated golden-test branches (AC 2).** Demonstrate, on the live daemon, that:
  - a `call.start` for the low-risk allowed tool returns a non-gated success;
  - a request on the high-risk path is **held** (`awaiting_approval`), and an out-of-band operator decision releases it (`ok`) or rejects it (`denied`);
  - a request outside the allow set returns `policy_denied`.
- **Keep the fixture inherently secret-free.** It is committed to git; it must carry no Matrix tokens, no Ed25519 keys, no provider keys, no `GH_TOKEN`, and no sensitive room/agent identifiers — use substitution placeholders for any environment-specific value (the `policy.b.toml` `@@TOKEN@@` precedent).
- **Document the verified grammar** in `docs/mx-agent-surface-v0.2.1.md` (which today verifies the RPC surface but says nothing about the `policy.toml` schema) and reference the fixture from the conformance README so the golden-test bring-up (T114) can wire it in.

## Non-Goals

- **No TypeScript / no `packages/*` change.** Policy enforcement is daemon-side (design §1, §6). mx-loom does not parse, validate, load, or reason about `policy.toml`. The registry/toolbelt already surface the daemon's verdict (`policy_denied` → `denied`, held → `awaiting_approval`) via T102/T105/T106; T112 adds no code there.
- **No policy authoring UI/CLI.** Authoring `allow_tools` / `allow_commands` / `deny_args_regex` / `allow_cwd` / `requires_approval` ergonomically is **M4 / T402**, explicitly out of scope. T112 hand-writes one fixture.
- **No multi-agent / per-agent policy matrix.** A single receiver daemon with one policy is the M1 single-workspace, single-tenant scope (design §8). Per-agent policy scoping and tenant=room partitioning are M4/M5 (T402/T501).
- **The golden test itself (T114).** T112 delivers the fixture + its live verification + the bring-up reference; T114 is the test that *consumes* it (Claude-SDK agent, both bindings, audit-row assertions). Any new bring-up coordinate the approval branch needs (e.g. an "approval-gated tool/command" env var) is sketched here but landed with T114.
- **The approval **mechanism**.** How an operator decides (`approval.decide` / a dashboard, T403) and how the daemon re-validates at release (design §5) are daemon/M4 concerns. T112 only sets `requires_approval = true` and relies on the daemon's existing approval flow.
- **Replacing or removing the throwaway `policy.b.toml`.** The recommended path is a *sibling* canonical fixture; reconciling Tier-2 conformance onto it is a documented option, not a requirement (it would touch the green Tier-2 gate — see Proposed Implementation).
- **Postgres audit mirror (T113)** and any audit-row assertions — those ride with T114.

## Relevant Repository Context

The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest, Apache-2.0). The repo is **no longer docs-only** — M0 and most of M1 are implemented (`packages/toolbelt`, `packages/registry`, `packages/claude`). **However, this issue produces no TypeScript**: `policy.toml` is consumed by the external `mx-agent` daemon binary, not by any mx-loom package.

**What exists today that T112 builds on / converges with:**

- **`scripts/conformance/policy.b.toml`** — the throwaway receiver fixture for conformance Tier 2 (T007). Verbatim relevant shape:
  ```toml
  default = "deny"
  [[allow]]
  tool = "@@ALLOW_TOOL@@"
  requires_approval = false
  # @@DENY_TOOL@@ intentionally NOT listed — falls through to deny-by-default.
  ```
  Its header explicitly defers the canonical version to T112. It has **no** command allowlist, **no** `network` key, **no** approval gate. `@@ALLOW_TOOL@@` / `@@DENY_TOOL@@` are `sed`-substituted by `bootstrap-daemon-b.sh`.

- **`scripts/conformance/bootstrap-daemon-b.sh`** — the operator/out-of-band bring-up for the second daemon. It (a) writes the policy to **`$XDG_DATA_HOME/mx-agent/policy.toml`** *before* `agent.register` "so B enforces deny-by-default"; (b) `sed`-substitutes the tool placeholders; (c) registers B publishing both `$TOOL` (allowed) and `$DENIED_TOOL` (denied); (d) establishes **mutual Ed25519 trust** via `mx-agent trust approve` (operator action, never a toolbelt path). This is the script the golden-test bring-up (T114) extends. Note: it currently registers the agent with `--tool` flags only; **enabling guarded exec** (an `allow_commands` policy + whatever registration exec needs) is new surface T112's fixture introduces.

- **`scripts/conformance/README.md`** — documents the tier→bring-up→env-var mapping and the secret boundary ("Throwaway, synthetic users/secrets … never committed. Matrix tokens and the Ed25519 private signing key stay in each daemon's on-disk state (mode 0600)"). It names `policy.b.toml` as the Tier-2 fixture; T112 should add the canonical golden fixture alongside it.

- **`packages/toolbelt/test/conformance/_harness.ts`** — `TwoDaemonFixture` already reads coordinates: `MXL_CONFORMANCE_ROOM`, `MXL_CONFORMANCE_TARGET_AGENT`, `MXL_CONFORMANCE_TOOL`, `MXL_CONFORMANCE_DENIED_TOOL`, `MXL_CONFORMANCE_ALLOWED_COMMAND`, `MXL_CONFORMANCE_DENIED_COMMAND`. There is **no approval-gated coordinate yet** — the high-risk/approval branch the golden test adds will need one (e.g. `MXL_CONFORMANCE_APPROVAL_TOOL` / `MXL_CONFORMANCE_APPROVAL_COMMAND`), landed with T114.

- **`packages/toolbelt/test/conformance/exec.conformance.test.ts`** (T106) — its header states the allow path requires "B's `policy.toml` must carry a matching `[[allow_commands]]` entry," and the deny path is satisfied by "the empty / default policy." This is a **second, independent guess at the command grammar** (`[[allow_commands]]`) that differs from `policy.b.toml`'s `[[allow]]` tool shape — concrete evidence that the real `policy.toml` schema is not yet pinned and must be verified by T112.

- **`docs/mx-agent-surface-v0.2.1.md`** (T001) — the verified daemon RPC surface. It confirms `call.start`/`exec.start` flags, `agent.register`, the `AgentState`/`ToolSchema` shapes, and `run_tests@1.0.0` as the canonical example tool — but says **nothing about the `policy.toml` file schema** (T001 exercised RPC methods, not the policy file). The "Surface present, full round-trip pending" table lists `approval.decide` as "◻️ documented." So the approval round-trip and the policy grammar are both authored-against-design-now / pinned-at-the-round-trip, exactly like every other M1 wire assumption.

- **`docs/mx-agent-tool-fabric-design.md`** — §6 layer 3 ("Policy is deny-by-default and enforced on the receiver") lists the conceptual policy keys: *`allow_tools`, `allow_commands`, `allow_cwd`, `deny_args_regex`, runtime/output caps, sandbox backend, network, `requires_approval`*. §6 layer 4 ("Guarded exec") prescribes the command-enablement recipe: `allow_commands` + `deny_args_regex` (e.g. block `curl … | sh`, `rm -rf /`, `ssh`) + `allow_cwd` + tight sandbox + `network = "deny"`, with "high-risk commands should additionally carry `requires_approval = true`." §8 (MVP scope) calls for exactly "a minimal `policy.toml` (allow a couple of named tools, one allowlisted command for `mx_run_command`, deny network)." **This design field list is conceptual, not a verified TOML grammar.**

**What does not exist yet (to produce in T112):** the canonical golden-test `policy.toml` fixture file; a recorded, **live-verified** `policy.toml` grammar for `v0.2.1`; the bring-up wiring that loads the richer fixture (the `allow_commands`/approval extensions to `bootstrap-daemon-b.sh`, or a golden-specific bring-up); and the docs entry pinning the verified schema.

## Proposed Implementation

This is a **chore**: write a fixture, prove it loads and enforces on the pinned daemon, document the verified grammar, and wire the bring-up. Five steps.

### Step 1 — Confirm the real `policy.toml` grammar against a live `v0.2.1` daemon (the gating spike)

Because the policy file schema is **unverified** (two different guesses exist in-repo and the design list is conceptual), the first action is a small spike — a "T001 for policy." On a live pinned daemon:

1. Locate where the daemon reads policy from (the bring-up assumes `$XDG_DATA_HOME/mx-agent/policy.toml`; confirm the exact path, filename, and whether it is auto-loaded on start vs. needs a `policy.*` RPC/CLI to (re)load).
2. Determine the **accepted grammar** for each conceptual key the design names: deny-by-default default; per-tool allow with `requires_approval`; the **command** allowlist shape (`allow_commands` array vs. `[[allow_commands]]` table vs. an `[exec]` block — the two in-repo guesses disagree); `deny_args_regex`; `allow_cwd`; `network`; sandbox backend; any runtime/output caps.
3. Record the verified grammar (and any deltas from the design field list) in `docs/mx-agent-surface-v0.2.1.md`.

If a live `v0.2.1` daemon is not available in the implementing environment, author the fixture against the design's named keys (localized, with comments flagging each unverified key), and **stage the live verification** behind the same two-daemon gate the rest of M1 uses (`MXL_CONFORMANCE_TWO_DAEMON=1`) — the conformance fixture pins it later. The AC "Fixture loads on the target daemon" is the explicit forcing function; it cannot be marked done until a live load succeeds. Treat a fixture that the daemon rejects as **red**, never green-by-assumption (the conformance README's "fail loudly rather than guess" rule).

### Step 2 — Author the canonical fixture

Add **`scripts/conformance/policy.golden.toml`** (sibling of the throwaway `policy.b.toml`, reusing the existing bring-up tooling and load path). Recommended content — *authored against the design's named keys; each key flagged as pinned at Step 1's live check*:

```toml
# Canonical golden-test receiver policy — daemon B. T112 / #20.
#
# Deny-by-default. The deterministic environment the golden test (T114) asserts
# against. Enforcement is OUT-OF-PROCESS, on THIS (receiving) daemon — mx-loom
# never reads this file; it only observes the verdict as a normalized envelope.
#
# Drives every T114 branch:
#   allowed (no approval):  mx_delegate_tool(@@ALLOW_TOOL@@)        -> status: ok
#   approval-gated:         mx_run_command(@@APPROVAL_COMMAND@@)    -> awaiting_approval -> ok|denied
#   approval-gated (deleg): mx_delegate_tool(@@APPROVAL_TOOL@@)     -> awaiting_approval -> ok|denied
#   denied (deny-default):  any tool/command not listed below      -> policy_denied
#   denied (regex):         an allowed command w/ args tripping     -> policy_denied
#                           deny_args_regex
#
# Placeholders (@@…@@) are substituted by the bring-up script; the file itself
# carries NO real room ids, agent ids, tokens, or keys (it is committed to git).

default = "deny"      # deny-by-default — the spine of the receiver guard
network = "deny"      # no egress for any tool/command run

# --- Named tools (mx_delegate_tool / call.start) --------------------------
[[allow]]                         # named tool #1 — low-risk, ungated (happy path)
tool = "@@ALLOW_TOOL@@"           # e.g. run_tests@1.0.0
requires_approval = false

[[allow]]                         # named tool #2 — high-risk, approval-gated
tool = "@@APPROVAL_TOOL@@"        # e.g. deploy@1.0.0
requires_approval = true          # requires_approval on the high-risk path

# --- Guarded exec (mx_run_command / exec.start) ---------------------------
# Disabled by default; this is the ONE allowlisted command. GRAMMAR PENDING
# Step-1 live verification (allow_commands array vs [[allow_commands]] table vs
# an [exec] block — two in-repo guesses disagree; pin the real one here).
[exec]
allow_commands = ["@@ALLOW_COMMAND@@"]      # e.g. "echo" or "git" — single binary
allow_cwd = ["@@ALLOW_CWD@@"]               # e.g. the workspace project dir
deny_args_regex = "(\\|\\s*sh\\b|\\brm\\s+-rf\\s+/|\\bssh\\b|\\bcurl\\b)"
sandbox = "@@SANDBOX_BACKEND@@"             # tight backend, e.g. bubblewrap|docker|podman
requires_approval = true                    # the guarded command is the high-risk path
# network = "deny" inherited from the top-level egress default
```

Mapping each entry to a T114 branch:

| Policy entry | Drives golden-test branch | T114 AC |
|---|---|---|
| `[[allow]] tool=@@ALLOW_TOOL@@`, `requires_approval=false` | `mx_delegate_tool` succeeds, no gate | "Named-tool delegation succeeds end-to-end" |
| `[[allow]] tool=@@APPROVAL_TOOL@@`, `requires_approval=true` | `mx_delegate_tool` held → approve → `ok` | approval-gated delegation (design §8) |
| `[exec] allow_commands=[…]`, `requires_approval=true` | `mx_run_command` held → approve → `ok` | "Guarded command runs only after approval" |
| `deny_args_regex` | allowed command + bad args → `policy_denied` | "denial path also asserted" |
| `default="deny"` (anything unlisted) | unlisted tool/command → `policy_denied` | "denial path also asserted" |
| `network="deny"` | no egress from any run | design §6 layer 4 invariant |

> **Allowed-vs-approval mapping note.** The design has a minor internal tension: §8 says the *named tool* (`run_tests`) hits the approval gate, while the T114 ACs make the *named tool* succeed end-to-end and the *guarded command* the approval-gated path. The fixture above resolves both by gating **both** a high-risk named tool **and** the command behind `requires_approval`, while keeping `run_tests` ungated — so the golden test can exercise the approval branch through delegation *or* exec, and the allowed branch through `run_tests`, with no ambiguity. The precise tool/command names are T114's call; T112 fixes the *shape*.

### Step 3 — Wire the bring-up to load the fixture and enable exec

The golden-test bring-up (landed with T114) must, beyond what `bootstrap-daemon-b.sh` does today:
- write `policy.golden.toml` (substituting the placeholders) to the daemon's policy path *before* registration (the existing pattern);
- register the receiver agent publishing the two named tools (`@@ALLOW_TOOL@@`, `@@APPROVAL_TOOL@@`) and **enabling guarded exec** for `@@ALLOW_COMMAND@@`;
- export the new coordinates the approval branch needs (e.g. `MXL_CONFORMANCE_APPROVAL_TOOL`, `MXL_CONFORMANCE_APPROVAL_COMMAND`, `MXL_CONFORMANCE_ALLOWED_COMMAND`) so the test can address each branch.

T112's deliverable here is the **fixture and the documented substitution contract** (which placeholders exist and what each must be set to); the actual script edits can land in T112 if a golden bring-up variant is introduced, or be deferred to T114. Recommended: add the fixture + a short "golden-test policy" subsection to `scripts/conformance/README.md`, and either (a) extend `bootstrap-daemon-b.sh` to take a `POLICY_FIXTURE` override (defaulting to `policy.b.toml`, so the green Tier-2 gate is untouched) or (b) add a thin `bootstrap-daemon-b-golden.sh`. Prefer (a) — one bring-up, fixture chosen by env.

### Step 4 — Verify it drives both branches live

With the fixture loaded on B and mutual trust established, confirm against the live daemon (reusing the conformance harness seam, gated by `MXL_CONFORMANCE_TWO_DAEMON=1`):
- `call.start` for `@@ALLOW_TOOL@@` → non-gated success (no `awaiting_approval`);
- `call.start` for `@@APPROVAL_TOOL@@` (or `exec.start` for `@@ALLOW_COMMAND@@`) → **held** (`awaiting_approval`); an out-of-band `approval.decide` releases it to `ok` (approve) / `denied` (reject);
- a `call.start`/`exec.start` outside the allow set → `policy_denied`;
- an `exec.start` for `@@ALLOW_COMMAND@@` with args that trip `deny_args_regex` → `policy_denied`.

These are daemon-side assertions; the full model-facing golden test (both bindings, audit rows) is T114. T112's AC 2 ("Drives both the allowed and approval-gated golden-test branches") is satisfied by demonstrating the daemon produces the allowed-success and the held-then-released outcomes under this fixture.

### Step 5 — Reconcile with the throwaway fixture (optional, documented)

`policy.b.toml` (Tier-2) deliberately uses a *non-approval* allowed tool and a *deny-by-default* denied tool. The canonical golden fixture is a strict superset. Two reconciliation options:
- **(Recommended) Keep both.** `policy.b.toml` stays the minimal Tier-2 fixture (no churn to the green gate); `policy.golden.toml` is the canonical T114 fixture. Share the *verified grammar* (Step 1) across both. If Tier 2 is later re-pointed at the golden fixture, keep a third, never-allowlisted tool name for its deny-by-default assertion (the golden fixture *allows* `@@APPROVAL_TOOL@@`, so it cannot double as Tier-2's denied tool).
- **Converge to one.** Re-point Tier-2 at `policy.golden.toml`. Lower file count, but it touches the green Tier-2 gate and must preserve a denied-tool path — only do this if Step 1 confirms the grammar is identical and CI stays green.

## Affected Files / Packages / Modules

**New:**
- `scripts/conformance/policy.golden.toml` — the canonical deny-by-default golden-test receiver fixture (the primary deliverable).

**Modified:**
- `scripts/conformance/README.md` — add a "golden-test policy (T112)" subsection: the fixture path, the placeholder/substitution contract, the new approval coordinate(s), and the secret-free rule.
- `docs/mx-agent-surface-v0.2.1.md` — add a "`policy.toml` schema (verified)" section recording the live-verified grammar and the load path; note any delta from the design §6 conceptual key list.
- `docs/backlog.md` — tick T112's ACs and add a status line once landed (mirroring the other T-rows).
- `scripts/conformance/bootstrap-daemon-b.sh` — *optional* (recommended): add a `POLICY_FIXTURE` override + the exec-enable/approval registration and coordinate exports, defaulting to today's `policy.b.toml` so the Tier-2 gate is unchanged. May be deferred to T114.

**Read-only references (no change):**
- `scripts/conformance/policy.b.toml` (the throwaway precedent), `packages/toolbelt/test/conformance/_harness.ts` and `exec.conformance.test.ts` (coordinate names + the `allow_commands` assumption), `docs/mx-agent-tool-fabric-design.md` §6/§8.

**Explicitly NOT touched:** any `packages/*` source. No TypeScript change — mx-loom never parses policy.

## API / Interface Changes

**None to any mx-loom public API, tool descriptor, result envelope, or daemon-RPC surface.** `policy.toml` is a daemon-side configuration artifact; it has no mx-loom-facing API. The model-facing verbs already surface the daemon's policy verdicts (`policy_denied` → `status: denied`; held → `status: awaiting_approval`) via T102/T105/T106 — unchanged.

The only new *interface* is internal to the test bring-up: the fixture's substitution placeholders (`@@ALLOW_TOOL@@`, `@@APPROVAL_TOOL@@`, `@@ALLOW_COMMAND@@`, `@@ALLOW_CWD@@`, `@@SANDBOX_BACKEND@@`) and the conformance env coordinates that supply them. Any new coordinate (e.g. `MXL_CONFORMANCE_APPROVAL_TOOL`/`MXL_CONFORMANCE_APPROVAL_COMMAND`) is a *test* contract, documented in the conformance README, and lands with T114 if not in T112.

## Data Model / Protocol Changes

**None to mx-loom's result-envelope shape, error taxonomy, tool schemas, idempotency keys, or serialization.** The closed nine-code error taxonomy (T102) already includes `policy_denied` (a denial-set code) and the `awaiting_approval` status with its `approval` block — this fixture simply *exercises* them on a live daemon; it defines no new code or shape.

The one externally-defined data model this issue *records* (does not change) is the **`mx-agent v0.2.1` `policy.toml` schema** — Step 1 pins its real grammar in `docs/mx-agent-surface-v0.2.1.md`. That is documentation of an upstream format, not a change to any mx-loom protocol.

## Security & Compliance Considerations

This fixture **is** a security artifact — it is the receiver's deny-by-default guard for the golden test — so the constraints are central, not incidental:

- **Out-of-process enforcement is the whole point.** The fixture lives on and is enforced by the **receiving** daemon (design §1, §6 layer 3). mx-loom holds no policy, parses no TOML, and makes no allow/deny decision. Cognition can only produce a signed *request*; the thing that says "yes/no/approve" is the daemon, not the runtime — a compromised or hallucinating model cannot widen this policy. T112 must not introduce any client-side policy reasoning (that would both duplicate the authority surface, forbidden, and create the false impression that the toolbelt is the boundary — it is not).

- **Deny-by-default.** `default = "deny"` plus an explicit allow set is the spine: the policy-denied branch is a *real* enforcement decision (a fall-through), not a missing registration. Guarded exec ships **disabled** — the one allowlisted command is the only exec the receiver permits, behind `allow_commands` + `deny_args_regex` + `allow_cwd` + tight sandbox + `network = "deny"`, with `requires_approval` on top (design §6 layer 4, §9 "Guarded exec only — no unrestricted exec"). No wildcard command surface.

- **Secret boundary (Boundary A).** The fixture is **committed to git**, so it must be inherently secret-free: no `MATRIX_*`/`MX_AGENT_*` tokens, no Ed25519 **private** signing key (that stays at `~/.local/share/mx-agent/signing_key.ed25519`, mode 0600, daemon-held), no provider keys, no `GH_TOKEN`, and no sensitive room/agent identifiers. Environment-specific values are substitution placeholders (`@@…@@`), supplied at bring-up from throwaway synthetic values, never committed (the `policy.b.toml` + conformance README precedent). `network = "deny"` further bounds any run from exfiltrating outward.

- **`deny_args_regex` as defense-in-depth.** The regex blocks the design's named dangerous patterns (`curl … | sh`, `rm -rf /`, `ssh`). It complements — never replaces — the daemon's sandbox env-scrub and the toolbelt's outbound credential-shaped-arg rejection (T008) and inbound `redactSecrets`. The secret-free **tool contract** still holds: no tool field carries credentials in or out, and credential-shaped args are rejected before dispatch by `MxClient`.

- **Approval is human + re-validated at release.** `requires_approval = true` makes the high-risk path hold pending an out-of-band operator decision; the daemon **re-runs the authorize pipeline (sig → trust → policy) at release** (design §5), so a stale approval cannot smuggle through if trust/policy changed in the interim. The model is never given trust/policy/approval-mutation tools; approval reaches it only as the `awaiting_approval` status (T102/T103). T112 must not add any auto-approve or model-decidable approval path.

- **Audit correlation.** Every result the golden test observes under this fixture carries `audit_ref` (T102); the allowed/held/denied/approved events are signed `com.mxagent.*` Matrix events — the tamper-evident trail. T112 does not log or persist anything itself; it must never emit policy contents containing real identifiers into CI logs (`down.sh` already scrubs logs before upload).

## Testing Plan

T112 is a fixture + verification chore; its "tests" are the live load + branch demonstration (the ACs), plus documentation. No mx-loom unit tests are added (there is no new code to unit-test).

- **AC 1 — Fixture loads on the target daemon (live).** Load `policy.golden.toml` (placeholders substituted) on a live `v0.2.1` daemon and assert the daemon **accepts and parses** it (no load error; deny-by-default in effect). This is the grammar-pinning gate; until it passes, the fixture grammar is unverified. Stage behind `MXL_CONFORMANCE_TWO_DAEMON=1` if no live daemon is available at author time, and mark the AC as pending the round-trip (the M1 norm).
- **AC 2 — Drives both branches (live, via the conformance harness seam).** Using the existing two-daemon harness + `MxClient.call`:
  - allowed branch: `call.start(@@ALLOW_TOOL@@)` → success, **not** `awaiting_approval`;
  - approval branch: `call.start(@@APPROVAL_TOOL@@)` and/or `exec.start(@@ALLOW_COMMAND@@)` → **held** (`awaiting_approval`); out-of-band `approval.decide` → release to `ok` (approve) and `denied` (reject) in separate runs;
  - deny branch: an unlisted tool/command → `policy_denied`; an allowed command with `deny_args_regex`-tripping args → `policy_denied`.
- **Secret-boundary assertion.** Re-use the conformance `SECRET_PATTERN` check: no response observed under this fixture (including the denial/approval messages) carries a token-shaped value. Static check: grep the committed fixture for token/key/secret shapes (it must be clean by construction).
- **Conformance-suite integration (the home for AC 1/AC 2 once live).** The natural host is a Tier-2 conformance case (an approval-gated extension of `delegate.conformance.test.ts` / `exec.conformance.test.ts`), or a dedicated golden-policy conformance test, all gated by `MXL_CONFORMANCE_TWO_DAEMON=1` and red-on-drift. The full model-facing golden e2e (both bindings, audit rows) is **T114**.
- **Documentation test.** The verified grammar recorded in `docs/mx-agent-surface-v0.2.1.md` must match the committed fixture key-for-key (a reviewer check; ideally a tiny script asserting every `@@…@@`-stripped key in the fixture appears in the documented grammar).

## Documentation Updates

- **`docs/mx-agent-surface-v0.2.1.md`** — add a "`policy.toml` schema (verified)" section: the load path/filename, whether it is auto-loaded, the accepted grammar for `default`, per-tool `allow` + `requires_approval`, the command allowlist shape (the pinned answer to the `[[allow]]` vs `[[allow_commands]]` vs `[exec]` divergence), `deny_args_regex`, `allow_cwd`, `network`, sandbox backend, and any caps — plus deltas from the design §6 conceptual list.
- **`scripts/conformance/README.md`** — add a "golden-test policy (T112)" subsection: the fixture path, the substitution placeholder contract, the new approval coordinate(s), and the secret-free/throwaway rule. Cross-reference from the Tier table.
- **`docs/mx-agent-tool-fabric-design.md`** — *optional*: if Step 1 reveals the design §6 key list diverges from the real grammar, add a one-line pointer to the verified schema in the surface doc (keep the design conceptual; the surface doc is the verified record).
- **`docs/backlog.md`** — tick T112's two ACs and add a status line (mirroring T101–T108/T111) once landed, noting the grammar was pinned at the live check (or staged behind the two-daemon gate).

## Risks and Open Questions

1. **(Primary) The real `policy.toml` grammar is unverified.** Three sources disagree or are conceptual: `policy.b.toml` uses `[[allow]] tool=…`; the exec conformance test assumes `[[allow_commands]]`; the design §6 lists keys conceptually (`allow_tools`, `allow_commands`, `allow_cwd`, `deny_args_regex`, sandbox, network, `requires_approval`) with no TOML shape. **T001 verified the RPC surface, not the policy file format.** Mitigation: Step 1 is a gating spike against a live `v0.2.1` daemon; AC 1 ("loads on the target daemon") forces it; the fixture is authored against the design's named keys and pinned at the live check, with each unverified key flagged in-file. **Do not mark T112 done on an unverified fixture.**
2. **Policy load path / reload semantics unknown.** The bring-up assumes `$XDG_DATA_HOME/mx-agent/policy.toml`, written *before* `agent.register`. Whether the daemon auto-loads on start, needs a `policy.*` RPC/CLI to (re)load, or watches the file is unconfirmed — pin in Step 1.
3. **Approval round-trip is staged, not live-green.** `approval.decide` is "◻️ documented" in the surface doc; the held → operator-decide → release flow has not been exercised in CI (no approval coordinate in the harness yet). AC 2's approval branch depends on it. Mitigation: stage behind the two-daemon gate; if approval can't be driven yet, T112 lands the fixture + the allowed/denied live verification and the approval branch is verified with T114's bring-up.
4. **Allowed-vs-approval-vs-deny tool/command mapping is partly T114's call.** The design §8 (named tool gated) vs. T114 ACs (named tool succeeds, command gated) tension is resolved here by gating *both* a high-risk tool and the command (see the Proposed Implementation note), but the exact tool/command *names* and which branch the golden test drives through which binding are T114 decisions. T112 fixes the policy *shape*, not the test's choreography.
5. **Sandbox backend availability.** `network = "deny"` + a tight sandbox (bubblewrap/docker/podman) assume the CI bring-up host has a backend installed/permitted. The conformance README already flags provisioning as fail-loud; the fixture should let the backend be a substitutable placeholder so the golden bring-up can pick what its host supports, and Step 1 should confirm v0.2.1's accepted `sandbox` values.
6. **Fixture home / convergence.** Recommended: a sibling `policy.golden.toml` (no churn to the green Tier-2 gate). Converging Tier-2 onto it is optional and must preserve a deny-by-default tool path. Confirm the preference at review.
7. **Owning script for the exec-enable/approval bring-up.** Whether the `allow_commands` + approval registration + new coordinates land in `bootstrap-daemon-b.sh` (via a `POLICY_FIXTURE` override) under T112 or under T114. Recommended: the fixture + substitution contract + README in T112; the script edits with whichever issue first needs the live two-daemon golden run.

## Implementation Checklist

1. **Spike (gating):** On a live `mx-agent v0.2.1` daemon, confirm the `policy.toml` load path/reload semantics and the accepted grammar for `default`, per-tool `allow`+`requires_approval`, the command-allowlist shape, `deny_args_regex`, `allow_cwd`, `network`, and sandbox backend. Record it in `docs/mx-agent-surface-v0.2.1.md`. (If no live daemon: author against design keys, flag each, stage verification behind `MXL_CONFORMANCE_TWO_DAEMON=1`.)
2. **Author** `scripts/conformance/policy.golden.toml`: `default = "deny"`, `network = "deny"`; two `[[allow]]` named tools (one `requires_approval=false`, one `requires_approval=true`); one allowlisted command with `deny_args_regex` + `allow_cwd` + sandbox + `requires_approval=true`. Use `@@…@@` placeholders for all environment-specific values; add the branch-mapping comments. Match the grammar pinned in step 1.
3. **Confirm secret-free by construction:** no tokens/keys/real ids in the committed file; grep it against the conformance `SECRET_PATTERN`.
4. **Verify AC 1 (live):** load the substituted fixture on daemon B; assert the daemon parses and accepts it with deny-by-default in effect.
5. **Verify AC 2 (live, via the harness seam):** allowed tool → non-gated success; high-risk path → `awaiting_approval` → out-of-band `approval.decide` → `ok`/`denied`; unlisted tool/command → `policy_denied`; allowed command + bad args → `policy_denied`.
6. **Wire the bring-up:** add a `POLICY_FIXTURE` override (default `policy.b.toml`) + exec-enable/approval registration + new coordinate exports to `bootstrap-daemon-b.sh`, **or** document the contract for T114 to land. Keep the green Tier-2 gate unchanged.
7. **Document:** add the "golden-test policy (T112)" subsection to `scripts/conformance/README.md` (fixture path, placeholder contract, approval coordinate(s), secret-free rule); record the verified grammar in `docs/mx-agent-surface-v0.2.1.md`.
8. **Backlog:** tick T112's ACs in `docs/backlog.md` and add a status line; note the grammar pin (live or staged).
9. **Confirm no `packages/*` change** was introduced — T112 is daemon-side fixture + docs only.
