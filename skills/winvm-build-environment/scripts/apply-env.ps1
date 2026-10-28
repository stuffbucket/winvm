# apply-env.ps1: apply an environment spec to a winvm Windows machine, then
# checkpoint it. Windows PowerShell 5.1 or PowerShell 7 (Windows, macOS, Linux).
# Same flags, exit codes and --json output as apply-env.sh; a thin wrapper over
# `winvm run` and `winvm save`.
#
#   apply-env.ps1 -i NAME [--save CHECKPOINT] [--note TEXT] [--json] SPEC.yml
#
# Exit codes: 0 applied (and checkpointed, with --save); 1 a step failed, no
# checkpoint taken; 2 usage; 3 applied, but the checkpoint failed; 127 no winvm.
# --json: stdout is one JSON object; winvm's own output goes to stderr.
# WINVM names the winvm command (default: winvm on PATH, ~/.local/bin/winvm, the app's).
# WINVM_TEMPLATES defaults to the winvm-inside-windows skill's templates folder.
$ErrorActionPreference = 'Stop'

function Show-Usage {
  [Console]::Error.WriteLine('usage: apply-env.ps1 -i NAME [--save CHECKPOINT] [--note TEXT] [--json] SPEC.yml')
  exit 2
}

$instance = ''; $save = ''; $note = ''; $json = $false; $spec = ''
$i = 0
while ($i -lt $args.Count) {
  $a = [string]$args[$i]
  switch -CaseSensitive ($a) {
    '-i' { if ($i + 1 -ge $args.Count) { Show-Usage }; $instance = [string]$args[$i + 1]; $i += 2; continue }
    '--save' { if ($i + 1 -ge $args.Count) { Show-Usage }; $save = [string]$args[$i + 1]; $i += 2; continue }
    '--note' { if ($i + 1 -ge $args.Count) { Show-Usage }; $note = [string]$args[$i + 1]; $i += 2; continue }
    '--json' { $json = $true; $i += 1; continue }
    default {
      if ($a.StartsWith('-') -or $spec) { Show-Usage }
      $spec = $a; $i += 1
    }
  }
}
if (-not $instance -or -not $spec) { Show-Usage }

function JStr([string]$s) { '"' + $s.Replace('\', '\\').Replace('"', '\"') + '"' }
function Finish([string]$ok, [string]$stage, [int]$code) {
  if (-not $json) { return }
  $cp = if ($save -and $stage -eq 'done') { JStr $save } else { 'null' }
  [Console]::Out.WriteLine('{"ok":' + $ok + ',"instance":' + (JStr $instance) + ',"spec":' + (JStr $spec) +
    ',"checkpoint":' + $cp + ',"stage":"' + $stage + '","exit":' + $code + '}')
}

$winvm = @()
if ($env:WINVM) {
  $winvm = @($env:WINVM -split '\s+' | Where-Object { $_ })
} elseif (Get-Command winvm -ErrorAction SilentlyContinue) {
  $winvm = @('winvm')
} elseif ($HOME -and (Test-Path -LiteralPath (Join-Path $HOME '.local/bin/winvm'))) {
  $winvm = @((Join-Path $HOME '.local/bin/winvm'))
} elseif (Test-Path -LiteralPath '/Applications/winvm.app/Contents/MacOS/winvm') {
  $winvm = @('/Applications/winvm.app/Contents/MacOS/winvm')
} else {
  [Console]::Error.WriteLine('apply-env: winvm not found (set WINVM)')
  Finish 'false' 'winvm' 127; exit 127
}
if (-not $env:WINVM_TEMPLATES) {
  $t = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') (Join-Path 'winvm-inside-windows' 'templates')
  if (Test-Path -LiteralPath $t) { $env:WINVM_TEMPLATES = (Resolve-Path -LiteralPath $t).ProviderPath }
}

function Invoke-Winvm([string[]]$rest) {
  $exe = $winvm[0]
  $pre = @($winvm | Select-Object -Skip 1)
  if ($json) { & $exe @pre @rest 2>&1 | ForEach-Object { [Console]::Error.WriteLine([string]$_) } }
  else { & $exe @pre @rest 2>&1 | ForEach-Object { [Console]::Out.WriteLine([string]$_) } }
  return $LASTEXITCODE
}

$ErrorActionPreference = 'Continue'
$rc = Invoke-Winvm @('run', $spec, '-i', $instance, '--keep')
if ($rc -ne 0) {
  [Console]::Error.WriteLine("apply-env: the spec failed (winvm run exited $rc); no checkpoint taken")
  Finish 'false' 'apply' $rc; exit 1
}

if ($save) {
  $saveArgs = @('save', '-i', $instance, $save)
  if ($note) { $saveArgs += @('--note', $note) }
  $rc = Invoke-Winvm $saveArgs
  if ($rc -ne 0) {
    [Console]::Error.WriteLine("apply-env: applied, but the checkpoint failed (winvm save exited $rc)")
    Finish 'false' 'save' $rc; exit 3
  }
}
Finish 'true' 'done' 0
exit 0
