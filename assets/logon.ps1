# Runs at EVERY logon of any user, from the HKLM Run key provision.ps1 sets,
# under `conhost --headless` so no window appears. Idempotent and quick.
#
# WHY A RUN KEY AND NOT A SCHEDULED TASK. This guest lives in audit mode, which
# keeps OOBEInProgress=1, and while that is set Task Scheduler runs nothing --
# a logon-triggered task simply never fires. HKLM\...\Run is processed by
# Explorer at every interactive logon, audit mode or not.
#
# WHY AT LOGON AT ALL. Two things cannot be done once, at build time:
#
#   1. Per-user settings live in HKCU, which belongs to whoever logs on.
#      provision.ps1 may run as SYSTEM (SetupComplete.cmd), whose HKCU is not
#      the desktop user's.
#   2. Audit mode opens the System Preparation Tool dialog at every logon. It
#      takes focus, and a stray Enter from anything driving the keyboard
#      ACCEPTS it -- the default action is "Enter System Out-of-Box
#      Experience (OOBE)", which drops the guest out of audit mode and into the
#      very OOBE the image exists to avoid. It is also just in the way of every
#      screenshot. It is closed here, as soon as it appears.
#   3. The Start menu opens by itself at an instance's first logon, around when
#      the Sysprep dialog goes. Harmless, but it covers every first screenshot
#      and takes the keyboard from whatever a GUI test types. Closed with Esc.
$ErrorActionPreference = "Continue"
$log = "C:\ProgramData\winvm\logon.log"
function Log([string] $m) { Add-Content -Path $log -Value "$(Get-Date -Format o) $env:USERNAME $m" }

function RegSet([string] $Path, [string] $Name, $Value, [string] $Type = "DWord") {
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

# THE START MENU IS OPEN when the foreground window belongs to its host and is
# not cloaked. Foreground alone is not enough: closed, it stays cloaked but
# keeps the foreground (DWMWA_CLOAKED = 14, measured: 2 closed, 0 open). Its
# host is SearchHost on current builds, StartMenuExperienceHost on older ones.
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

# --- 1. The Sysprep dialog, first: it is the one with a hazard attached ------
# It may open before or after this script starts, so watch for it -- for up to
# three minutes, but only twenty seconds past the first time it is closed (the
# Start menu tends to open around then), so the watching itself does not
# linger as background load.
$deadline = (Get-Date).AddMinutes(3)
$closed = 0
$startClosed = 0
try {
    $settingsDone = $false
    while ((Get-Date) -lt $deadline) {
        # Esc, key down and up, only while it is open: never a key into
        # anything else on the desktop.
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
        # --- 2. Per-user settings, once, between the first two checks -------
        if (-not $settingsDone) {
            $settingsDone = $true
            try {
                $cu = "HKCU:\Software\Microsoft\Windows\CurrentVersion"
                # Screen saver off: audit mode's Administrator cannot log back on
                # past a secure screen saver.
                RegSet "HKCU:\Control Panel\Desktop" ScreenSaveActive "0" String
                RegSet "HKCU:\Control Panel\Desktop" ScreenSaverIsSecure "0" String
                # Suggestions, silent app installs, tips.
                foreach ($v in "SilentInstalledAppsEnabled", "SystemPaneSuggestionsEnabled", "SoftLandingEnabled",
                    "SubscribedContent-338388Enabled", "SubscribedContent-338389Enabled",
                    "SubscribedContent-310093Enabled", "SubscribedContent-353694Enabled") {
                    RegSet "$cu\ContentDeliveryManager" $v 0
                }
                # Toasts and the notification centre.
                RegSet "$cu\PushNotifications" ToastEnabled 0
                RegSet "HKCU:\Software\Policies\Microsoft\Windows\Explorer" DisableNotificationCenter 1
                # No web results in Start search.
                RegSet "HKCU:\Software\Policies\Microsoft\Windows\Explorer" DisableSearchBoxSuggestions 1
                # Visual effects: best performance. Animation costs CPU under
                # emulation and makes screenshots depend on timing.
                RegSet "$cu\Explorer\VisualEffects" VisualFXSetting 2
                RegSet "$cu\Themes\Personalize" EnableTransparency 0
                RegSet "$cu\Explorer\Advanced" TaskbarAnimations 0
                RegSet "HKCU:\Control Panel\Desktop\WindowMetrics" MinAnimate "0" String
                RegSet "HKCU:\Software\Microsoft\Windows\DWM" EnableAeroPeek 0
                # OneDrive's per-user autostart.
                Remove-ItemProperty "$cu\Run" -Name "OneDrive*" -ErrorAction SilentlyContinue
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
