#!/bin/sh
# Claude Hub daemon installer pro Linux/macOS.
# Spustit pres: curl -fsSL https://hub.animato-lab.cz/install/unix.sh | sh

set -e

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux)  ;;
  darwin) ;;
  *) echo "Nepodporovany operacni system: $OS" >&2; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "Nepodporovana architektura: $ARCH" >&2; exit 1 ;;
esac

URL="https://github.com/jakubcurik/claude-hub/releases/latest/download/claude-hub-daemon_${OS}_${ARCH}.tar.gz"
DEST="${HOME}/.local/bin"
mkdir -p "$DEST"

echo "Stahuji Claude Hub daemon ($OS/$ARCH)..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/daemon.tar.gz"
tar -xzf "$TMP/daemon.tar.gz" -C "$DEST"

EXE="$DEST/claude-hub-daemon"
chmod +x "$EXE"

echo ""
echo "Daemon nainstalovan v $EXE"
echo "Spoustim daemon. Parovaci token se zobrazi nize."
echo "Nechte tento terminal otevreny a vratte se do hubu pro sparovani."
echo ""

exec "$EXE"
