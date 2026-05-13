// Dynamický endpoint pro install skripty. Hub URL (kterou daemon musí mít
// v `CLAUDE_HUB_ALLOWED_WEB_ORIGINS` aby browser pustil CORS fetch) se sem
// vkládá z env var CLAUDE_HUB_PUBLIC_URL, takže fork pro jiný deploy
// stačí přepsat compose.yaml a skript se automaticky upraví.
//
// Skripty zaregistrují daemona jako uživatelskou službu (launchd na macOS,
// systemd --user na Linuxu, Scheduled Task na Windows), takže poběží na
// pozadí, přežije reboot a uživatel nemusí držet otevřený terminál.

const RELEASE_BASE =
  "https://github.com/jakubcurik/claude-hub/releases/latest/download";

function hubUrl(): string {
  const raw = process.env.CLAUDE_HUB_PUBLIC_URL ?? "https://hub.animato-lab.cz";
  return raw.replace(/\/$/, "");
}

function windowsScript(): string {
  const hub = hubUrl();
  return `# Claude Hub daemon installer pro Windows.
# Zaregistruje daemona jako Scheduled Task spoustenou pri prihlaseni,
# spusti ho hned na pozadi (skryte okno) a survives reboot.
#
# Spust pres: irm ${hub}/install/windows.ps1 | iex

$ErrorActionPreference = 'Stop'

$dest     = Join-Path $env:LOCALAPPDATA 'ClaudeHub'
$exe      = Join-Path $dest 'claude-hub-daemon.exe'
$vbs      = Join-Path $dest 'start-daemon.vbs'
$url      = '${RELEASE_BASE}/claude-hub-daemon_windows_amd64.zip'
$taskName = 'ClaudeHubDaemon'
$hubUrl   = '${hub}'

# --- Zastavit bezici instance (pokud existuji)
Write-Host 'Zastavuji bezici daemon...' -ForegroundColor Cyan
Get-Process 'claude-hub-daemon' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue

# --- Stahnout a rozbalit binarku
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-hub-daemon-$([guid]::NewGuid()).zip")
Write-Host 'Stahuji Claude Hub daemon...' -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
Write-Host "Rozbaluji do $dest..." -ForegroundColor Cyan
Expand-Archive -Path $tmp -DestinationPath $dest -Force
Remove-Item $tmp -Force

if (-not (Test-Path $exe)) {
    throw "claude-hub-daemon.exe nebyl nalezen v $dest"
}

# --- VBS launcher: spusti daemona skryte, s nastavenou CORS env var.
# Bez VBS by Scheduled Task otevrel kratce konzolove okno.
$vbsBody = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("Process")("CLAUDE_HUB_ALLOWED_WEB_ORIGINS") = "$hubUrl"
sh.Run """$exe""", 0, False
"@
Set-Content -Path $vbs -Value $vbsBody -Encoding ASCII

# --- Scheduled Task: pri kazdem prihlaseni spusti daemona
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
$task     = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

# --- Spustit hned (bez cekani na dalsi prihlaseni)
Write-Host 'Spoustim daemon na pozadi...' -ForegroundColor Cyan
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden

Write-Host ''
Write-Host 'Hotovo! Claude Hub daemon bezi na pozadi.' -ForegroundColor Green
Write-Host 'Po restartu pocitace se spusti automaticky.' -ForegroundColor Green
Write-Host ''
Write-Host 'Dalsi krok: vratte se do hubu a kliknete na Sparovat.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Pro odinstalaci spustte:' -ForegroundColor DarkGray
Write-Host '  Unregister-ScheduledTask -TaskName ClaudeHubDaemon -Confirm:$false' -ForegroundColor DarkGray
Write-Host '  Get-Process claude-hub-daemon | Stop-Process -Force' -ForegroundColor DarkGray
Write-Host "  Remove-Item -Recurse '$dest'" -ForegroundColor DarkGray
`;
}

function unixScript(): string {
  const hub = hubUrl();
  return `#!/bin/sh
# Claude Hub daemon installer pro Linux/macOS.
# Zaregistruje daemona jako uzivatelskou sluzbu (launchd na macOS,
# systemd --user na Linuxu) a spusti ho na pozadi.
#
# Spust pres: curl -fsSL ${hub}/install/unix.sh | sh

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
EXE="\$DEST/claude-hub-daemon"
HUB="${hub}"
LABEL='cz.animato-lab.claude-hub-daemon'

mkdir -p "$DEST"

# --- Zastavit bezici instance (pokud existuji)
echo 'Zastavuji bezici daemon...'
if [ "$OS" = "darwin" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
else
  systemctl --user stop claude-hub-daemon 2>/dev/null || true
fi
pkill -f 'claude-hub-daemon' 2>/dev/null || true

# --- Stahnout a rozbalit binarku
echo "Stahuji Claude Hub daemon ($OS/$ARCH)..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/daemon.tar.gz"
tar -xzf "$TMP/daemon.tar.gz" -C "$DEST"
chmod +x "$EXE"

# --- Zaregistrovat sluzbu
if [ "$OS" = "darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$PLIST_DIR/$LABEL.plist"
  LOG_DIR="$HOME/Library/Logs"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>\$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>\$EXE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_HUB_ALLOWED_WEB_ORIGINS</key>
    <string>\$HUB</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>\$LOG_DIR/claude-hub-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>\$LOG_DIR/claude-hub-daemon.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  echo 'Sluzba zaregistrovana v launchd a spustena.'
else
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_PATH="$UNIT_DIR/claude-hub-daemon.service"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Claude Hub Daemon
After=network.target

[Service]
Type=simple
ExecStart=\$EXE
Environment="CLAUDE_HUB_ALLOWED_WEB_ORIGINS=\$HUB"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now claude-hub-daemon
  echo 'Sluzba zaregistrovana v systemd --user a spustena.'
fi

echo ''
echo 'Hotovo! Claude Hub daemon bezi na pozadi.'
echo 'Po restartu pocitace se spusti automaticky.'
echo ''
echo 'Dalsi krok: vratte se do hubu a kliknete na Sparovat.'
echo ''

if [ "$OS" = "darwin" ]; then
  echo 'Pro odinstalaci:'
  echo "  launchctl bootout gui/\\$(id -u)/$LABEL"
  echo "  rm -f $PLIST_PATH $EXE"
else
  echo 'Pro odinstalaci:'
  echo "  systemctl --user disable --now claude-hub-daemon"
  echo "  rm -f $UNIT_PATH $EXE"
fi
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
