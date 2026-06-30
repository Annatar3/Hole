# Hole installer for Windows (PowerShell)
# Usage: irm hole.onl/get.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo    = "Annatar3/Hole"
$Asset   = "hole-win-x64.exe"
$InstDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$env:LOCALAPPDATA\hole" }
$BinPath = Join-Path $InstDir "hole.exe"

Write-Host ""
Write-Host "Hole installer"
Write-Host "--------------"
Write-Host "  Platform : Windows x64"
Write-Host "  Install  : $BinPath"
Write-Host ""

# Resolve latest release
$ApiUrl  = "https://api.github.com/repos/$Repo/releases/latest"
$Release = Invoke-RestMethod -Uri $ApiUrl -Headers @{ 'User-Agent' = 'hole-installer' }
$DownloadUrl = ($Release.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1).browser_download_url

if (-not $DownloadUrl) {
    Write-Error "Could not find asset '$Asset' in latest release. Check https://github.com/$Repo/releases"
    exit 1
}

Write-Host "  Version  : $($Release.tag_name)"
Write-Host ""

# Download
if (-not (Test-Path $InstDir)) { New-Item -ItemType Directory -Path $InstDir | Out-Null }
Invoke-WebRequest -Uri $DownloadUrl -OutFile $BinPath

Write-Host "OK  Installed to $BinPath"
Write-Host ""

# Check PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstDir", "User")
    Write-Host "Added $InstDir to your user PATH."
    Write-Host "Restart your terminal, then run:  hole help"
} else {
    Write-Host "Run:  hole help"
}

Write-Host ""
