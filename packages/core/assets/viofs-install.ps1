# The Windows side of winvm's shared folder: viofs (the virtio-fs driver and
# its service) and WinFsp, from files the host staged in -Source.
#
# Runs as an administrator, either from provision.ps1 while an image is built
# or from `winvm share install` on an existing machine. Idempotent.
#
# ONLY ON RAMFB. The host runs this where the virtio-fs device is present but
# the virtio-gpu display is not: a build (always ramfb), or a machine started
# on ramfb for the purpose. Windows binds viofs to the device here, with no
# virtio-gpu driver running. Binding it with the virtio-gpu display active
# bugchecked the guest (0x7E in viogpudo.sys+0x1180), live or at the next
# boot alike; once bound, later boots on virtio-gpu find the device already
# installed (QEMU keeps it in the same PCI slot) and start normally.
#
#   -Source  folder holding viofs.inf, viofs.sys, viofs.cat, virtiofs.exe and winfsp.msi
#   -Letter  drive letter for the shared folder (default Z)
#   -Label   what Explorer calls the drive (default Mac)
#   -LetterOnly  only move the drive to -Letter (a guest that already has it)
param(
    [string] $Source = "",
    [string] $Letter = "Z",
    [string] $Label = "Mac",
    [switch] $LetterOnly
)
$ErrorActionPreference = "Stop"
$Letter = $Letter.TrimEnd(":").ToUpper()

function Say([string] $m) { Write-Output "viofs-install: $m" }

if (-not $LetterOnly) {
foreach ($f in "viofs.inf", "viofs.sys", "viofs.cat", "virtiofs.exe", "winfsp.msi") {
    if (-not (Test-Path (Join-Path $Source $f))) { throw "missing $f in $Source" }
}

# --- WinFsp: the user-mode file system layer virtiofs.exe runs on -----------
# Its launcher service is a dependency of VirtioFsSvc.
if (-not (Get-Service "WinFsp.Launcher" -ErrorAction SilentlyContinue)) {
    $log = Join-Path $env:TEMP "winvm-winfsp.log"
    $p = Start-Process msiexec.exe -ArgumentList "/i", "`"$(Join-Path $Source 'winfsp.msi')`"", "/qn", "/norestart", "/l*v", "`"$log`"" -Wait -PassThru
    Say "WinFsp msiexec exit $($p.ExitCode)"
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "WinFsp did not install (msiexec $($p.ExitCode), see $log)" }
} else {
    Say "WinFsp already installed"
}
$winfspDir = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\WinFsp" -ErrorAction SilentlyContinue).InstallDir
if (-not $winfspDir) { $winfspDir = "C:\Program Files (x86)\WinFsp\" }
$winfspDll = Join-Path $winfspDir "bin\winfsp-a64.dll"
if (-not (Test-Path $winfspDll)) { throw "WinFsp is installed but $winfspDll is missing" }

# --- viofs: into the driver store, and onto the device ----------------------
$out = & pnputil.exe /add-driver (Join-Path $Source "viofs.inf") /install 2>&1
Say "pnputil /add-driver /install exit $LASTEXITCODE"
# 0 added and installed; 259 (ERROR_NO_MORE_ITEMS) nothing new; 3010 a restart wanted.
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 259 -and $LASTEXITCODE -ne 3010) { throw "pnputil could not install viofs: $out" }
$dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'PCI\VEN_1AF4&DEV_105A*' }
Say "virtio-fs device: $(if ($dev) { "$($dev.Status) $($dev.InstanceId)" } else { 'absent' })"

# --- VirtioFsSvc: virtiofs.exe as a service -------------------------------
# virtiofs.exe finds winfsp-a64.dll beside itself: WinFsp's own lookup reads
# the 64-bit registry view, where an ARM64 WinFsp has no InstallDir.
$dir = "C:\Program Files\VirtIO-FS"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$svc = Get-Service "VirtioFsSvc" -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") { Stop-Service "VirtioFsSvc" -Force }
Copy-Item (Join-Path $Source "virtiofs.exe") (Join-Path $dir "virtiofs.exe") -Force
Copy-Item $winfspDll (Join-Path $dir "winfsp-a64.dll") -Force
if (-not $svc) {
    & sc.exe create VirtioFsSvc binPath= "`"$dir\virtiofs.exe`"" start= auto depend= "VirtioFsDrv/WinFsp.Launcher" DisplayName= "Virtio FS Service" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create VirtioFsSvc exit $LASTEXITCODE" }
    & sc.exe description VirtioFsSvc "winvm: the Mac's shared folder, as drive ${Letter}:" | Out-Null
}
# Restart it after a failure: the device can appear after the service starts.
& sc.exe failure VirtioFsSvc reset= 0 actions= restart/5000/restart/5000/restart/30000 | Out-Null
} else {
    $dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'PCI\VEN_1AF4&DEV_105A*' }
    if (-not (Get-Service "VirtioFsSvc" -ErrorAction SilentlyContinue)) { Say "not set up; nothing to move"; exit 0 }
    Stop-Service "VirtioFsSvc" -Force -ErrorAction SilentlyContinue
}

# --- The drive letter and its name ------------------------------------------
$key = "HKLM:\SOFTWARE\VirtIO-FS"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name MountPoint -Value "${Letter}:"
# The volume's own label is the virtio-fs tag (viofs reports it, and offers no
# way to set another). Explorer shows a per-user name from MountPoints2
# instead; DriveIcons\<letter>\DefaultLabel does not override a volume label.
# Recorded here for logon.ps1, which sets it for whoever logs on; set now for
# this user when this runs in a session (not as SYSTEM, at a build).
Set-ItemProperty -Path $key -Name WinvmLabel -Value $Label
if (-not [Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
    $mp2 = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2"
    Get-ChildItem $mp2 -ErrorAction SilentlyContinue | Where-Object {
        $_.PSChildName.Length -eq 1 -and (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue)._LabelFromReg -eq $Label
    } | ForEach-Object { Remove-Item $_.PSPath -Recurse -Force }
    New-Item -Path "$mp2\$Letter" -Force | Out-Null
    Set-ItemProperty -Path "$mp2\$Letter" -Name _LabelFromReg -Value $Label
}

if ($dev -and $dev.Status -eq "OK") {
    Start-Service "VirtioFsSvc" -ErrorAction SilentlyContinue
    Say "VirtioFsSvc $((Get-Service VirtioFsSvc).Status)"
}
Say "ok: ${Letter}: ($Label)"
