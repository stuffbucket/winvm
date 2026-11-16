$ErrorActionPreference = "Continue"
$log = "C:\ProgramData\winvm\logon.log"
function Log([string] $m) { Add-Content -Path $log -Value "$(Get-Date -Format o) $env:USERNAME $m" }

function RegSet([string] $Path, [string] $Name, $Value, [string] $Type = "DWord") {
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

$startMenu = $null
try {
    $startMenu = Add-Type -PassThru -Namespace WinvmLogon -Name User -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr h, int attr, out int value, int size);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
} catch {
    Log "Start menu check unavailable: $($_.Exception.Message)"
}
function StartMenuOpen {
    if (-not $startMenu) { return $false }
    $h = $startMenu::GetForegroundWindow()
    $fgPid = [uint32]0
    [void]$startMenu::GetWindowThreadProcessId($h, [ref]$fgPid)
    $name = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).Name
    if ($name -notin "SearchHost", "StartMenuExperienceHost") { return $false }
    $cloaked = 0
    [void]$startMenu::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    return $cloaked -eq 0
}

$deadline = (Get-Date).AddMinutes(3)
$closed = 0
$startClosed = 0
try {
    $settingsDone = $false
    while ((Get-Date) -lt $deadline) {
        if ($startClosed -lt 3 -and (StartMenuOpen)) {
            $startMenu::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
            $startMenu::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
            $startClosed += 1
            Log "closed the Start menu"
            $later = (Get-Date).AddSeconds(10)
            if ($closed -gt 0 -and $later -gt $deadline) { $deadline = $later }
        }
        $sp = Get-Process -Name sysprep -ErrorAction SilentlyContinue
        if ($sp) {
            $sp | Stop-Process -Force -ErrorAction SilentlyContinue
            $closed += 1
            Log "closed the Sysprep dialog"
            $soon = (Get-Date).AddSeconds(20)
            if ($soon -lt $deadline) { $deadline = $soon }
        }
        if (-not $settingsDone) {
            $settingsDone = $true
            try {
                $cu = "HKCU:\Software\Microsoft\Windows\CurrentVersion"
                RegSet "HKCU:\Control Panel\Desktop" ScreenSaveActive "0" String
                RegSet "HKCU:\Control Panel\Desktop" ScreenSaverIsSecure "0" String
                foreach ($v in "SilentInstalledAppsEnabled", "SystemPaneSuggestionsEnabled", "SoftLandingEnabled",
                    "SubscribedContent-338388Enabled", "SubscribedContent-338389Enabled",
                    "SubscribedContent-310093Enabled", "SubscribedContent-353694Enabled") {
                    RegSet "$cu\ContentDeliveryManager" $v 0
                }
                RegSet "$cu\PushNotifications" ToastEnabled 0
                RegSet "HKCU:\Software\Policies\Microsoft\Windows\Explorer" DisableNotificationCenter 1
                RegSet "HKCU:\Software\Policies\Microsoft\Windows\Explorer" DisableSearchBoxSuggestions 1
                RegSet "$cu\Explorer\VisualEffects" VisualFXSetting 2
                RegSet "$cu\Themes\Personalize" EnableTransparency 0
                RegSet "$cu\Explorer\Advanced" TaskbarAnimations 0
                RegSet "HKCU:\Control Panel\Desktop\WindowMetrics" MinAnimate "0" String
                RegSet "HKCU:\Software\Microsoft\Windows\DWM" EnableAeroPeek 0
                Remove-ItemProperty "$cu\Run" -Name "OneDrive*" -ErrorAction SilentlyContinue
                $vfs = Get-ItemProperty "HKLM:\SOFTWARE\VirtIO-FS" -ErrorAction SilentlyContinue
                if ($vfs -and $vfs.MountPoint -and $vfs.WinvmLabel) {
                    RegSet "$cu\Explorer\MountPoints2\$($vfs.MountPoint.TrimEnd(':'))" _LabelFromReg $vfs.WinvmLabel String
                }
                Log "per-user settings applied"
            } catch {
                Log "per-user settings FAILED: $($_.Exception.Message)"
            }
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    Log "done (closed the Sysprep dialog $closed time(s), the Start menu $startClosed time(s))"
}
