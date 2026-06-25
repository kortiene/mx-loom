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

# Daemon refuses a group/world-accessible socket dir; force 0700 (default umask
# 0022 creates 0755 and the daemon aborts with "unsafe permissions").
umask 077

A_SOCKET="${A_SOCKET:-$CONF_STATE_DIR/a/runtime/mx-agent/daemon.sock}"
A_ROOM="${A_ROOM:-${MXL_CONFORMANCE_ROOM:-}}"
# Daemon A's agent id — TRUST is scoped to this id (`trust approve --agent`). Emitted
# by bootstrap-daemon-a.sh as `sender_agent`.
SENDER_AGENT="${MXL_CONFORMANCE_SENDER_AGENT:-${A_AGENT:-}}"
[ -S "$A_SOCKET" ] || die "daemon A socket not found at $A_SOCKET — run bootstrap-daemon-a.sh first"
[ -n "$A_ROOM" ]   || die "daemon A room unknown — pass A_ROOM (from bootstrap-daemon-a.sh output)"

SERVER_NAME="${MXL_SERVER_NAME:-golden.local}"

# Daemon A's Matrix user id — as of mx-agent v0.2.2 (kortiene/mx-agent#366) the
# receiver POLICY is keyed on the sender's matrix_user_id (resolved from the signed
# agent state), while TRUST stays scoped to the agent id above. Prefer an explicit
# override; else read it from A's published agent state (by SENDER_AGENT), else
# derive `@<localpart>:<server>` from the agent id (`<localpart>-<device>`).
SENDER_USER="${MXL_CONFORMANCE_SENDER_USER:-}"
if [ -z "$SENDER_USER" ] && [ -n "$SENDER_AGENT" ] && command -v jq >/dev/null 2>&1; then
  SENDER_USER="$(XDG_RUNTIME_DIR="$CONF_STATE_DIR/a/runtime" XDG_DATA_HOME="$CONF_STATE_DIR/a/data" \
    mx-agent agent list --room "$A_ROOM" --json 2>/dev/null \
    | jq -r --arg a "$SENDER_AGENT" '.[] | (.agent // .) | select(.agent_id==$a) | .matrix_user_id' 2>/dev/null | head -n1)"
fi
if [ -z "$SENDER_USER" ] && [ -n "$SENDER_AGENT" ]; then
  SENDER_USER="@${SENDER_AGENT%-*}:${SERVER_NAME}"   # localpart = agent id minus the trailing -<device>
fi

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
# scripts/conformance/README.md "golden-test policy (T112)". T114 completes the
# golden bring-up: the approval tool is registered as a published tool on B (below),
# guarded exec is enabled, and the MXL_CONFORMANCE_APPROVAL_* / _ALLOWED_COMMAND /
# _ALLOW_CWD coordinates are emit_output-ed for the golden e2e suite + the staged
# T112 AC 2 tests.
#
# @@APPROVAL_TOOL@@ is the high-risk, approval-gated NAMED tool — it must be a name
# DISTINCT from both @@ALLOW_TOOL@@ (ungated) and the deny-by-default tool, since the
# golden policy lists @@ALLOW_TOOL@@ + @@APPROVAL_TOOL@@ in `[[allow]]` and the deny
# tool is deliberately ABSENT (deny-by-default). Default `release@1.0.0` so it never
# collides with the `deploy@1.0.0` deny tool.
APPROVAL_TOOL="${MXL_CONFORMANCE_APPROVAL_TOOL:-release@1.0.0}"    # high-risk, approval-gated named tool
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

