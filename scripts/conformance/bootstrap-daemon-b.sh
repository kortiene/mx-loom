#!/usr/bin/env bash
# Bootstrap daemon B — the two-daemon delegation tier (Tier 2, call.start). T007 / #7.
#
# Starts a SECOND daemon (distinct Matrix identity) under its own runtime/data
# dir, joins it to daemon A's workspace room, registers it as a target agent that
# PUBLISHES a named tool, establishes MUTUAL Ed25519 trust, and loads a minimal
# allow-policy on B. Exports the target agent id + tool names for the suite.
#
# All of this is operator/out-of-band: trust + policy are daemon-side authority
# the toolbelt can never grant. Requires bootstrap-daemon-a.sh to have run first
# (reads A's socket/room from its outputs or env).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v mx-agent >/dev/null 2>&1 || die "mx-agent not on PATH — run install-mx-agent.sh first"

A_SOCKET="${A_SOCKET:-$CONF_STATE_DIR/a/runtime/mx-agent/daemon.sock}"
A_ROOM="${A_ROOM:-${MXL_CONFORMANCE_ROOM:-}}"
[ -S "$A_SOCKET" ] || die "daemon A socket not found at $A_SOCKET — run bootstrap-daemon-a.sh first"
[ -n "$A_ROOM" ]   || die "daemon A room unknown — pass A_ROOM (from bootstrap-daemon-a.sh output)"

HS_URL="${MATRIX_HOMESERVER_URL:-http://127.0.0.1:8008}"
TOOL="${MXL_CONFORMANCE_TOOL:-run_tests@1.0.0}"        # B publishes + policy ALLOWS
DENIED_TOOL="${MXL_CONFORMANCE_DENIED_TOOL:-deploy@1.0.0}" # B publishes + policy DENIES

# Which receiver fixture to load (T112 / #20). Default = the throwaway Tier-2
# fixture, so the green Tier-2 gate is byte-identical to before. Set
# POLICY_FIXTURE=policy.golden.toml for the canonical golden-test policy (its
# guarded-exec + approval-gated coordinates below are substituted in too; for
# `policy.b.toml` they are inert no-ops, as it carries none of those placeholders).
POLICY_FIXTURE="${POLICY_FIXTURE:-policy.b.toml}"
# Golden-fixture (policy.golden.toml) substitution coordinates — see
# scripts/conformance/README.md "golden-test policy (T112)". The receiver-side
# registration of the approval tool + exec-enable and the export of the
# MXL_CONFORMANCE_APPROVAL_* coordinates land with the golden bring-up (T114);
# here we only fill the fixture so it LOADS (AC 1).
APPROVAL_TOOL="${MXL_CONFORMANCE_APPROVAL_TOOL:-deploy@1.0.0}"     # high-risk, approval-gated tool
ALLOWED_COMMAND="${MXL_CONFORMANCE_ALLOWED_COMMAND:-echo}"         # the one allowlisted command
ALLOW_CWD="${MXL_CONFORMANCE_ALLOW_CWD:-$CONF_STATE_DIR/b/data}"   # cwd the command may run in
SANDBOX_BACKEND="${MXL_CONFORMANCE_SANDBOX_BACKEND:-bubblewrap}"   # tight sandbox backend

B_RUNTIME="$CONF_STATE_DIR/b/runtime"
B_DATA="$CONF_STATE_DIR/b/data"
mkdir -p "$B_RUNTIME" "$B_DATA"

# --- Synthetic, throwaway user for B ----------------------------------------
B_USER="${B_USER:-mxloom-b-$(date +%s)-$RANDOM}"
B_PASS="${B_PASS:-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')}"
if [ -n "${MX_REGISTER_CMD:-}" ]; then
  MX_HS_URL="$HS_URL" MX_USER="$B_USER" MX_PASS="$B_PASS" bash -c "$MX_REGISTER_CMD" \
    || die "user registration failed for $B_USER"
else
  log "MX_REGISTER_CMD unset — assuming '$B_USER' is pre-provisioned on $HS_URL"
fi

# --- Daemon B under its own isolated runtime/data dir -----------------------
export XDG_RUNTIME_DIR="$B_RUNTIME"
export XDG_DATA_HOME="$B_DATA"
B_SOCKET="$XDG_RUNTIME_DIR/mx-agent/daemon.sock"
mkdir -p "$(dirname "$B_SOCKET")"

log "starting daemon B (socket $B_SOCKET)"
mx-agent daemon start >"$CONF_STATE_DIR/b/daemon.log" 2>&1 &
echo $! > "$CONF_STATE_DIR/b/daemon.pid"
wait_for_socket "$B_SOCKET" 60

MX_PASS="$B_PASS" mx-agent auth login --homeserver "$HS_URL" --user "$B_USER" \
  || die "auth login failed for $B_USER"

