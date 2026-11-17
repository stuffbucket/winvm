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

$out = & pnputil.exe /add-driver (Join-Path $Source "viofs.inf") /install 2>&1
Say "pnputil /add-driver /install exit $LASTEXITCODE"
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 259 -and $LASTEXITCODE -ne 3010) { throw "pnputil could not install viofs: $out" }
$dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'PCI\VEN_1AF4&DEV_105A*' }
Say "virtio-fs device: $(if ($dev) { "$($dev.Status) $($dev.InstanceId)" } else { 'absent' })"

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
& sc.exe failure VirtioFsSvc reset= 0 actions= restart/5000/restart/5000/restart/30000 | Out-Null
} else {
    $dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'PCI\VEN_1AF4&DEV_105A*' }
    if (-not (Get-Service "VirtioFsSvc" -ErrorAction SilentlyContinue)) { Say "not set up; nothing to move"; exit 0 }
    Stop-Service "VirtioFsSvc" -Force -ErrorAction SilentlyContinue
}

$key = "HKLM:\SOFTWARE\VirtIO-FS"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name MountPoint -Value "${Letter}:"
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