# --- Receiver policy — written BEFORE start, read from MX_AGENT_CONFIG_DIR ---
# v0.2.1 resolves the policy path at the FIRST `daemon start` from
# MX_AGENT_CONFIG_DIR (else $XDG_CONFIG_HOME/mx-agent, else $HOME/.config/mx-agent)
# — NOT the data dir. Writing the policy after start (or to the data dir) leaves
# the daemon policy-less → silent deny-all. So write it to a per-daemon config dir
# and point MX_AGENT_CONFIG_DIR at it before starting. The golden fixture is
# room- and sender-agent-scoped, so it needs $A_ROOM + $SENDER_AGENT substituted.
B_CONFIG="$CONF_STATE_DIR/b/config"
mkdir -p "$B_CONFIG"
export MX_AGENT_CONFIG_DIR="$B_CONFIG"
POLICY_SRC="$(dirname "${BASH_SOURCE[0]}")/$POLICY_FIXTURE"
[ -f "$POLICY_SRC" ] || die "policy fixture not found: $POLICY_SRC (POLICY_FIXTURE=$POLICY_FIXTURE)"
if [ "$POLICY_FIXTURE" = "policy.golden.toml" ] && [ -z "$SENDER_AGENT" ]; then
  die "golden policy needs the sender agent id — set MXL_CONFORMANCE_SENDER_AGENT (daemon A's \
agent id, emitted by bootstrap-daemon-a.sh as 'sender_agent')."
fi
# The shipped fixtures key the agent rule on A's Matrix user id (v0.2.2 / #366); a
# half-substituted `agents.""` would be malformed → silent deny-all, so require it.
if grep -q '@@SENDER_USER@@' "$POLICY_SRC" && [ -z "$SENDER_USER" ]; then
  die "policy $POLICY_FIXTURE needs daemon A's Matrix user id — set MXL_CONFORMANCE_SENDER_USER \
(A's @user:server; mx-agent v0.2.2 keys the receiver policy on it, kortiene/mx-agent#366)."
fi
B_POLICY="$B_CONFIG/policy.toml"
sed -e "s|@@ROOM@@|$A_ROOM|g" \
    -e "s|@@SENDER_AGENT@@|$SENDER_AGENT|g" \
    -e "s|@@SENDER_USER@@|$SENDER_USER|g" \
    -e "s|@@ALLOW_TOOL@@|$TOOL|g" \
    -e "s|@@DENY_TOOL@@|$DENIED_TOOL|g" \
    -e "s|@@APPROVAL_TOOL@@|$APPROVAL_TOOL|g" \
    -e "s|@@ALLOW_COMMAND@@|$ALLOWED_COMMAND|g" \
    -e "s|@@ALLOW_CWD@@|$ALLOW_CWD|g" \
    -e "s|@@SANDBOX_BACKEND@@|$SANDBOX_BACKEND|g" \
    "$POLICY_SRC" > "$B_POLICY"
chmod 600 "$B_POLICY"
# Fail loudly rather than load a half-substituted policy.
if grep -qE '@@[A-Z_]+@@' "$B_POLICY"; then
  die "policy fixture $POLICY_FIXTURE has unsubstituted coordinates: $(grep -oE '@@[A-Z_]+@@' "$B_POLICY" | sort -u | tr '\n' ' ')"
fi
log "receiver policy at $B_POLICY (MX_AGENT_CONFIG_DIR; fixture=$POLICY_FIXTURE allow=$TOOL deny=$DENIED_TOOL)"

log "starting daemon B (socket $B_SOCKET)"
mx-agent daemon start >"$CONF_STATE_DIR/b/daemon.log" 2>&1 &
echo $! > "$CONF_STATE_DIR/b/daemon.pid"
wait_for_socket "$B_SOCKET" 60

MX_AGENT_PASSWORD="$B_PASS" mx-agent auth login --homeserver "$HS_URL" --user "$B_USER" \
  || die "auth login failed for $B_USER"

# Join B to A's room and register B as a target agent that publishes $TOOL.
mx-agent workspace join "$A_ROOM" || die "daemon B failed to join $A_ROOM"

# B needs the workspace agent power level (50) to publish agent state; A (room
# creator, PL100) grants it to B's Matrix user after the join. (SERVER_NAME is
# resolved once near the top, alongside the sender's Matrix user id.)
B_MXID="@${B_USER}:${SERVER_NAME}"
XDG_RUNTIME_DIR="$CONF_STATE_DIR/a/runtime" XDG_DATA_HOME="$CONF_STATE_DIR/a/data" \
  mx-agent workspace grant --room "$A_ROOM" --user "$B_MXID" || die "A failed to grant B agent power in $A_ROOM"

# B publishes the ungated tool + the deny-by-default tool. Under the golden
# fixture it ALSO publishes the approval-gated tool (T114) so the
# `requires_approval=true` branch is reachable — guarding that it is a distinct
# name from the ungated and deny tools (the policy lists allow+approval; deny is
# deny-by-default and must NOT be published-and-allowed).
REG_TOOL_ARGS=(--tool "$TOOL" --tool "$DENIED_TOOL")
if [ "$POLICY_FIXTURE" = "policy.golden.toml" ]; then
  if [ "$APPROVAL_TOOL" = "$TOOL" ] || [ "$APPROVAL_TOOL" = "$DENIED_TOOL" ]; then
    die "golden bring-up: MXL_CONFORMANCE_APPROVAL_TOOL ('$APPROVAL_TOOL') must differ from \
the allowed tool ('$TOOL') and the deny tool ('$DENIED_TOOL') — the golden policy lists allow+approval, \
and the deny tool must stay deny-by-default."
  fi
  REG_TOOL_ARGS+=(--tool "$APPROVAL_TOOL")
fi
REG_JSON="$(mx-agent agent register --room "$A_ROOM" --kind tool-runner \
  "${REG_TOOL_ARGS[@]}" --json)" || die "agent.register (B) failed"
