#!/usr/bin/env bash
# Shared helpers for the conformance bring-up (T007 / #7).
# Source this: `. "$(dirname "$0")/lib.sh"`
set -euo pipefail

# Repo root = two levels up from scripts/conformance/.
CONF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CONF_DIR/../.." && pwd)"

# Per-run state lives under a single dir so down.sh can scrub/teardown everything.
CONF_STATE_DIR="${CONF_STATE_DIR:-${RUNNER_TEMP:-/tmp}/mxl-conformance}"

log()  { printf '[conformance] %s\n' "$*" >&2; }
die()  { printf '[conformance][FATAL] %s\n' "$*" >&2; exit 1; }

# Resolve the pinned mx-agent version (single source of truth). Optional $1 override.
resolve_pin() {
  local override="${1:-}"
  if [ -n "$override" ]; then
    printf '%s' "$override"
  else
    tr -d '[:space:]' < "$REPO_ROOT/.mx-agent-version"
  fi
}

# Strip a single leading `v`: v0.2.1 -> 0.2.1 (matches daemon.status.version).
normalize_version() { printf '%s' "${1#v}"; }

# Emit key=value to the GitHub Actions step output (no-op locally).
emit_output() {
  local key="$1" value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
  log "output $key=$value"
}

# Poll for the daemon socket to appear (bounded). $1 = socket path, $2 = timeout s.
wait_for_socket() {
  local socket="$1" timeout="${2:-60}" waited=0
  while [ ! -S "$socket" ]; do
    [ "$waited" -ge "$timeout" ] && die "daemon socket '$socket' did not appear within ${timeout}s"
    sleep 1
    waited=$((waited + 1))
  done
  log "daemon socket ready: $socket (${waited}s)"
}
