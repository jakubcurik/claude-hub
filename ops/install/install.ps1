# SPDX-License-Identifier: Apache-2.0
$ErrorActionPreference = "Stop"

$Version    = if ($env:CLAUDE_HUB_AGENT_VERSION) { $env:CLAUDE_HUB_AGENT_VERSION } else { "latest" }
$Base       = if ($env:CLAUDE_HUB_AGENT_RELEASE_BASE) { $env:CLAUDE_HUB_AGENT_RELEASE_BASE } else { "https://github.com/animato/claude-hub/releases/download" }
$InstallDir = if ($env:CLAUDE_HUB_AGENT_INSTALL_DIR) { $env:CLAUDE_HUB_AGENT_INSTALL_DIR } else { "$env:LOCALAPPDATA\claude-hub" }

$arch = if ([System.Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
} else { throw "32-bit Windows not supported." }

$tag = if ($Version -eq "latest") { "latest" } else { "v$Version" }
$url = "$Base/$tag/claude-hub-agent_windows_${arch}.zip"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tmp = New-TemporaryFile
$zip = "$($tmp.FullName).zip"
Move-Item $tmp.FullName $zip

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
Remove-Item $zip

$exe = Join-Path $InstallDir "claude-hub-agent.exe"
& $exe service install
& $exe service start

# Add InstallDir to user PATH if missing
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($path -split ";" -contains $InstallDir)) {
    [Environment]::SetEnvironmentVariable("Path", "$path;$InstallDir", "User")
}

Write-Host "Installed claude-hub-agent to $InstallDir"
Write-Host "Next: run 'claude-hub-agent pair --hub <hub-url> --pin <pin-from-dashboard>'"