B_AGENT="$(printf '%s' "$REG_JSON" | sed -n 's/.*"agent_id"[: ]*"\([^"]*\)".*/\1/p')"
[ -n "$B_AGENT" ] || die "could not parse agent_id from B's agent.register output"

# --- Mutual Ed25519 trust (operator action; never a toolbelt path) ----------
# v0.2.1: `trust approve --agent <AGENT> --key <KEY> [--room]`; KEY is the
# `key_id` (mxagent-ed25519:…) from `trust fingerprint`. Trust is scoped to an
# (agent, key) pair, so A must also be a registered agent for B to trust it.
A_KEY="$(XDG_RUNTIME_DIR="$CONF_STATE_DIR/a/runtime" XDG_DATA_HOME="$CONF_STATE_DIR/a/data" \
  mx-agent trust fingerprint --json | sed -n 's/.*"key_id"[: ]*"\([^"]*\)".*/\1/p')"
B_KEY="$(mx-agent trust fingerprint --json | sed -n 's/.*"key_id"[: ]*"\([^"]*\)".*/\1/p')"
[ -n "$A_KEY" ] && [ -n "$B_KEY" ] || die "could not read both daemons' trust keys"
[ -n "$SENDER_AGENT" ] || die "sender agent id unknown — bootstrap-daemon-a.sh must emit 'sender_agent'"

# B trusts A (so B will authorize A's signed CallRequest), scoped to A's agent id
# (already registered by bootstrap-daemon-a.sh) + A's signing key…
mx-agent trust approve --agent "$SENDER_AGENT" --key "$A_KEY" --room "$A_ROOM" \
  || die "B failed to approve A's key"
# …and A trusts B (mutual).
XDG_RUNTIME_DIR="$CONF_STATE_DIR/a/runtime" XDG_DATA_HOME="$CONF_STATE_DIR/a/data" \
  mx-agent trust approve --agent "$B_AGENT" --key "$B_KEY" --room "$A_ROOM" \
  || die "A failed to approve B's key"

emit_output agent "$B_AGENT"
emit_output tool "$TOOL"
emit_output denied_tool "$DENIED_TOOL"

# When the golden fixture is active, complete the golden bring-up (T114): enable
# guarded exec for the allowlisted command, then export every coordinate the golden
# e2e suite (@mx-loom/golden) and the staged T112/T113 tests read.
#   MXL_CONFORMANCE_GOLDEN_POLICY=1     — the golden fixture is loaded (not policy.b.toml).
#   MXL_CONFORMANCE_APPROVAL_TOOL       — the approval-gated named tool (now PUBLISHED above).
#   MXL_CONFORMANCE_APPROVAL_GATED_TOOL — alias await-result.conformance.test.ts reads (AC 2).
#   MXL_CONFORMANCE_ALLOWED_COMMAND     — the one allowlisted, approval-gated guarded command.
#   MXL_CONFORMANCE_ALLOW_CWD           — the cwd that command may run in.
if [ "$POLICY_FIXTURE" = "policy.golden.toml" ]; then
  # Guarded exec ships DISABLED (design §6 L4). The `[exec]` block in the loaded
  # policy is the receiver-side enable; whether a separate daemon toggle is also
  # required is UNVERIFIED (spec OQ #5) — attempt it best-effort with a localized
  # command and warn (never die) on a spelling miss, so the golden test surfaces the
  # real behavior RED rather than the bring-up failing on an unpinned subcommand.
  EXEC_ENABLE_CMD=(mx-agent exec enable)   # UNVERIFIED — pin/correct at AC time (spec OQ #5)
  if "${EXEC_ENABLE_CMD[@]}" >/dev/null 2>&1; then
    log "guarded exec enabled on daemon B for '$ALLOWED_COMMAND'"
  else
    log "WARN: '${EXEC_ENABLE_CMD[*]}' not available/needed (UNVERIFIED, spec OQ #5) — \
relying on the policy [exec] block; if exec is not actually enabled, T114 S6/S7 fail RED (the forcing function)."
  fi

  emit_output golden_policy "1"
  emit_output approval_tool "$APPROVAL_TOOL"
  emit_output approval_gated_tool "$APPROVAL_TOOL"
  emit_output allowed_command "$ALLOWED_COMMAND"
  emit_output allow_cwd "$ALLOW_CWD"
  log "golden policy active — MXL_CONFORMANCE_GOLDEN_POLICY=1 approval_tool=$APPROVAL_TOOL \
allowed_command=$ALLOWED_COMMAND allow_cwd=$ALLOW_CWD"
fi

log "daemon B ready — agent=$B_AGENT tool=$TOOL denied=$DENIED_TOOL"
