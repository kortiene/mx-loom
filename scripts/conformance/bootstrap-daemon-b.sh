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

# Load the minimal receiver policy BEFORE registering, so B enforces deny-by-default.
POLICY_SRC="$(dirname "${BASH_SOURCE[0]}")/policy.b.toml"
B_POLICY="$B_DATA/mx-agent/policy.toml"
mkdir -p "$(dirname "$B_POLICY")"
# Substitute the tool names into the fixture policy.
sed -e "s|@@ALLOW_TOOL@@|$TOOL|g" -e "s|@@DENY_TOOL@@|$DENIED_TOOL|g" "$POLICY_SRC" > "$B_POLICY"
log "loaded receiver policy at $B_POLICY (allow=$TOOL deny=$DENIED_TOOL)"

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
log "daemon B ready — agent=$B_AGENT tool=$TOOL denied=$DENIED_TOOL"
