param(
    [string]$Source = $PSScriptRoot,
    [string]$Dest = "C:\ProgramData\winvm\agent",
    [string]$BunUrl = "",
    [int]$Port = 7801,
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$bun = Join-Path $Dest "bun.exe"
$ris = Join-Path $Dest "runinsession.exe"

$helpers = @("winvm-ui.exe", "conpty.exe", "winvm-display.exe") | ForEach-Object { Join-Path $Dest $_ }
$running = @(Get-Process bun, winvm-ui, conpty, winvm-display -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $bun -or $helpers -contains $_.Path })
if ($running.Count -gt 0) {
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Write-Output "stopped agent pid $($running.Id -join ',')"
}
$held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($held) { Write-Output "WARNING: port $Port is still held (a process an old agent started inherited it); end that process or restart the guest" }

$found = @((Join-Path $Source "bun.exe"), "C:\payload\bun-windows-aarch64\bun.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($found) {
    $src = Get-Item $found
    $have = Get-Item $bun -ErrorAction SilentlyContinue
    if (-not $have -or $have.Length -ne $src.Length -or $have.LastWriteTimeUtc -ne $src.LastWriteTimeUtc) {
        Copy-Item $found $bun -Force
        Write-Output "bun: copied from $found"
    }
} elseif (-not (Test-Path $bun)) {
    if ($BunUrl -eq "") { Write-Output "need-bun"; exit 3 }
    $zip = Join-Path $env:TEMP "winvm-bun.zip"
    $x = Join-Path $env:TEMP "winvm-bun"
    Invoke-WebRequest $BunUrl -OutFile $zip -UseBasicParsing
    Remove-Item $x -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zip $x -Force
    Copy-Item (Get-ChildItem $x -Recurse -Filter bun.exe | Select-Object -First 1).FullName $bun -Force
    Remove-Item $zip, $x -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "bun: downloaded from the host"
}

Copy-Item (Join-Path $Source "guestagent.ts") (Join-Path $Dest "guestagent.ts") -Force
$token = Join-Path $Dest "token"
if (Test-Path $token) { icacls $token /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Null }

$cs = Join-Path $Source "runinsession.cs"
if (Test-Path $cs) {
    $sum = (Get-FileHash $cs -Algorithm SHA256).Hash
    $stamp = Join-Path $Dest "runinsession.sha256"
    if (-not (Test-Path $ris) -or -not (Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $sum) {
        Remove-Item $ris -Force -ErrorAction SilentlyContinue
        Add-Type -TypeDefinition (Get-Content $cs -Raw) -OutputAssembly $ris -OutputType ConsoleApplication
        Set-Content $stamp $sum
        Write-Output "runinsession: compiled"
    }
}

$cs = Join-Path $Source "winvm-ui.cs"
if (Test-Path $cs) {
    $exe = Join-Path $Dest "winvm-ui.exe"
    $sum = (Get-FileHash $cs -Algorithm SHA256).Hash
    $stamp = Join-Path $Dest "winvm-ui.sha256"
    if (-not (Test-Path $exe) -or -not (Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $sum) {
        Remove-Item $exe -Force -ErrorAction SilentlyContinue
        $refs = @("UIAutomationClient", "UIAutomationTypes", "WindowsBase", "System.Web.Extensions") |
            ForEach-Object { [Reflection.Assembly]::LoadWithPartialName($_).Location }
        Add-Type -TypeDefinition (Get-Content $cs -Raw) -ReferencedAssemblies ($refs + "System.Core") -OutputAssembly $exe -OutputType ConsoleApplication
        Set-Content $stamp $sum
        Write-Output "winvm-ui: compiled"
    }
}

$cs = Join-Path $Source "conpty.cs"
if (Test-Path $cs) {
    $exe = Join-Path $Dest "conpty.exe"
    $sum = (Get-FileHash $cs -Algorithm SHA256).Hash
    $stamp = Join-Path $Dest "conpty.sha256"
    if (-not (Test-Path $exe) -or -not (Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $sum) {
        Remove-Item $exe -Force -ErrorAction SilentlyContinue
        Add-Type -TypeDefinition (Get-Content $cs -Raw) -OutputAssembly $exe -OutputType ConsoleApplication
        Set-Content $stamp $sum
        Write-Output "conpty: compiled"
    }
}

$cs = Join-Path $Source "winvm-display.cs"
if (Test-Path $cs) {
    $exe = Join-Path $Dest "winvm-display.exe"
    $sum = (Get-FileHash $cs -Algorithm SHA256).Hash
    $stamp = Join-Path $Dest "winvm-display.sha256"
    if (-not (Test-Path $exe) -or -not (Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $sum) {
        Remove-Item $exe -Force -ErrorAction SilentlyContinue
        Add-Type -TypeDefinition (Get-Content $cs -Raw) -OutputAssembly $exe -OutputType ConsoleApplication
        Set-Content $stamp $sum
        Write-Output "winvm-display: compiled"
    }
}

$powerFailed = @()
try {
    powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 3 | Out-Null
    if ($LASTEXITCODE -ne 0) { $powerFailed += "setacvalueindex" }
    powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 3 | Out-Null
    if ($LASTEXITCODE -ne 0) { $powerFailed += "setdcvalueindex" }
    powercfg.exe /setactive SCHEME_CURRENT | Out-Null
    if ($LASTEXITCODE -ne 0) { $powerFailed += "setactive" }
} catch {
    $powerFailed += "($($_.Exception.Message))"
}
if ($powerFailed.Count -gt 0) { Write-Output "WARNING: could not make the power button shut Windows down (powercfg $($powerFailed -join ', ') failed); winvm stop will need the guest agent" }

netsh advfirewall firewall delete rule name=winvm-agent 2>&1 | Out-Null
netsh advfirewall firewall add rule name=winvm-agent dir=in action=allow protocol=TCP localport=$Port remoteip=10.0.2.2 program="$bun" | Out-Null
netsh advfirewall set allprofiles settings inboundusernotification disable | Out-Null

$argv = @("C:\Windows\System32\conhost.exe", "--headless", $bun, (Join-Path $Dest "guestagent.ts"), "--supervise",
    "--port", "$Port", "--token-file", $token, "--allow-from", "10.0.2.2,127.0.0.1",
    "--log", (Join-Path $Dest "agent.log"), "--close-sysprep")
$line = ($argv | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join " "
Set-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name "winvm-agent" -Value $line

if (-not $NoStart) {
    $desk = Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 } | Select-Object -First 1
    if (-not $desk) {
        Write-Output "no one is logged on; the agent starts at the next logon"
    } elseif (Test-Path $ris) {
        & $ris --hidden @argv
        Write-Output "started in session $($desk.SessionId)"
    } else {
        Write-Output "no runinsession.exe; the agent starts at the next logon"
    }
}
Write-Output "installed"
