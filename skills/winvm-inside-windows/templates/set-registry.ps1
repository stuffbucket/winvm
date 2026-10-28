<#
.SYNOPSIS
  Set (or remove) one registry value, creating its key if needed, and read it back.

.DESCRIPTION
  Windows PowerShell 5.1. Idempotent.

    winvm script -i NAME set-registry.ps1 -- -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Type DWord -Value 1
    winvm script -i NAME set-registry.ps1 -- -Path 'HKCU:\Software\Contoso' -Name Theme -Remove

  HKCU is the logged-on Administrator's through the in-guest agent, and
  SYSTEM's through `--qga`.

.PARAMETER Path   A PowerShell registry path: HKLM:\..., HKCU:\...
.PARAMETER Name   The value's name.
.PARAMETER Value  The data, as text. DWord/QWord take decimal or 0x hex;
                  MultiString separates items with |; Binary is hex bytes ("01 ff" or "01ff").
.PARAMETER Type   String (default), ExpandString, DWord, QWord, MultiString or Binary.
.PARAMETER Remove Delete the value instead.

.NOTES
  Exit codes: 0 set, removed, or already so; 1 failed; 2 bad arguments.
#>
[CmdletBinding()]
param(
  [string]$Path,
  [string]$Name,
  [string]$Value,
  [ValidateSet('String', 'ExpandString', 'DWord', 'QWord', 'MultiString', 'Binary')][string]$Type = 'String',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

function Fail([int]$code, [string]$why) { Write-Output "set-registry: FAILED: $why"; exit $code }

if (-not $Path -or -not $Name) { Fail 2 'give -Path and -Name' }
if (-not $Remove -and $null -eq $Value) { Fail 2 'give -Value, or -Remove' }

function Convert-Data([string]$t, [string]$v) {
  switch ($t) {
    'DWord' { if ($v -match '^0x') { return [int][Convert]::ToUInt32($v.Substring(2), 16) } return [int]$v }
    'QWord' { if ($v -match '^0x') { return [long][Convert]::ToUInt64($v.Substring(2), 16) } return [long]$v }
    'MultiString' { return [string[]]($v -split '\|') }
    'Binary' { $h = $v -replace '[\s,]', ''; return [byte[]](0..($h.Length / 2 - 1) | ForEach-Object { [Convert]::ToByte($h.Substring($_ * 2, 2), 16) }) }
    default { return $v }
  }
}

function Same($a, $b) {
  if ($null -eq $a) { return $false }
  if ($a -is [array] -or $b -is [array]) { return (@($a) -join "`0") -ceq (@($b) -join "`0") }
  return "$a" -ceq "$b"
}

try {
  $exists = Test-Path -LiteralPath $Path
  $current = if ($exists) { (Get-Item -LiteralPath $Path).GetValue($Name, $null, 'DoNotExpandEnvironmentNames') } else { $null }

  if ($Remove) {
    if ($null -eq $current) { Write-Output "set-registry: $Name already absent"; exit 0 }
    Remove-ItemProperty -LiteralPath $Path -Name $Name
    if ($null -ne (Get-Item -LiteralPath $Path).GetValue($Name)) { Fail 1 "$Name is still there" }
    Write-Output "set-registry: removed $Name"
    exit 0
  }

  $data = Convert-Data $Type $Value
  $kindNow = if ($null -ne $current) { (Get-Item -LiteralPath $Path).GetValueKind($Name).ToString() } else { '' }
  if ((Same $current $data) -and $kindNow -eq $Type) { Write-Output "set-registry: $Name already set"; exit 0 }

  if (-not $exists) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -LiteralPath $Path -Name $Name -Value $data -PropertyType $Type -Force | Out-Null

  $after = (Get-Item -LiteralPath $Path).GetValue($Name, $null, 'DoNotExpandEnvironmentNames')
  if (-not (Same $after $data)) { Fail 1 "$Name did not read back as written" }
  Write-Output "set-registry: set $Path\$Name ($Type)"
  exit 0
} catch {
  Fail 1 $_.Exception.Message
}
