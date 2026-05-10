#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

VERSION="${CLAUDE_HUB_AGENT_VERSION:-latest}"
RELEASE_BASE="${CLAUDE_HUB_AGENT_RELEASE_BASE:-https://github.com/animato/claude-hub/releases/download}"
INSTALL_DIR="${CLAUDE_HUB_AGENT_INSTALL_DIR:-$HOME/.local/bin}"

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    *) echo "Unsupported OS: $uname_s" >&2; exit 1 ;;
esac
case "$uname_m" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported arch: $uname_m" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
    url="$RELEASE_BASE/latest/claude-hub-agent_${os}_${arch}.tar.gz"
else
    url="$RELEASE_BASE/v${VERSION}/claude-hub-agent_${os}_${arch}.tar.gz"
fi

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d)"
echo "Downloading $url"
curl -fSL "$url" -o "$tmp/agent.tar.gz"
tar -xzf "$tmp/agent.tar.gz" -C "$tmp"
mv "$tmp/claude-hub-agent" "$INSTALL_DIR/claude-hub-agent"
chmod +x "$INSTALL_DIR/claude-hub-agent"
rm -rf "$tmp"

echo "Installing service (requires sudo or admin context for systemd/launchd)..."
"$INSTALL_DIR/claude-hub-agent" service install || true
"$INSTALL_DIR/claude-hub-agent" service start  || true

echo "Installed claude-hub-agent to $INSTALL_DIR/claude-hub-agent"
echo "Next step: run 'claude-hub-agent pair --hub <hub-url> --pin <pin-from-dashboard>'"
