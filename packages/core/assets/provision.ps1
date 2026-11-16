$ErrorActionPreference = "Stop"

$Done = "C:\winvm-provisioned.txt"
if (Test-Path $Done) {
    Write-Output "already provisioned on $(Get-Content $Done -Raw); nothing to do"
    exit 0
}

function Find-VolumeContaining {
    param([Parameter(Mandatory = $true)][string] $RelativePath)
    foreach ($name in (Get-PSDrive -PSProvider FileSystem).Name) {
        if (Test-Path "${name}:\$RelativePath") { return "${name}:" }
    }
    return $null
}

$seed = Find-VolumeContaining -RelativePath "provision.ps1"

$resultVolume = Get-Volume | Where-Object { $_.FileSystemLabel -eq "MAXRESULT" } | Select-Object -First 1
if (-not $resultVolume) { throw "result volume MAXRESULT not found" }
$resultDir = "$($resultVolume.DriveLetter):\"

Start-Transcript -Path "$resultDir\provision.log" -Force | Out-Null

function Write-Result {
    param([string] $Name, [string] $Content)
    Set-Content -Path "$resultDir\$Name" -Value $Content -Encoding UTF8 -NoNewline
}

try {
    Write-Output "seed=$seed result=$resultDir arch=$env:PROCESSOR_ARCHITECTURE"

    $tools = Find-VolumeContaining -RelativePath "Drivers\vioserial\w11\ARM64\vioser.inf"
    if ($tools) {
        $installer = Get-ChildItem -Path "$tools\utm-guest-tools-*.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($installer) {
            Write-Output "installing $($installer.Name)"
            $p = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
            Write-Output "guest tools exit: $($p.ExitCode)"
        } else {
            Write-Output "WARNING: guest tools installer not found on $tools"
        }
    } else {
        Write-Output "WARNING: guest tools volume not found - no agent and no network"
    }

    $payloadRoot = "C:\payload"
    New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

    $payloadSource = $null
    foreach ($name in (Get-PSDrive -PSProvider FileSystem).Name) {
        $candidate = "${name}:\payload"
        if ($candidate -eq $payloadRoot) { continue }
        if ((Test-Path $candidate) -and (Get-ChildItem $candidate -ErrorAction SilentlyContinue)) {
            $payloadSource = $candidate
            break
        }
    }
    Write-Output "payload source: $(if ($payloadSource) { $payloadSource } else { '(none found)' })"

    $staged = @()
    if ($payloadSource) {
        foreach ($zip in Get-ChildItem -Path "$payloadSource\*.zip" -ErrorAction SilentlyContinue) {
            Write-Output "expanding $($zip.Name)"
            Expand-Archive -Path $zip.FullName -DestinationPath $payloadRoot -Force
            $staged += $zip.Name
        }
        foreach ($item in Get-ChildItem -Path $payloadSource -Exclude *.zip -ErrorAction SilentlyContinue) {
            Copy-Item -Path $item.FullName -Destination $payloadRoot -Recurse -Force
        }
    }
    Write-Result -Name "payload.txt" -Content ($staged -join "`n")

    $binDirs = Get-ChildItem -Path $payloadRoot -Recurse -Filter *.exe -ErrorAction SilentlyContinue |
        ForEach-Object { $_.DirectoryName } | Sort-Object -Unique
    if ($binDirs) {
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        foreach ($d in $binDirs) {
            if ($machinePath -notlike "*$d*") { $machinePath = "$machinePath;$d" }
        }
        [Environment]::SetEnvironmentVariable("Path", $machinePath, "Machine")
        Write-Output "PATH += $($binDirs -join '; ')"
    }

    $setup = Join-Path $payloadRoot "setup.ps1"
    if (Test-Path $setup) {
        Write-Output "running payload setup.ps1"
        & $setup
    }

    $extras = Find-VolumeContaining -RelativePath "winvm\PowerShell-win-arm64.msi"
    if ($extras) {
        $msi = "$extras\winvm\PowerShell-win-arm64.msi"
        $msiArgs = "/i `"$msi`" /qn /norestart ADD_PATH=1 REGISTER_MANIFEST=1 ENABLE_PSREMOTING=0 " +
            "USE_MU=0 ENABLE_MU=0 DISABLE_TELEMETRY=1"
        $p = Start-Process -FilePath msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
        Write-Output "PowerShell 7 msiexec exit: $($p.ExitCode)"
        [Environment]::SetEnvironmentVariable("POWERSHELL_UPDATECHECK", "Off", "Machine")
        [Environment]::SetEnvironmentVariable("POWERSHELL_TELEMETRY_OPTOUT", "1", "Machine")
        $pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
        Write-Result -Name "pwsh.txt" -Content $(if (Test-Path $pwsh) { "ok" } else { "no" })
    } else {
        Write-Output "WARNING: no winvm\PowerShell-win-arm64.msi on any volume - no PowerShell 7"
    }

    function Step([string] $Name, [scriptblock] $Body) {
        try { & $Body 2>&1 | Out-Null; Write-Output "quiet: ok   $Name" }
        catch { Write-Output "quiet: FAIL $Name : $($_.Exception.Message)" }
    }
    function RegSet([string] $Path, [string] $Name, $Value, [string] $Type = "DWord") {
        if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
        New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
    }
    function SvcOff([string] $Name) {
        Stop-Service $Name -Force -ErrorAction SilentlyContinue
        try { Set-Service $Name -StartupType Disabled -ErrorAction Stop }
        catch { RegSet "HKLM:\SYSTEM\CurrentControlSet\Services\$Name" Start 4 }
    }
    $pol = "HKLM:\SOFTWARE\Policies\Microsoft"
    Step "Windows Update off" {
        RegSet "$pol\Windows\WindowsUpdate\AU" NoAutoUpdate 1
        RegSet "$pol\Windows\WindowsUpdate" DisableWindowsUpdateAccess 1
        RegSet "$pol\Windows\WindowsUpdate" ExcludeWUDriversInQualityUpdate 1
        SvcOff wuauserv; SvcOff UsoSvc
    }
    Step "WaaSMedicSvc off" { SvcOff WaaSMedicSvc }
    Step "Delivery Optimization off" { RegSet "$pol\Windows\DeliveryOptimization" DODownloadMode 0; SvcOff DoSvc }
    Step "Search indexing off" { SvcOff WSearch }
    Step "SysMain off" { SvcOff SysMain }
    Step "telemetry off" {
        RegSet "$pol\Windows\DataCollection" AllowTelemetry 0
        foreach ($s in "DiagTrack", "dmwappushservice", "MapsBroker", "WerSvc", "PcaSvc") { SvcOff $s }
    }
    Step "automatic maintenance off" {
        RegSet "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\Maintenance" MaintenanceDisabled 1
    }
    Step "Store auto-update, consumer features, tips off" {
        RegSet "$pol\WindowsStore" AutoDownload 2
        RegSet "$pol\Windows\CloudContent" DisableWindowsConsumerFeatures 1
        RegSet "$pol\Windows\CloudContent" DisableSoftLanding 1
        RegSet "$pol\Windows\CloudContent" DisableCloudOptimizedContent 1
    }
    Step "Edge first run, background, updates off" {
        RegSet "$pol\Edge" HideFirstRunExperience 1
        RegSet "$pol\Edge" StartupBoostEnabled 0
        RegSet "$pol\Edge" BackgroundModeEnabled 0
        RegSet "$pol\EdgeUpdate" UpdateDefault 0
        RegSet "$pol\EdgeUpdate" AutoUpdateCheckPeriodMinutes 0
        foreach ($s in "edgeupdate", "edgeupdatem") { SvcOff $s }
    }
    Step "OneDrive off" { RegSet "$pol\Windows\OneDrive" DisableFileSyncNGSC 1 }
    Step "security notifications off" {
        RegSet "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.SystemToast.SecurityAndMaintenance" Enabled 0
        RegSet "$pol\Windows Defender Security Center\Notifications" DisableNotifications 1
    }
    Step "Widgets off" { RegSet "$pol\Dsh" AllowNewsAndInterests 0 }
    Step "no lock screen" { RegSet "$pol\Windows\Personalization" NoLockScreen 1 }
    Step "power: high performance, never sleep" {
        powercfg.exe /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
        powercfg.exe /change hibernate-timeout-ac 0
    }
    Step "power button: shut down" {
        powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 3
        if ($LASTEXITCODE -ne 0) { throw "powercfg setacvalueindex exit $LASTEXITCODE" }
        powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 3
        if ($LASTEXITCODE -ne 0) { throw "powercfg setdcvalueindex exit $LASTEXITCODE" }
        powercfg.exe /setactive SCHEME_CURRENT
        if ($LASTEXITCODE -ne 0) { throw "powercfg setactive exit $LASTEXITCODE" }
    }
    Step "boot: no recovery environment after a failed boot" {
        bcdedit.exe /set "{default}" recoveryenabled No
        if ($LASTEXITCODE -ne 0) { throw "bcdedit recoveryenabled exit $LASTEXITCODE" }
        bcdedit.exe /set "{default}" bootstatuspolicy IgnoreAllFailures
        if ($LASTEXITCODE -ne 0) { throw "bcdedit bootstatuspolicy exit $LASTEXITCODE" }
    }
    Step "NTFS: no last-access updates, no 8.3 names" {
        fsutil.exe behavior set disablelastaccess 1
        fsutil.exe 8dot3name set C: 1
    }

    $extras = Find-VolumeContaining -RelativePath "winvm\defender.ps1"
    if ($extras) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$extras\winvm\defender.ps1"
        Write-Output "defender.ps1 exit: $LASTEXITCODE"
    } else {
        Write-Output "WARNING: no winvm\defender.ps1 on any volume - no Defender exclusions"
    }

    $extras = Find-VolumeContaining -RelativePath "winvm\logon.ps1"
    if ($extras) {
        $winvmDir = "C:\ProgramData\winvm"
        New-Item -ItemType Directory -Force -Path $winvmDir | Out-Null
        Copy-Item -Path "$extras\winvm\logon.ps1" -Destination "$winvmDir\logon.ps1" -Force
        $ps51 = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name "winvm-logon" `
            -Value "C:\Windows\System32\conhost.exe --headless $ps51 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $winvmDir\logon.ps1"
        Write-Output "logon task installed: $winvmDir\logon.ps1 (HKLM Run winvm-logon)"
    } else {
        Write-Output "WARNING: no winvm\logon.ps1 on any volume - the Sysprep dialog will stay open"
    }

    $extras = Find-VolumeContaining -RelativePath "winvm\agent-install.ps1"
    if ($extras) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$extras\winvm\agent-install.ps1" -Source "$extras\winvm" -NoStart
        Write-Output "agent-install.ps1 exit: $LASTEXITCODE"
        Get-ChildItem "C:\ProgramData\winvm\agent" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.IsReadOnly = $false }
    } else {
        Write-Output "WARNING: no winvm\agent-install.ps1 on any volume - the agent installs on first use"
    }

    $extras = Find-VolumeContaining -RelativePath "winvm\viofs\viofs-install.ps1"
    if ($extras) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$extras\winvm\viofs\viofs-install.ps1" -Source "$extras\winvm\viofs"
        Write-Output "viofs-install.ps1 exit: $LASTEXITCODE"
        Write-Result -Name "viofs.txt" -Content $(if ($LASTEXITCODE -eq 0) { "ok" } else { "failed" })
    } else {
        Write-Output "no winvm\viofs on any volume - no shared folder in this image (winvm share install adds it)"
    }

    foreach ($fw in "Framework64", "FrameworkArm64") {
        $ngen = "C:\Windows\Microsoft.NET\$fw\v4.0.30319\ngen.exe"
        if (-not (Test-Path $ngen)) { Write-Output "ngen: no $fw"; continue }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $ngen executeQueuedItems /nologo /silent | Out-Null
        Write-Output "ngen $fw executeQueuedItems: exit $LASTEXITCODE in $([int]$sw.Elapsed.TotalSeconds)s"
    }

    $viostor = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\viostor" -ErrorAction SilentlyContinue
    if ($viostor -and $viostor.Start -eq 0) {
        Write-Output "viostor is boot-start: this image can boot on virtio-blk"
        Write-Result -Name "virtio.txt" -Content "ok"
    } else {
        $state = if ($viostor) { "Start=$($viostor.Start)" } else { "service absent" }
        Write-Output "WARNING: viostor is not boot-start ($state) - no live snapshots"
        Write-Result -Name "virtio.txt" -Content "no"
    }

    # <https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/boot-windows-to-audit-mode-or-oobe>
    reg.exe add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f | Out-Null
    reg.exe add "HKCU\Control Panel\Desktop" /v ScreenSaverIsSecure /t REG_SZ /d 0 /f | Out-Null
    powercfg.exe /change monitor-timeout-ac 0
    powercfg.exe /change standby-timeout-ac 0
    powercfg.exe -h off

    Set-Content -Path $Done -Value (Get-Date -Format o) -Encoding UTF8
    Write-Result -Name "status.txt" -Content "ok"
    Write-Output "PROVISION OK"
} catch {
    Write-Output "PROVISION FAILED: $_"
    Write-Result -Name "status.txt" -Content "failed: $_"
} finally {
    Stop-Transcript | Out-Null
}
# <https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup>
