<#
.SYNOPSIS
  Set an environment variable, or add a folder to PATH, for good.

.DESCRIPTION
  Windows PowerShell 5.1. Idempotent. Writes the registry directly, so PATH
  keeps its %SystemRoot%-style entries unexpanded, then tells Windows the
  environment changed.

    winvm script -i NAME set-env.ps1 -- -Name JAVA_HOME -Value 'C:\jdk'
    winvm script -i NAME set-env.ps1 -- -AddToPath 'C:\tools\bin'

  Programs already running keep their old environment, and so do the
  commands the in-guest agent starts, which inherit the agent's (see
  the winvm-inside-windows skill). `winvm reboot` gives everything the new one.

.PARAMETER Name       Variable to set (with -Value).
.PARAMETER Value      Its value. Contains %VAR%? It is stored expandable.
.PARAMETER AddToPath  A folder to append to PATH, if PATH does not already have it.
.PARAMETER Scope      Machine (default) or User (the logged-on Administrator).

.NOTES
  Exit codes: 0 set or already set; 1 failed; 2 bad arguments.
#>
[CmdletBinding()]
param(
  [string]$Name,
  [string]$Value,
  [string]$AddToPath,
  [ValidateSet('Machine', 'User')][string]$Scope = 'Machine'
)
$ErrorActionPreference = 'Stop'

function Fail([int]$code, [string]$why) { Write-Output "set-env: FAILED: $why"; exit $code }

if ($AddToPath) {
  if ($Name -or $Value) { Fail 2 'give -AddToPath, or -Name and -Value, not both' }
  $Name = 'Path'
} elseif (-not $Name -or $null -eq $Value) {
  Fail 2 'give -Name and -Value, or -AddToPath'
}

try {
  $key = if ($Scope -eq 'Machine') {
    Get-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
  } else {
    Get-Item 'HKCU:\Environment'
  }
  $raw = { $key.GetValue($Name, $null, 'DoNotExpandEnvironmentNames') }
  $current = & $raw

  if ($AddToPath) {
    $norm = { param($p) $p.Trim().TrimEnd('\').ToLowerInvariant() }
    $want = & $norm $AddToPath
    $entries = @(if ($current) { $current -split ';' | Where-Object { $_.Trim() } })
    if ($entries | Where-Object { (& $norm $_) -eq $want }) { Write-Output "set-env: PATH already has $AddToPath"; exit 0 }
    $new = (@($entries) + $AddToPath) -join ';'
  } else {
    if ($current -ceq $Value) { Write-Output "set-env: $Name already set"; exit 0 }
    $new = $Value
  }

  $kind = if ($Name -eq 'Path' -or $new -match '%[^%]+%') { 'ExpandString' } else { 'String' }
  $path = if ($Scope -eq 'Machine') { 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' } else { 'HKCU:\Environment' }
  Set-ItemProperty -LiteralPath $path -Name $Name -Value $new -Type $kind

  # Tell Explorer and anything listening that the environment changed.
  if (-not ('WinvmEnv.Native' -as [type])) {
    Add-Type -Namespace WinvmEnv -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
  }
  $out = [UIntPtr]::Zero
  [void][WinvmEnv.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out)

  $key = Get-Item $path
  if ((& $raw) -cne $new) { Fail 1 "$Name did not read back as written" }
  if ($AddToPath) { Write-Output "set-env: added $AddToPath to the $Scope PATH" } else { Write-Output "set-env: set $Name ($Scope)" }
  exit 0
} catch {
  Fail 1 $_.Exception.Message
}
