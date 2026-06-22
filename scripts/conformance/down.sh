#!/usr/bin/env bash
# Teardown the conformance bring-up (T007 / #7). Idempotent; safe to run always.
#
# Stops both daemons + the homeserver, scrubs secret-shaped lines from any daemon
# logs BEFORE they could be uploaded as artifacts, and never persists keys or
# sessions. Best-effort: a missing pid/log is not an error.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

stop_pidfile() {
  local pidfile="$1"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping daemon pid $pid"
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

# Stop daemons.
mx-agent daemon stop >/dev/null 2>&1 || true
stop_pidfile "$CONF_STATE_DIR/a/daemon.pid"
stop_pidfile "$CONF_STATE_DIR/b/daemon.pid"

# Stop the homeserver if we brought one up from the mx-agent checkout.
if [ -n "${MX_AGENT_CHECKOUT:-}" ] && [ -x "$MX_AGENT_CHECKOUT/dev/matrix/scripts/matrix_dev.sh" ]; then
  ( cd "$MX_AGENT_CHECKOUT/dev/matrix" && ./scripts/matrix_dev.sh down ) || true
fi

# Scrub secret-shaped lines from logs before any artifact upload. Same patterns
# the suite asserts on (MATRIX_/MX_AGENT_/syt_/ghp_/xox[bp]-) plus access_token.
if [ -d "$CONF_STATE_DIR" ]; then
  while IFS= read -r -d '' logf; do
    sed -i.bak -E 's/(syt_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+|xox[bp]-[A-Za-z0-9-]+|"?access_token"?[: ]*"?[^",} ]+)/<redacted>/g' "$logf" 2>/dev/null || true
    rm -f "$logf.bak"
  done < <(find "$CONF_STATE_DIR" -type f -name '*.log' -print0 2>/dev/null)
fi

# Remove signing keys / sessions outright — never persist them.
find "$CONF_STATE_DIR" -type f \( -name 'signing_key*' -o -name '*.session' \) -delete 2>/dev/null || true

log "teardown complete"