# Join B to A's room and register B as a target agent that publishes $TOOL.
mx-agent workspace join --room "$A_ROOM" || die "daemon B failed to join $A_ROOM"

# Load the receiver policy BEFORE registering, so B enforces deny-by-default.
POLICY_SRC="$(dirname "${BASH_SOURCE[0]}")/$POLICY_FIXTURE"
[ -f "$POLICY_SRC" ] || die "policy fixture not found: $POLICY_SRC (POLICY_FIXTURE=$POLICY_FIXTURE)"
B_POLICY="$B_DATA/mx-agent/policy.toml"
mkdir -p "$(dirname "$B_POLICY")"
# Substitute every coordinate the fixture might carry. The Tier-2 fixture
# (policy.b.toml) only contains @@ALLOW_TOOL@@/@@DENY_TOOL@@, so the golden-only
# expressions are inert no-ops there and its output is byte-identical to before.
sed -e "s|@@ALLOW_TOOL@@|$TOOL|g" \
    -e "s|@@DENY_TOOL@@|$DENIED_TOOL|g" \
    -e "s|@@APPROVAL_TOOL@@|$APPROVAL_TOOL|g" \
    -e "s|@@ALLOW_COMMAND@@|$ALLOWED_COMMAND|g" \
    -e "s|@@ALLOW_CWD@@|$ALLOW_CWD|g" \
    -e "s|@@SANDBOX_BACKEND@@|$SANDBOX_BACKEND|g" \
    "$POLICY_SRC" > "$B_POLICY"
# Fail loudly rather than load a half-substituted policy: any leftover
# @@UPPER_CASE@@ coordinate means the bring-up under-specified this fixture.
if grep -qE '@@[A-Z_]+@@' "$B_POLICY"; then
  die "policy fixture $POLICY_FIXTURE has unsubstituted coordinates: $(grep -oE '@@[A-Z_]+@@' "$B_POLICY" | sort -u | tr '\n' ' ')"
fi
log "loaded receiver policy at $B_POLICY (fixture=$POLICY_FIXTURE allow=$TOOL deny=$DENIED_TOOL)"

REG_JSON="$(mx-agent agent register --room "$A_ROOM" --kind tool-runner \
  --tool "$TOOL" --tool "$DENIED_TOOL" --json)" || die "agent.register (B) failed"
B_AGENT="$(printf '%s' "$REG_JSON" | sed -n 's/.*"agent_id"[: ]*"\([^"]*\)".*/\1/p')"
[ -n "$B_AGENT" ] || die "could not parse agent_id from B's agent.register output"

# --- Mutual Ed25519 trust (operator action; never a toolbelt path) ----------
A_FP="$(XDG_RUNTIME_DIR="$CONF_STATE_DIR/a/runtime" XDG_DATA_HOME="$CONF_STATE_DIR/a/data" \
  mx-agent trust fingerprint --json | sed -n 's/.*"key_id"[: ]*"\([^"]*\)".*/\1/p')"
B_FP="$(mx-agent trust fingerprint --json | sed -n 's/.*"key_id"[: ]*"\([^"]*\)".*/\1/p')"
[ -n "$A_FP" ] && [ -n "$B_FP" ] || die "could not read both daemons' trust fingerprints"

# B trusts A (so B will authorize A's signed CallRequest)…
mx-agent trust approve --key-id "$A_FP" || die "B failed to approve A's key"
# …and A trusts B (mutual).
XDG_RUNTIME_DIR="$CONF_STATE_DIR/a/runtime" XDG_DATA_HOME="$CONF_STATE_DIR/a/data" \
  mx-agent trust approve --key-id "$B_FP" || die "A failed to approve B's key"

emit_output agent "$B_AGENT"
emit_output tool "$TOOL"
emit_output denied_tool "$DENIED_TOOL"

# When the golden fixture is active, export the coordinates its specific test
# suite (policy-golden.conformance.test.ts) reads. MXL_CONFORMANCE_GOLDEN_POLICY=1
# tells the harness the golden fixture is loaded (not the throwaway policy.b.toml).
# MXL_CONFORMANCE_APPROVAL_GATED_TOOL is the alias await-result.conformance.test.ts
# reads for its AC 2 (awaiting_approval → ok|denied) test. Registration of the
# approval tool as a published tool on B lands with the golden bring-up (T114).
if [ "$POLICY_FIXTURE" = "policy.golden.toml" ]; then
  emit_output golden_policy "1"
  emit_output approval_gated_tool "$APPROVAL_TOOL"
  log "golden policy active — MXL_CONFORMANCE_GOLDEN_POLICY=1 approval_tool=$APPROVAL_TOOL"
fi

log "daemon B ready — agent=$B_AGENT tool=$TOOL denied=$DENIED_TOOL"
