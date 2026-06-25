#!/usr/bin/env bash
# Install the PINNED mx-agent release binary (T007 / #7).
#
# The pin means the released binary at a specific tag — not a `main` build. This
# downloads the release asset for the resolved version and puts `mx-agent` on
# PATH (via $CONF_STATE_DIR/bin). Usage: install-mx-agent.sh [version]
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VERSION="$(resolve_pin "${1:-}")"
[ -n "$VERSION" ] || die "could not resolve mx-agent version (.mx-agent-version empty?)"
NORM="$(normalize_version "$VERSION")"
log "installing pinned mx-agent $VERSION (normalized $NORM)"

mkdir -p "$CONF_STATE_DIR/bin"

# Where releases live. Override MX_AGENT_RELEASE_BASE in your environment; the
# default points at the public GitHub releases for the pinned repo.
MX_AGENT_REPO="${MX_AGENT_REPO:-kortiene/mx-agent}"
RELEASE_BASE="${MX_AGENT_RELEASE_BASE:-https://github.com/${MX_AGENT_REPO}/releases/download/${VERSION}}"

# Pick the asset for this runner. The exact asset name depends on the mx-agent
# release; the common GoReleaser/cargo-dist shape is used here. Override
# MX_AGENT_ASSET to pin an exact name. Fail loudly if the asset is unreachable —
# a conformance job that cannot obtain the pinned binary must go RED.
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
esac
ASSET="${MX_AGENT_ASSET:-mx-agent-${NORM}-${os}-${arch}.tar.gz}"
URL="${RELEASE_BASE}/${ASSET}"

log "fetching $URL"
if ! curl -fsSL "$URL" -o "$CONF_STATE_DIR/mx-agent.tar.gz"; then
  die "failed to download the pinned mx-agent release asset ($URL). Set MX_AGENT_REPO / MX_AGENT_RELEASE_BASE / MX_AGENT_ASSET, or vendor the binary (see scripts/conformance/README.md)."
fi
tar -xzf "$CONF_STATE_DIR/mx-agent.tar.gz" -C "$CONF_STATE_DIR/bin"
# The release asset may place `mx-agent` at the archive ROOT or NESTED under a
# `<name>-<ver>-<triple>/` directory (the v0.2.1 cargo-dist layout ships the
# binary, man pages, and shell completions under such a dir). Normalize so the
# binary is always resolvable at `$CONF_STATE_DIR/bin/mx-agent`.
if [ ! -x "$CONF_STATE_DIR/bin/mx-agent" ]; then
  found="$(find "$CONF_STATE_DIR/bin" -maxdepth 3 -type f -name mx-agent | head -1)"
  [ -n "$found" ] || die "could not locate the mx-agent binary in the extracted asset ($ASSET)"
  ln -sf "$found" "$CONF_STATE_DIR/bin/mx-agent"
fi
chmod +x "$CONF_STATE_DIR/bin/mx-agent" 2>/dev/null || true

# Put it on PATH for subsequent steps.
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$CONF_STATE_DIR/bin" >> "$GITHUB_PATH"
fi
export PATH="$CONF_STATE_DIR/bin:$PATH"

INSTALLED="$("$CONF_STATE_DIR/bin/mx-agent" --version 2>/dev/null || true)"
log "installed mx-agent: ${INSTALLED:-<unknown>}"
[ -n "$INSTALLED" ] || die "mx-agent binary did not run after install"
