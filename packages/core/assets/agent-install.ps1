# Install (or reinstall) winvm's in-guest agent. Idempotent.
#
# Two callers, one script:
#   - at runtime, from the host over qemu-ga (agent.ts `install`), which stages
#     this script, guestagent.ts and runinsession.cs in -Source and writes the
#     instance's token to <Dest>\token itself;
#   - when baking an image (provisioning), with -NoStart. No token is written
#     then: the agent refuses every request until the host writes one.
#
# What it sets up:
#   <Dest>\bun.exe            the agent's own native ARM64 bun (a copy, so a
#                             reinstall can stop exactly this process)
#   <Dest>\guestagent.ts      the agent
#   <Dest>\winvm-ui.exe       UI Automation helper the agent drives (/ui);
#                             compiled here from C# (docs/gui.md)
#   <Dest>\winvm-display.exe  screen size and display scaling, set live
#                             (/display); compiled here from C# (display.ts)
#   <Dest>\runinsession.exe   start a program on the logged-on desktop from
#                             session 0 (qemu-ga); compiled here from C#
#   <Dest>\conpty.exe         one terminal session (/term): a shell in a
#                             pseudo-console; compiled here from C#
#   HKLM Run "winvm-agent"    starts the agent at every logon, IN the user's
#                             session, so what it launches is on the desktop
#   firewall rule             the agent's port, from 10.0.2.2 (slirp) only
#
# Exit 0 done; 3 = no bun available and no -BunUrl (the host serves one and retries).
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

# 1. Stop a running agent: it holds bun.exe open, and two would fight over the port.
#    Its helpers too, which hold their exes open (a terminal's shell goes with conpty).
$helpers = @("winvm-ui.exe", "conpty.exe", "winvm-display.exe") | ForEach-Object { Join-Path $Dest $_ }
$running = @(Get-Process bun, winvm-ui, conpty, winvm-display -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $bun -or $helpers -contains $_.Path })
if ($running.Count -gt 0) {
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Write-Output "stopped agent pid $($running.Id -join ',')"
}
# An agent before v1's handle fix leaked its listening socket into everything it
# started; such a process keeps the port, and the new agent cannot listen.
$held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($held) { Write-Output "WARNING: port $Port is still held (a process an old agent started inherited it); end that process or restart the guest" }

# 2. bun: staged with the agent, else the image's payload copy, else what is
#    already installed, else downloaded from the host.
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

# 3. The agent, and its token readable by administrators and SYSTEM only.
Copy-Item (Join-Path $Source "guestagent.ts") (Join-Path $Dest "guestagent.ts") -Force
$token = Join-Path $Dest "token"
if (Test-Path $token) { icacls $token /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Null }

# 4. The session launcher. Compiled only when its source changed: Add-Type
#    costs seconds under emulated x64 PowerShell.
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

# 4b. The UI Automation helper, the same way. AnyCPU: native ARM64 under .NET 4.8.1.
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

# 4c. The terminal helper, the same way.
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

# 4d. The display helper, the same way: a one-shot console program per request.
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

# 5. Firewall: naming the program as well as the port also keeps Windows from
#    asking on the desktop the first time bun listens.
netsh advfirewall firewall delete rule name=winvm-agent 2>&1 | Out-Null
netsh advfirewall firewall add rule name=winvm-agent dir=in action=allow protocol=TCP localport=$Port remoteip=10.0.2.2 program="$bun" | Out-Null
#    And never ASK on the desktop, for any program. Any other bun.exe that
#    listens beyond loopback (measured: the payload's
#    C:\payload\bun-windows-aarch64\bun.exe serving on 0.0.0.0) otherwise pops
#    "Do you want to allow public and private networks to access this app?",
#    which sits over whatever a GUI job is driving -- and dismissing it adds
#    block rules. With notifications off the firewall still blocks what no
#    rule allows; it just says nothing. Here rather than provision.ps1 so an
#    instance of an older image gets it with its next agent install too.
netsh advfirewall set allprofiles settings inboundusernotification disable | Out-Null

# 6. Start at every logon. conhost --headless gives the agent (and every
#    console program it runs) a console with no window; --supervise restarts
#    it if it dies.
$argv = @("C:\Windows\System32\conhost.exe", "--headless", $bun, (Join-Path $Dest "guestagent.ts"), "--supervise",
    "--port", "$Port", "--token-file", $token, "--allow-from", "10.0.2.2,127.0.0.1",
    "--log", (Join-Path $Dest "agent.log"), "--close-sysprep")
$line = ($argv | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join " "
Set-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name "winvm-agent" -Value $line

# 7. And now, in the logged-on session, if there is one.
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
