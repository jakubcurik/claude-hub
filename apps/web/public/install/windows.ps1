# Claude Hub daemon installer pro Windows.
# Spusť přes: irm https://hub.animato-lab.cz/install/windows.ps1 | iex

$ErrorActionPreference = 'Stop'

$base = 'https://github.com/jakubcurik/claude-hub/releases/latest/download'
$url  = "$base/claude-hub-daemon_windows_amd64.zip"
$dest = Join-Path $env:LOCALAPPDATA 'ClaudeHub'

New-Item -ItemType Directory -Path $dest -Force | Out-Null

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-hub-daemon-$([guid]::NewGuid()).zip")
Write-Host "Stahuji Claude Hub daemon..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

Write-Host "Rozbaluji do $dest..." -ForegroundColor Cyan
Expand-Archive -Path $tmp -DestinationPath $dest -Force
Remove-Item $tmp -Force

$exe = Join-Path $dest 'claude-hub-daemon.exe'
if (-not (Test-Path $exe)) {
    throw "claude-hub-daemon.exe nebyl nalezen v $dest"
}

Write-Host ""
Write-Host "Daemon nainstalovan v $exe" -ForegroundColor Green
Write-Host "Spoustim daemon. Parovaci token se zobrazi nize." -ForegroundColor Green
Write-Host "Nechte toto okno otevrene a vratte se do hubu pro sparovani." -ForegroundColor Yellow
Write-Host ""

& $exe
