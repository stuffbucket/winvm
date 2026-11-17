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
