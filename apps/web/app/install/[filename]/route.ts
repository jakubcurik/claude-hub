// Dynamický endpoint pro install skripty. Hub URL (kterou daemon musí mít
// v `CLAUDE_HUB_ALLOWED_WEB_ORIGINS` aby browser pustil CORS fetch) se sem
// vkládá z env var CLAUDE_HUB_PUBLIC_URL, takže fork pro jiný deploy
// stačí přepsat compose.yaml a skript se automaticky upraví.

const RELEASE_BASE =
  "https://github.com/jakubcurik/claude-hub/releases/latest/download";

function hubUrl(): string {
  const raw = process.env.CLAUDE_HUB_PUBLIC_URL ?? "https://hub.animato-lab.cz";
  return raw.replace(/\/$/, "");
}

function windowsScript(): string {
  const hub = hubUrl();
  return `# Claude Hub daemon installer pro Windows.
# Spust pres: irm ${hub}/install/windows.ps1 | iex

$ErrorActionPreference = 'Stop'

$url  = '${RELEASE_BASE}/claude-hub-daemon_windows_amd64.zip'
$dest = Join-Path $env:LOCALAPPDATA 'ClaudeHub'

New-Item -ItemType Directory -Path $dest -Force | Out-Null

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-hub-daemon-$([guid]::NewGuid()).zip")
Write-Host 'Stahuji Claude Hub daemon...' -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

Write-Host "Rozbaluji do $dest..." -ForegroundColor Cyan
Expand-Archive -Path $tmp -DestinationPath $dest -Force
Remove-Item $tmp -Force

$exe = Join-Path $dest 'claude-hub-daemon.exe'
if (-not (Test-Path $exe)) {
    throw "claude-hub-daemon.exe nebyl nalezen v $dest"
}

# CORS allow-list pro hub origin — bez toho prohlizec zablokuje parovaci fetch
# (daemon by jinak odpovedel bez Access-Control-Allow-Origin pro non-localhost).
$env:CLAUDE_HUB_ALLOWED_WEB_ORIGINS = '${hub}'

Write-Host ""
Write-Host "Daemon nainstalovan v $exe" -ForegroundColor Green
Write-Host "Spoustim daemon. Parovaci token se zobrazi nize." -ForegroundColor Green
Write-Host "Nechte toto okno otevrene a vratte se do hubu pro sparovani." -ForegroundColor Yellow
Write-Host ""

& $exe
`;
}

function unixScript(): string {
  const hub = hubUrl();
  return `#!/bin/sh
# Claude Hub daemon installer pro Linux/macOS.
# Spustit pres: curl -fsSL ${hub}/install/unix.sh | sh

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

URL="${RELEASE_BASE}/claude-hub-daemon_\${OS}_\${ARCH}.tar.gz"
DEST="\${HOME}/.local/bin"
mkdir -p "$DEST"

echo "Stahuji Claude Hub daemon ($OS/$ARCH)..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/daemon.tar.gz"
tar -xzf "$TMP/daemon.tar.gz" -C "$DEST"

EXE="$DEST/claude-hub-daemon"
chmod +x "$EXE"

# CORS allow-list pro hub origin — bez toho prohlizec zablokuje parovaci fetch
# (daemon by jinak odpovedel bez Access-Control-Allow-Origin pro non-localhost).
export CLAUDE_HUB_ALLOWED_WEB_ORIGINS='${hub}'

echo ""
echo "Daemon nainstalovan v $EXE"
echo "Spoustim daemon. Parovaci token se zobrazi nize."
echo "Nechte tento terminal otevreny a vratte se do hubu pro sparovani."
echo ""

exec "$EXE"
`;
}

const SCRIPTS: Record<string, { contentType: string; body: () => string }> = {
  "windows.ps1": {
    contentType: "text/plain; charset=utf-8",
    body: windowsScript
  },
  "unix.sh": {
    contentType: "text/plain; charset=utf-8",
    body: unixScript
  }
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const handler = SCRIPTS[filename];
  if (!handler) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(handler.body(), {
    headers: {
      "Content-Type": handler.contentType,
      // Cachovat krátce, ať změna CLAUDE_HUB_PUBLIC_URL prosviští rychle.
      "Cache-Control": "public, max-age=60"
    }
  });
}
