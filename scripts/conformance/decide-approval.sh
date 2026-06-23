#!/usr/bin/env bash
# Out-of-band operator approval decision on daemon B — the GOLDEN test (T114 / #22).
#
#   decide-approval.sh <approve|deny> [--match <substr>]
#
# This is the OPERATOR. It runs as daemon B's identity (B's isolated
# XDG_RUNTIME_DIR/XDG_DATA_HOME, exactly as bootstrap-daemon-b.sh does for `trust
# approve`) and issues `approval.decide` via the `mx-agent` CLI. It NEVER touches
# any @mx-loom/* model-facing surface: `approval.decide`, `trust.*`, `policy.*` are
# operator authority and are structurally absent from the model tool set. The
# golden harness shells out to this script at the exact moment a step is held, so
# the operator decision lives strictly between the hold and the resolve — the test
# stays deterministic (no guessing bot). The model never approves anything itself.
#
# The CLI/RPC vocabulary (`approval list/approve/deny`) is localized in the consts
# below so a wrong v0.2.1 spelling is a one-line fix (spec OQ #2). A wrong spelling,
# or no pending request within the budget, exits non-zero — the golden run goes RED,
# never silently green.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v mx-agent >/dev/null 2>&1 || die "mx-agent not on PATH — run install-mx-agent.sh first"

# --- Args -------------------------------------------------------------------
ACTION="${1:-}"
shift || true
MATCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --match) MATCH="${2:-}"; shift 2 ;;
    *) die "decide-approval.sh: unknown argument '$1' (usage: <approve|deny> [--match <substr>])" ;;
  esac
done
case "$ACTION" in
  approve|deny) ;;
  *) die "decide-approval.sh: first argument must be 'approve' or 'deny' (got '${ACTION:-<empty>}')" ;;
esac

# --- Localized CLI vocabulary (pin at the live round-trip — spec OQ #2) ------
APPROVAL_LIST_CMD=(mx-agent approval list --json)   # UNVERIFIED — confirm/correct at AC time
APPROVE_CMD=(mx-agent approval approve)             # UNVERIFIED — `approval.decide` approve
DENY_CMD=(mx-agent approval deny)                   # UNVERIFIED — `approval.decide` deny

# --- Operate as daemon B (its isolated runtime/data dir) --------------------
export XDG_RUNTIME_DIR="${B_RUNTIME:-$CONF_STATE_DIR/b/runtime}"
export XDG_DATA_HOME="${B_DATA:-$CONF_STATE_DIR/b/data}"
B_SOCKET="$XDG_RUNTIME_DIR/mx-agent/daemon.sock"
[ -S "$B_SOCKET" ] || die "daemon B socket not found at $B_SOCKET — bring up daemon B (bootstrap-daemon-b.sh) first"

# --- Extract the pending request id (jq when present; sed fallback) ---------
# Filter to lines/objects containing $MATCH (the tool/command name) when given, so
# approve-vs-deny targets the right request when several are pending.
extract_request_id() {
  local json="$1"
  if [ -n "$MATCH" ]; then
    if command -v jq >/dev/null 2>&1; then
      # Array of objects (or a single object) → first whose serialization contains $MATCH.
      printf '%s' "$json" | jq -r --arg m "$MATCH" '
        [ (if type=="array" then .[] else . end)
          | select((tostring) | contains($m)) ][0]
          | (.request_id // .id // .approval_id // empty)' 2>/dev/null
      return
    fi
    # sed fallback: keep only the matching record's id (best-effort, single line).
    printf '%s' "$json" | tr '}' '}\n' | grep -F "$MATCH" \
      | sed -n 's/.*"\(request_id\|id\|approval_id\)"[: ]*"\([^"]*\)".*/\2/p' | head -n1
    return
  fi
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r '
      (if type=="array" then .[0] else . end)
        | (.request_id // .id // .approval_id // empty)' 2>/dev/null
    return
  fi
  printf '%s' "$json" | sed -n 's/.*"\(request_id\|id\|approval_id\)"[: ]*"\([^"]*\)".*/\2/p' | head -n1
}

# --- Bounded poll for the pending request (tolerate /sync propagation lag) ---
DECIDE_TIMEOUT="${MXL_APPROVAL_DECIDE_TIMEOUT:-60}"
REQUEST_ID=""
waited=0
while [ -z "$REQUEST_ID" ]; do
  LIST_JSON="$("${APPROVAL_LIST_CMD[@]}" 2>/dev/null || true)"
  REQUEST_ID="$(extract_request_id "$LIST_JSON")"
  [ -n "$REQUEST_ID" ] && break
  if [ "$waited" -ge "$DECIDE_TIMEOUT" ]; then
    die "no pending approval${MATCH:+ matching '$MATCH'} on daemon B within ${DECIDE_TIMEOUT}s — \
the held step never reached the approval gate, or the 'approval list' CLI spelling is wrong (see APPROVAL_LIST_CMD)."
  fi
  sleep 1
  waited=$((waited + 1))
done

log "operator: ${ACTION} approval request '$REQUEST_ID'${MATCH:+ (match='$MATCH')}"

# --- Issue the decision (a wrong spelling exits non-zero → golden run red) ---
if [ "$ACTION" = "approve" ]; then
  "${APPROVE_CMD[@]}" "$REQUEST_ID" || die "approval approve failed for '$REQUEST_ID' (check APPROVE_CMD spelling)"
else
  "${DENY_CMD[@]}" "$REQUEST_ID" || die "approval deny failed for '$REQUEST_ID' (check DENY_CMD spelling)"
fi

log "operator: ${ACTION} done for '$REQUEST_ID'"
