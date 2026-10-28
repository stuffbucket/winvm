<#
.SYNOPSIS
  Install an .msi, .exe, .msix or .zip silently, once, and prove it worked.

.DESCRIPTION
  Windows PowerShell 5.1 (every winvm image has it). Idempotent: when the
  check already passes it changes nothing. Give at least one check.

  Run from the Mac:
    winvm script -i NAME install-package.ps1 -- -Url https://example.com/app.msi -ProductName 'App'
  Or as a step in an environment spec (winvm-build-environment).

.PARAMETER Path        Installer already in Windows (C:\...).
.PARAMETER Url         Download the installer first (curl.exe) into C:\winvm\downloads.
.PARAMETER Arguments   Extra installer arguments. Required for .exe: its silent switch
                       (NSIS /S, Inno /VERYSILENT /NORESTART, WiX/Burn /quiet /norestart).
                       .msi always gets /qn /norestart and a log in C:\winvm\logs.
.PARAMETER Destination Folder to expand a .zip into.
.PARAMETER TestPath    Installed if this file or folder exists.
.PARAMETER TestCommand Installed if this cmd.exe command line exits 0 (PATH is re-read first).
.PARAMETER ProductName Installed if an Apps & features entry's name contains this.

.NOTES
  Exit codes: 0 installed or already installed; 1 failed; 2 bad arguments;
  3010 installed but Windows must restart before the check passes
  (`winvm reboot -i NAME`, then run this again).
#>
[CmdletBinding()]
param(
  [string]$Path,
  [string]$Url,
  [string]$Arguments = '',
  [string]$Destination,
  [string]$TestPath,
  [string]$TestCommand,
  [string]$ProductName
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([int]$code, [string]$why) { Write-Output "install-package: FAILED: $why"; exit $code }

function Update-PathFromRegistry {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}

function Test-Installed {
  Update-PathFromRegistry
  if ($TestPath -and -not (Test-Path -LiteralPath $TestPath)) { return $false }
  if ($ProductName) {
    $roots = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
             'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
             'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    $hit = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
      Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like "*$ProductName*" }
    if (-not $hit) { return $false }
  }
  if ($TestCommand) {
    & cmd.exe /d /c $TestCommand 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { return $false }
  }
  return $true
}

if (-not ($TestPath -or $TestCommand -or $ProductName)) { Fail 2 'give a check: -TestPath, -TestCommand or -ProductName' }
if (-not ($Path -or $Url)) { Fail 2 'give -Path or -Url' }

try {
  if (Test-Installed) { Write-Output 'install-package: already installed'; exit 0 }

  if ($Url) {
    $dir = 'C:\winvm\downloads'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $name = [IO.Path]::GetFileName(([Uri]$Url).AbsolutePath)
    if (-not $name) { $name = 'download.bin' }
    if (-not $Path) { $Path = Join-Path $dir $name }
    Write-Output "install-package: downloading $Url"
    & curl.exe -fsSL --retry 3 -o $Path $Url
    if ($LASTEXITCODE -ne 0) { Fail 1 "download failed (curl exit $LASTEXITCODE)" }
  }
  if (-not (Test-Path -LiteralPath $Path)) { Fail 1 "no installer at $Path" }

  $logs = 'C:\winvm\logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
  $code = 0
  switch ($ext) {
    '.msi' {
      $log = Join-Path $logs ([IO.Path]::GetFileNameWithoutExtension($Path) + '.log')
      $argList = "/i `"$Path`" /qn /norestart /l*v `"$log`" $Arguments"
      $code = (Start-Process -FilePath msiexec.exe -ArgumentList $argList -Wait -PassThru).ExitCode
    }
    '.exe' {
      if (-not $Arguments) { Fail 2 'an .exe needs -Arguments with its silent switch, e.g. /S, /VERYSILENT or /quiet' }
      $code = (Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru).ExitCode
    }
    { $_ -in '.msix', '.msixbundle', '.appx', '.appxbundle' } { Add-AppxPackage -Path $Path }
    '.zip' {
      if (-not $Destination) { Fail 2 'a .zip needs -Destination' }
      Expand-Archive -LiteralPath $Path -DestinationPath $Destination -Force
    }
    default { Fail 2 "don't know how to install a $ext file" }
  }
  $reboot = $code -in 3010, 1641
  if ($code -ne 0 -and -not $reboot) { Fail 1 "installer exited $code" }

  if (Test-Installed) {
    if ($reboot) { Write-Output 'install-package: installed (Windows asks for a restart: winvm reboot)' }
    else { Write-Output 'install-package: installed' }
    exit 0
  }
  if ($reboot) { Write-Output 'install-package: installed; restart Windows (winvm reboot) and run this again to check'; exit 3010 }
  Fail 1 'the installer finished but the check does not pass'
} catch {
  Fail 1 $_.Exception.Message
}
