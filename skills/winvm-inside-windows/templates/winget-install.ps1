<#
.SYNOPSIS
  Install a package with winget when Windows has it, else from a fallback installer.

.DESCRIPTION
  Windows PowerShell 5.1. Idempotent. winget is often missing on winvm
  images (audit mode never registers App Installer), so give a fallback
  whenever you can; it goes through install-package.ps1, which must sit in
  the same folder (`winvm script` and environment specs put both there).

    winvm put -i NAME install-package.ps1 'C:\winvm\scripts\install-package.ps1'
    winvm script -i NAME winget-install.ps1 -- -Id Git.Git -TestCommand 'git --version' `
      -FallbackUrl https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-arm64.exe `
      -FallbackArguments '/VERYSILENT /NORESTART'

.PARAMETER Id                 The winget package id (exact match).
.PARAMETER Version            A specific version (optional).
.PARAMETER FallbackUrl        An installer to use when winget is missing or fails.
.PARAMETER FallbackArguments  Its silent switches (see install-package.ps1).
.PARAMETER TestPath           Checks, as in install-package.ps1. Without one,
.PARAMETER TestCommand        `winget list --id` is the check, and the fallback
.PARAMETER ProductName        cannot be used.

.NOTES
  Exit codes: 0 installed or already installed; 1 failed; 2 bad arguments;
  3010 installed, restart needed (`winvm reboot`, then run this again).
#>
[CmdletBinding()]
param(
  [string]$Id,
  [string]$Version,
  [string]$FallbackUrl,
  [string]$FallbackArguments = '',
  [string]$TestPath,
  [string]$TestCommand,
  [string]$ProductName
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([int]$code, [string]$why) { Write-Output "winget-install: FAILED: $why"; exit $code }

if (-not $Id) { Fail 2 'give -Id' }
$hasCheck = [bool]($TestPath -or $TestCommand -or $ProductName)
if ($FallbackUrl -and -not $hasCheck) { Fail 2 'a fallback needs a check: -TestPath, -TestCommand or -ProductName' }

function Find-Winget {
  $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $p = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path -LiteralPath $p) { return $p }
  return $null
}

function Invoke-Fallback([string]$why) {
  if (-not $FallbackUrl) { Fail 1 "$why, and there is no -FallbackUrl" }
  Write-Output "winget-install: $why; using the fallback installer"
  $script = Join-Path $PSScriptRoot 'install-package.ps1'
  if (-not (Test-Path -LiteralPath $script)) { Fail 1 "install-package.ps1 is not next to this script ($PSScriptRoot)" }
  $a = @{ Url = $FallbackUrl; Arguments = $FallbackArguments }
  if ($TestPath) { $a['TestPath'] = $TestPath }
  if ($TestCommand) { $a['TestCommand'] = $TestCommand }
  if ($ProductName) { $a['ProductName'] = $ProductName }
  & $script @a
  exit $LASTEXITCODE
}

try {
  $winget = Find-Winget
  if (-not $winget) { Invoke-Fallback 'winget is not available' }

  $agree = '--accept-source-agreements', '--disable-interactivity'
  & $winget list --id $Id --exact @agree | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Output "winget-install: $Id already installed"; exit 0 }

  $install = @('install', '--id', $Id, '--exact', '--silent', '--accept-package-agreements') + $agree
  if ($Version) { $install += '--version', $Version }
  & $winget @install
  $code = $LASTEXITCODE
  if ($code -ne 0) { Invoke-Fallback "winget install exited $code" }

  & $winget list --id $Id --exact @agree | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 1 "winget installed $Id but does not list it" }
  Write-Output "winget-install: installed $Id"
  exit 0
} catch {
  Fail 1 $_.Exception.Message
}
