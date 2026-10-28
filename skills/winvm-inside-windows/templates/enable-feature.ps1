<#
.SYNOPSIS
  Turn on a Windows optional feature or add a capability, once.

.DESCRIPTION
  Windows PowerShell 5.1, elevated (the in-guest agent and qemu-ga both are).
  Idempotent.

    winvm script -i NAME enable-feature.ps1 -- -Feature TelnetClient
    winvm script -i NAME enable-feature.ps1 -- -Capability 'OpenSSH.Client~~~~0.0.1.0'

  List names with
    winvm exec -i NAME -- powershell -NoProfile -Command "Get-WindowsOptionalFeature -Online | ft FeatureName,State"
    winvm exec -i NAME -- powershell -NoProfile -Command "Get-WindowsCapability -Online | ft Name,State"

  Capabilities come from Windows Update, which winvm images turn off; pass
  -Source (a mounted Features on Demand folder) if Add-WindowsCapability fails.

.PARAMETER Feature    An optional feature's FeatureName.
.PARAMETER Capability A capability's full Name.
.PARAMETER Source     Where to get a capability's files from (optional).

.NOTES
  Exit codes: 0 enabled or already enabled; 1 failed; 2 bad arguments;
  3010 enabled, Windows must restart to finish (`winvm reboot -i NAME`).
#>
[CmdletBinding()]
param(
  [string]$Feature,
  [string]$Capability,
  [string]$Source
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([int]$code, [string]$why) { Write-Output "enable-feature: FAILED: $why"; exit $code }

if ([bool]$Feature -eq [bool]$Capability) { Fail 2 'give -Feature or -Capability' }

try {
  if ($Feature) {
    $f = Get-WindowsOptionalFeature -Online -FeatureName $Feature
    if (-not $f) { Fail 1 "no optional feature named $Feature" }
    if ($f.State -eq 'Enabled') { Write-Output "enable-feature: $Feature already enabled"; exit 0 }
    if ($f.State -eq 'EnablePending') { Write-Output "enable-feature: $Feature is enabled once Windows restarts (winvm reboot)"; exit 3010 }
    $r = Enable-WindowsOptionalFeature -Online -FeatureName $Feature -All -NoRestart
    $state = (Get-WindowsOptionalFeature -Online -FeatureName $Feature).State
    if ($state -eq 'Enabled' -and -not $r.RestartNeeded) { Write-Output "enable-feature: enabled $Feature"; exit 0 }
    if ($state -in 'Enabled', 'EnablePending') { Write-Output "enable-feature: enabled $Feature; restart Windows to finish (winvm reboot)"; exit 3010 }
    Fail 1 "$Feature is $state after enabling"
  }

  $c = Get-WindowsCapability -Online -Name $Capability
  if (-not $c) { Fail 1 "no capability named $Capability" }
  if ($c.State -eq 'Installed') { Write-Output "enable-feature: $Capability already installed"; exit 0 }
  $params = @{ Online = $true; Name = $Capability }
  if ($Source) { $params['Source'] = $Source; $params['LimitAccess'] = $true }
  $r = Add-WindowsCapability @params
  $state = (Get-WindowsCapability -Online -Name $Capability).State
  if ($state -eq 'Installed' -and -not $r.RestartNeeded) { Write-Output "enable-feature: installed $Capability"; exit 0 }
  if ($state -in 'Installed', 'InstallPending') { Write-Output "enable-feature: installed $Capability; restart Windows to finish (winvm reboot)"; exit 3010 }
  Fail 1 "$Capability is $state after adding"
} catch {
  Fail 1 $_.Exception.Message
}
