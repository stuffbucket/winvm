# Microsoft Defender exclusions for the directories winvm and its harnesses
# work in. Run once by provision.ps1, as its own process.
#
# A SEPARATE SCRIPT, AND IT MUST STAY ONE. AMSI scans a script's whole text
# before running it, and Tamper Protection treats anything that reconfigures
# Defender as suspect: a script mentioning Set-MpPreference/Add-MpPreference is
# liable to be blocked outright. Inside provision.ps1 that would fail ALL of
# provisioning; here it can only cost the exclusions.
#
# Exclusions only. Turning Defender off is not attempted: Tamper Protection
# reverts it, and a fixture should look like a normal Windows machine anyway.
# What matters for test timings is that Defender does not scan every file a
# build or test run writes, and these paths are where that happens:
#
#   C:\work               scratch workspaces for tests (created here)
#   C:\payload            whatever the caller staged at build time
#   C:\ProgramData\winvm  winvm's own guest-side files
$ErrorActionPreference = "Continue"
$paths = "C:\work", "C:\payload", "C:\ProgramData\winvm"
$processes = "bun.exe", "node.exe"
foreach ($p in $paths) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
try {
    Add-MpPreference -ExclusionPath $paths -ExclusionProcess $processes -ErrorAction Stop
    Write-Output "defender: excluded $($paths -join ', ') and processes $($processes -join ', ')"
} catch {
    Write-Output "defender: WARNING could not add exclusions: $($_.Exception.Message)"
}
