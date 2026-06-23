#!/usr/bin/env bash
# Bootstrap daemon A — the single-daemon tiers (0/1). T007 / #7.
#
# Stands up a throwaway homeserver (or uses one provided via env), starts daemon
# A under an ISOLATED runtime/data dir, logs in a synthetic user, and creates a
# workspace. Exports the socket path + room id for the suite. Operator/out-of-band
# only — the toolbelt does none of this.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v mx-agent >/dev/null 2>&1 || die "mx-agent not on PATH — run install-mx-agent.sh first"

# The daemon refuses a socket dir with group/world access; a default umask (0022)
# creates the dir 0755 and the daemon aborts ("unsafe permissions"). Force 0700.
umask 077

mkdir -p "$CONF_STATE_DIR"
A_RUNTIME="$CONF_STATE_DIR/a/runtime"
A_DATA="$CONF_STATE_DIR/a/data"
mkdir -p "$A_RUNTIME" "$A_DATA"

# --- Homeserver -------------------------------------------------------------
# Prefer an externally-provided homeserver; else bring one up from the mx-agent
# checkout's dev/matrix tooling (reuse, no fixture drift). Fail loudly otherwise.
HS_URL="${MATRIX_HOMESERVER_URL:-}"
if [ -z "$HS_URL" ]; then
  if [ -n "${MX_AGENT_CHECKOUT:-}" ] && [ -x "$MX_AGENT_CHECKOUT/dev/matrix/scripts/matrix_dev.sh" ]; then
    log "starting throwaway homeserver via $MX_AGENT_CHECKOUT/dev/matrix"
    ( cd "$MX_AGENT_CHECKOUT/dev/matrix" && ./scripts/matrix_dev.sh up )
    HS_URL="${MATRIX_HOMESERVER_URL:-http://127.0.0.1:8008}"
  else
    die "no homeserver: set MATRIX_HOMESERVER_URL, or MX_AGENT_CHECKOUT to the mx-agent repo at the pin (see scripts/conformance/README.md)"
  fi
fi
log "homeserver: $HS_URL"

# --- Synthetic, throwaway user (never committed; generated at job time) ------
A_USER="${A_USER:-mxloom-a-$(date +%s)-$RANDOM}"
A_PASS="${A_PASS:-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')}"
# Register the user on the homeserver. The exact registration path is
# homeserver-specific; override MX_REGISTER_CMD to match your dev homeserver.
if [ -n "${MX_REGISTER_CMD:-}" ]; then
  MX_HS_URL="$HS_URL" MX_USER="$A_USER" MX_PASS="$A_PASS" bash -c "$MX_REGISTER_CMD" \
    || die "user registration failed for $A_USER"
else
  log "MX_REGISTER_CMD unset — assuming '$A_USER' is pre-provisioned on $HS_URL"
fi

# --- Daemon A under an isolated runtime/data dir ----------------------------
export XDG_RUNTIME_DIR="$A_RUNTIME"
export XDG_DATA_HOME="$A_DATA"
A_SOCKET="$XDG_RUNTIME_DIR/mx-agent/daemon.sock"
mkdir -p "$(dirname "$A_SOCKET")"

log "starting daemon A (socket $A_SOCKET)"
mx-agent daemon start >"$CONF_STATE_DIR/a/daemon.log" 2>&1 &
echo $! > "$CONF_STATE_DIR/a/daemon.pid"
wait_for_socket "$A_SOCKET" 60

# --- Login + workspace ------------------------------------------------------
# Secret boundary: credentials go to the DAEMON's own session/state, never to the
# toolbelt or the suite. Password is passed via env/stdin, never argv.
MX_AGENT_PASSWORD="$A_PASS" mx-agent auth login --homeserver "$HS_URL" --user "$A_USER" \
  || die "auth login failed for $A_USER"

# Public join-rule so the second daemon can join by room id (v0.2.1 rooms are
# invite-only by default → a non-public room is unjoinable without an invite).
ROOM_JSON="$(mx-agent workspace create --visibility public --json)" || die "workspace.create failed"
A_ROOM="$(printf '%s' "$ROOM_JSON" | sed -n 's/.*"room_id"[: ]*"\([^"]*\)".*/\1/p')"
[ -n "$A_ROOM" ] || die "could not parse room_id from workspace.create output"

# Register A as an agent so it has a STABLE sender identity. v0.2.1 trust and
# policy are both keyed on the sender agent id (`trust approve --agent`, and
# `room.agents.<id>` in the receiver policy), so daemon B must scope both to this
# exact id. The golden bring-up reads `sender_agent` to key the receiver policy.
A_REG_JSON="$(mx-agent agent register --room "$A_ROOM" --kind generic --json)" \
  || die "agent.register (A) failed"
A_AGENT="$(printf '%s' "$A_REG_JSON" | sed -n 's/.*"agent_id"[: ]*"\([^"]*\)".*/\1/p')"
[ -n "$A_AGENT" ] || die "could not parse A's agent_id from agent.register output"

emit_output socket "$A_SOCKET"
emit_output room "$A_ROOM"
emit_output sender_agent "$A_AGENT"
log "daemon A ready — socket=$A_SOCKET room=$A_ROOM sender_agent=$A_AGENT"
