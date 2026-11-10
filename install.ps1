# Pental Report installer for Windows: https://pental.io/report
#
# Installs Pental Report with Docker Desktop and opens it, or updates the one
# already here. Your settings (.env) and your data (Docker volumes) are kept
# by an update. In PowerShell:
#
#   irm https://pental.io/report/install.ps1 | iex
#
# With options, download it first:
#
#   irm https://pental.io/report/install.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Tailscale
#
#   -Tailscale      for your team, privately: shared on your Tailscale network
#                   at https://<this computer>.<your tailnet>.ts.net
#   -Domain NAME    serve it over HTTPS at NAME (its DNS must point here, ports 80 and 443 open)
#   -Local          this computer only, at http://localhost (the default)
#   -Dir PATH       where it lives (default $HOME\pental-report)
#   -Version X.Y.Z  a release other than this installer's
#   -Yes            ask nothing, take the defaults
#   -NoOpen         leave the browser closed at the end
#   -NoTelemetry    tell pental.io nothing: not that it was installed, and not,
#                   from the app, that it is running
#
# Docker Desktop, and the WSL it runs on, are installed here when they are
# missing, with Windows asking once for permission. When Windows has to
# restart to finish, this carries on by itself, in a new window, once you have
# signed in again.
#
# It tells pental.io when it has installed or updated Pental Report, or at
# which step it stopped and why, and the app says once a day that it is
# running: a random ID made here, the version, the system and the processor,
# and nothing else. -NoTelemetry, or TELEMETRY=off in .env, turns all of it off.
#
# Copyright (c) Pental Limited.
# SPDX-License-Identifier: AGPL-3.0-only

& {
param(
  [string]$Domain = '',
  [switch]$Local,
  [switch]$Tailscale,
  [string]$Dir = '',
  [string]$Version = '0.1.34',
  [switch]$Yes,
  [switch]$NoOpen,
  [switch]$NoTelemetry,
  # Set by the window that carries on after Windows has restarted.
  [switch]$Resumed
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times faster without its bar
# GitHub and Docker Hub take TLS 1.2 or later, which Windows PowerShell 5.1 does not always offer by itself.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Stop = 'Pental Report was not installed.'

$Repo = 'pental-io/report'
$Image = 'ghcr.io/pental-io/report'
$VersionGiven = $PSBoundParameters.ContainsKey('Version')
$Version = $Version.TrimStart('v')
if (-not $Dir) { $Dir = Join-Path $HOME 'pental-report' }
$Log = Join-Path ([System.IO.Path]::GetTempPath()) 'pental-report-install.log'
Set-Content -Path $Log -Value '' -Encoding UTF8
# Where the installer keeps what carries it over a restart of Windows: this
# install's ID and the script Windows runs once you have signed in again.
$LocalAppData = $(if ($Env:LOCALAPPDATA) { $Env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' })
$CarryDir = Join-Path $LocalAppData 'pental-report-installer'
$CarryFile = Join-Path $CarryDir 'carry-on.ps1'
$IdFile = Join-Path $CarryDir 'install-id'
$RunOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$RunOnceName = 'PentalReportInstall'
# What the functions below change, kept where each of them can reach it.
$S = @{ Stage = 'system' }

# -- Counting installs ----------------------------------------------------------
# So Pental knows how many use Pental Report, the installer tells pental.io
# when it has finished (installed, or updated) or stopped, at which step and
# why, with this install's random ID (INSTALL_ID in .env; until .env is made,
# kept by the installer, so trying again or carrying on after a restart is the
# same install), the version, the system and the processor. Nothing else, and
# pental.io keeps no address. -NoTelemetry, PENTAL_REPORT_TELEMETRY=off or
# DO_NOT_TRACK=1 sends nothing and writes TELEMETRY=off to .env, which keeps
# it so, here and in the app (it says once a day that it is running
# otherwise: server/lib/usage.js).
$CountUrl = $(if ($Env:PENTAL_REPORT_TELEMETRY_URL) { $Env:PENTAL_REPORT_TELEMETRY_URL } else { 'https://pental.io/api/report/ping' })
$Counting = $true; $OffNow = $false
if ($NoTelemetry -or ("$Env:PENTAL_REPORT_TELEMETRY" -match '^(off|0|false|no)$') -or ("$Env:DO_NOT_TRACK" -match '^(1|true|yes)$')) { $Counting = $false; $OffNow = $true }
$IdShape = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$InstallId = ''
$envFile = Join-Path $Dir '.env'
if (Test-Path $envFile) {
  try {
    $envNow = @(Get-Content $envFile)
    # On as the app reads it: empty, on, 1, true or yes; anything else is off.
    $t = $envNow | Where-Object { $_ -match '^TELEMETRY=' } | Select-Object -Last 1
    if ($t) { $tv = $t.Substring(10).Trim().Trim('"', "'").ToLowerInvariant(); if ($tv -and $tv -notmatch '^(on|1|true|yes)$') { $Counting = $false } }
    $i = $envNow | Where-Object { $_ -match '^INSTALL_ID=' } | Select-Object -Last 1
    if ($i) { $InstallId = $i.Substring(11).Trim().Trim('"', "'").ToLowerInvariant() }
  } catch {}
}
if ($InstallId -notmatch $IdShape) { $InstallId = ("$Env:PENTAL_REPORT_INSTALL_ID").Trim().ToLowerInvariant() }
if ($InstallId -notmatch $IdShape -and (Test-Path $IdFile)) { try { $InstallId = ([System.IO.File]::ReadAllText($IdFile)).Trim().ToLowerInvariant() } catch {} }
if ($InstallId -notmatch $IdShape) { $InstallId = [guid]::NewGuid().ToString() }
if ($Counting -and -not (Test-Path $envFile)) {
  try { New-Item -ItemType Directory -Force -Path $CarryDir | Out-Null; [System.IO.File]::WriteAllText($IdFile, $InstallId) } catch {}
}
function Send-Count([string]$what) {
  # One request, five seconds at most; whatever happens to it, the installer
  # carries on as it was.
  if (-not $Counting) { return }
  try {
    $cpu = "$Env:PROCESSOR_ARCHITEW6432 $Env:PROCESSOR_ARCHITECTURE"
    $body = [ordered]@{
      event = $what
      id = $InstallId
      version = $(if ($Version -match '^\d{1,4}\.\d{1,4}\.\d{1,4}$') { $Version } else { $null })
      os = 'windows'
      arch = $(if ($cpu -match 'ARM64') { 'arm64' } elseif ($cpu -match 'AMD64') { 'x64' } else { 'other' })
      stage = $(if ($what -eq 'failed') { $S.Stage } else { $null })
    } | ConvertTo-Json -Compress
    $null = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $CountUrl -ContentType 'application/json' -Body $body -TimeoutSec 5
  } catch {}
}

# -- How it looks -------------------------------------------------------------
$prevEnc = [Console]::OutputEncoding
# Windows Terminal draws every character used here; the older console window
# is given plain ones it has.
$Fancy = [bool]$Env:WT_SESSION
if ($Fancy) {
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
  $Tick = [string][char]0x2713; $Cross = [string][char]0x2717; $Dot = [string][char]0x2022; $Arrow = [string][char]0x203A
  $Bar = [string][char]0x2502; $Top = [string][char]0x256D; $Bot = [string][char]0x2570; $H = [string][char]0x2500
  $Frames = @(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F) | ForEach-Object { [string][char]$_ }
} else {
  $Tick = '+'; $Cross = 'x'; $Dot = '*'; $Arrow = '>'; $Bar = '|'; $Top = '+'; $Bot = '+'; $H = '-'
  $Frames = @('|', '/', '-', '\')
}

function Step($t) { Write-Host '  ' -NoNewline; Write-Host $Tick -ForegroundColor Green -NoNewline; Write-Host " $t" }
function Note($t) { Write-Host "  $Dot $t" -ForegroundColor DarkGray }
function Warn($t) { Write-Host '  ' -NoNewline; Write-Host '!' -ForegroundColor Yellow -NoNewline; Write-Host " $t" }
# Fail says what went wrong and how to put it right, tells pental.io where it
# stopped (the step, or why, when that is known), and ends the install.
function Fail([string]$t, [string[]]$more = @(), [string]$why = '') {
  if ($why) { $S.Stage = $why }
  Write-Host ''
  Write-Host '  ' -NoNewline; Write-Host $Cross -ForegroundColor Red -NoNewline; Write-Host " $t"
  foreach ($l in $more) { Write-Host "    $l" }
  if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 2)) {
    Write-Host ''
    Write-Host '    The last of what it said:' -ForegroundColor DarkGray
    Get-Content $Log -Tail 12 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    Write-Host "    All of it: $Log" -ForegroundColor DarkGray
  }
  Write-Host ''
  Send-Count 'failed'
  throw $Stop
}
function Ask([string]$q, [string]$default) {
  if ($Yes) { return $default }
  Write-Host '  ' -NoNewline; Write-Host $Arrow -ForegroundColor Red -NoNewline
  $a = Read-Host " $q"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}
function Clear-Line([int]$n) { Write-Host ("`r" + (' ' * ($n + 6)) + "`r") -NoNewline }
# A program run with a spinner beside the label, what it says going to the log.
function Run([string]$label, [string]$exe, [string[]]$argv) {
  $out = [System.IO.Path]::GetTempFileName(); $err = [System.IO.Path]::GetTempFileName()
  # In the folder the installer is in (docker compose reads it), said outright:
  # Set-Location moves PowerShell, not always what a new process starts in.
  $p = Start-Process -FilePath $exe -ArgumentList $argv -WorkingDirectory (Get-Location).ProviderPath -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle   # without it, Windows PowerShell can lose the exit code
  $i = 0
  while (-not $p.HasExited) {
    Write-Host ("`r  " + $Frames[$i % $Frames.Length]) -ForegroundColor Red -NoNewline
    Write-Host " $label" -NoNewline
    Start-Sleep -Milliseconds 100; $i++
  }
  [void]$p.WaitForExit()
  Clear-Line $label.Length
  Get-Content $out, $err -ErrorAction SilentlyContinue | Add-Content -Path $Log
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  return ($p.ExitCode -eq 0)
}
# The same, tried again a little later when it fails (three times in all): a
# download from Docker Hub or GitHub can fail once and work the next time.
function Run-Again([string]$label, [string]$exe, [string[]]$argv) {
  for ($n = 1; $n -le 3; $n++) {
    if (Run $label $exe $argv) { return $true }
    if ($n -lt 3) { Add-Content -Path $Log -Value "Trying again ($($n + 1) of 3)."; Start-Sleep -Seconds (5 * $n) }
  }
  return $false
}
# Waits until $ok says so, with a spinner and the label (a scriptblock, when
# what it says changes as it goes), for $seconds at most.
function Wait-Until([object]$label, [scriptblock]$ok, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds); $i = 0; $wide = 0
  while ((Get-Date) -lt $deadline) {
    if (& $ok) { Clear-Line $wide; return $true }
    $text = $(if ($label -is [scriptblock]) { [string](& $label) } else { [string]$label })
    if ($text.Length -gt $wide) { $wide = $text.Length }
    for ($k = 0; $k -lt 10; $k++) {
      Write-Host ("`r  " + $Frames[$i % $Frames.Length]) -ForegroundColor Red -NoNewline
      Write-Host " $text" -NoNewline
      Start-Sleep -Milliseconds 100; $i++
    }
  }
  Clear-Line $wide
  return $false
}
# A program's answer and its exit code, read whole. Windows PowerShell makes a
# program's error output an error of its own when it is redirected, so here it
# is let through as text (or left out, with -OutOnly). WSL answers in UTF-16
# unless WSL_UTF8 is set, which older versions do not read: its NULs go.
function Exe-Out([string]$exe, [string[]]$argv, [switch]$OutOnly) {
  $ErrorActionPreference = 'Continue'
  $code = -1; $text = ''
  try {
    if ($OutOnly) { $o = & $exe @argv 2>$null } else { $o = & $exe @argv 2>&1 }
    $code = $LASTEXITCODE
    $text = (@($o) | ForEach-Object { "$_" }) -join "`n"
  } catch { $text = "$_" }
  return [pscustomobject]@{ Code = $code; Text = ($text -replace "`0", '') }
}
function Ok-Code($c) { return ($c -eq 0 -or $c -eq 3010) }   # 3010: done, once Windows restarts
function Cim([string]$class, [string]$filter = '') {
  try {
    if ($filter) { return @(Get-CimInstance -ClassName $class -Filter $filter -ErrorAction Stop) }
    return @(Get-CimInstance -ClassName $class -ErrorAction Stop)
  } catch { return @() }
}
# A path in single quotes, as PowerShell reads it back (a quote in it doubled).
function Q([string]$s) { $q = [string][char]39; return $q + $s.Replace($q, $q + $q) + $q }
# Downloaded with what it has so far beside the label; $false when it failed.
function Get-Download([string]$url, [string]$dest, [string]$label, [int]$seconds) {
  $wc = New-Object System.Net.WebClient
  # Through the proxy Windows is set to use, signed in to it as you are.
  try { $wc.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials } catch {}
  $task = $wc.DownloadFileTaskAsync($url, $dest)
  # Named apart from Wait-Until's own variables, which this is run among.
  $saying = $label
  $say = {
    $mb = 0
    try { $mb = [math]::Floor((Get-Item -LiteralPath $dest -ErrorAction Stop).Length / 1048576) } catch {}
    if ($mb -gt 0) { "$saying ($mb MB)" } else { $saying }
  }
  $null = Wait-Until $say { $task.IsCompleted } $seconds
  if (-not $task.IsCompleted -or $task.IsFaulted -or $task.IsCanceled) {
    if ($task.Exception) { $e = $task.Exception.GetBaseException(); Add-Content -Path $Log -Value $e.Message }
    try { [void]$wc.CancelAsync() } catch {}
    return $false
  }
  return $true
}
function Port-Busy([int]$port) {
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) } catch { return $false }
}
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Env-Get([string]$key) {
  $line = Get-Content (Join-Path $Dir '.env') | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
  if ($line) { return $line.Substring($key.Length + 1) } else { return '' }
}
function Env-Set([string]$key, [string]$value) {
  $f = Join-Path $Dir '.env'
  $lines = @(Get-Content $f)
  if ($lines | Where-Object { $_ -match "^$key=" }) { $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { "$key=$value" } else { $_ } } }
  else { $lines += "$key=$value" }
  [System.IO.File]::WriteAllLines($f, [string[]]$lines, (New-Object System.Text.UTF8Encoding $false))
}

# -- Docker Desktop, WSL and Windows ---------------------------------------------
# Docker Desktop installs for everyone (Program Files) or, run with --user, for
# one account (its own folder); its installer puts docker on the PATH of windows
# opened after it, not this one, so the PATH is read again from Windows (and
# Docker's own folder added where it is not there yet), and nothing needs
# closing and opening.
$DockerDir = Join-Path $(if ($Env:ProgramW6432) { $Env:ProgramW6432 } else { $Env:ProgramFiles }) 'Docker\Docker'
$DockerApp = Join-Path $DockerDir 'Docker Desktop.exe'
$DockerUserDir = Join-Path $LocalAppData 'Programs\DockerDesktop'
$DockerUserApp = Join-Path $DockerUserDir 'Docker Desktop.exe'
$CpuArch = "$Env:PROCESSOR_ARCHITEW6432 $Env:PROCESSOR_ARCHITECTURE"
$DockerUrl = 'https://desktop.docker.com/win/main/' + $(if ($CpuArch -match 'ARM64') { 'arm64' } else { 'amd64' }) + '/Docker%20Desktop%20Installer.exe'
$WslNeeded = [version]'2.1.5'   # the oldest WSL Docker Desktop runs on
# 32-bit PowerShell on 64-bit Windows sees another System32: Sysnative is the
# real one, where wsl.exe and the 64-bit PowerShell are. Otherwise each is
# run by its name, from the PATH, as anywhere else.
$Sys32 = Join-Path $Env:SystemRoot 'System32'
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess -and (Test-Path (Join-Path $Env:SystemRoot 'Sysnative'))) { $Sys32 = Join-Path $Env:SystemRoot 'Sysnative' }
function Sys-Exe([string]$name) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { return $name }
  $p = Join-Path $Sys32 $name
  if (Test-Path $p) { return $p }
  return $name
}
$WslExe = Sys-Exe 'wsl.exe'
$DismExe = Sys-Exe 'dism.exe'
$PsExe = Join-Path $Sys32 'WindowsPowerShell\v1.0\powershell.exe'

function Refresh-Path {
  $seen = @{}; $parts = @()
  $all = @($Env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
  foreach ($bin in (Join-Path $DockerDir 'resources\bin'), (Join-Path $DockerUserDir 'resources\bin')) {
    if (Test-Path (Join-Path $bin 'docker.exe')) { $all += $bin }
  }
  foreach ($p in $all) {
    if (-not $p) { continue }
    foreach ($d in $p.Split(';')) {
      $k = $d.Trim().TrimEnd('\').ToLowerInvariant()
      if ($k -and -not $seen.ContainsKey($k)) { $seen[$k] = $true; $parts += $d.Trim() }
    }
  }
  $Env:Path = $parts -join ';'
}
function Docker-App {
  foreach ($p in $DockerApp, $DockerUserApp) { if (Test-Path $p) { return $p } }
  return $null
}
# 'linux' or 'windows' (the containers Docker Desktop is set to) once Docker
# answers, otherwise ''.
function Docker-OsType {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return '' }
  $r = Exe-Out 'docker' @('info', '--format', '{{.OSType}}') -OutOnly
  if ($r.Code -ne 0) { return '' }
  if ($r.Text -match 'windows') { return 'windows' }
  return 'linux'
}
# 'on' when a hypervisor runs (WSL can start), 'ready' when the processor's
# virtualisation is on but nothing uses it yet, 'off' when it is turned off in
# the firmware, '' when Windows does not say. With a hypervisor running,
# Windows reports the processor's own virtualisation as off, so that is asked
# second.
function Virt-State {
  $cs = Cim 'Win32_ComputerSystem' | Select-Object -First 1
  if ($cs -and $cs.HypervisorPresent -eq $true) { return 'on' }
  $cpu = Cim 'Win32_Processor' | Select-Object -First 1
  if ($cpu -and $cpu.VirtualizationFirmwareEnabled -eq $true) { return 'ready' }
  if ($cpu -and $cpu.VirtualizationFirmwareEnabled -eq $false) { return 'off' }
  return ''
}
# 1 on, 2 off, 3 not part of this Windows, 0 when Windows does not say.
function Feature-State([string]$name) {
  $f = Cim 'Win32_OptionalFeature' "Name='$name'" | Select-Object -First 1
  if ($f -and $f.InstallState) { return [int]$f.InstallState }
  return 0
}
function Restart-Pending { return (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') }
# The version of WSL installed from the Microsoft Store or GitHub, which
# Docker Desktop needs; $null for the one built into Windows (it has no
# --version) or none at all.
function Wsl-Version {
  if (-not (Get-Command $WslExe -ErrorAction SilentlyContinue)) { return $null }
  $Env:WSL_UTF8 = '1'
  $r = Exe-Out $WslExe @('--version')
  if ($r.Code -ne 0) { return $null }
  $m = [regex]::Match($r.Text, '(\d+)\.(\d+)\.(\d+)')
  if (-not $m.Success) { return $null }
  return [version]('{0}.{1}.{2}' -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value)
}
# Docker Desktop keeps the version of its terms that was accepted in its
# settings. With no settings yet it is not known, and taken as accepted.
function Terms-Accepted {
  $roaming = $(if ($Env:APPDATA) { $Env:APPDATA } else { Join-Path $HOME 'AppData\Roaming' })
  foreach ($n in 'settings-store.json', 'settings.json') {
    $f = Join-Path $roaming "Docker\$n"
    if (Test-Path $f) {
      try { return ((Get-Content -Raw -Path $f) -match '"licenseTermsVersion"\s*:\s*[1-9]') } catch { return $true }
    }
  }
  return $true
}
function Server-Off {
  try { $s = Get-Service -Name LanmanServer -ErrorAction Stop } catch { return $false }
  return ([string]$s.Status -ne 'Running') -or ($s.StartType -and [string]$s.StartType -eq 'Disabled')
}
# The end of Docker Desktop's own log, put in this installer's log, so what
# stopped it is there to read.
function Docker-LogTail {
  try {
    $d = Join-Path $LocalAppData 'Docker\log'
    if (-not (Test-Path $d)) { return }
    $f = Get-ChildItem -Path $d -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) {
      Add-Content -Path $Log -Value ("-- The end of Docker Desktop's own log, " + $f.FullName + ':')
      Get-Content -Path $f.FullName -Tail 30 -ErrorAction SilentlyContinue | Add-Content -Path $Log
    }
  } catch {}
}
function Fail-Virtualisation {
  Fail 'Virtualisation is turned off on this computer, and Docker Desktop needs it.' @(
    "Turn it on in the computer's firmware settings (UEFI or BIOS), where it is called Intel VT-x,",
    'Intel Virtualization Technology, AMD-V or SVM Mode. Microsoft says how:',
    'https://support.microsoft.com/windows/experience/enable-virtualization-on-windows',
    'If this Windows runs in a virtual machine, turn on nested virtualisation for it instead.',
    'Then run this again.') 'docker_virtualisation'
}

# The steps that need an administrator, run together in one PowerShell that
# Windows asks permission for once. What each did is written back as JSON.
# Kept to plain ASCII: Windows PowerShell reads it.
$AdminScript = @'
# Pental Report's installer: the steps that need an administrator, run once
# with the permission Windows asked for. What each did is written back.
param([string]$PlanFile)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$plan = [System.IO.File]::ReadAllText($PlanFile) | ConvertFrom-Json
$done = @{}
function Exe([string]$exe, [string[]]$argv) {
  $code = -1; $text = ''
  try { $o = & $exe @argv 2>&1; $code = $LASTEXITCODE; $text = (@($o) | ForEach-Object { "$_" }) -join "`n" } catch { $text = "$_" }
  return @{ code = $code; text = ($text -replace "`0", '') }
}
function Ok($c) { return ($c -eq 0 -or $c -eq 3010) }
$Env:WSL_UTF8 = '1'
if ($plan.wsl -eq 'install') {
  # WSL from the Microsoft Store, without a Linux of its own (Docker Desktop
  # brings one), and the Virtual Machine Platform it needs; from GitHub when
  # the Store cannot be reached.
  $r = Exe $plan.wslExe @('--install', '--no-distribution')
  if (-not (Ok $r.code)) { $r = Exe $plan.wslExe @('--install', '--no-distribution', '--web-download') }
  $done.wsl = $r
} elseif ($plan.wsl -eq 'update') {
  $r = Exe $plan.wslExe @('--update')
  if (-not (Ok $r.code)) { $r = Exe $plan.wslExe @('--update', '--web-download') }
  $done.wsl = $r
}
if ($plan.feature) {
  $done.feature = Exe $plan.dism @('/online', '/enable-feature', '/featurename:VirtualMachinePlatform', '/all', '/norestart')
}
if ($plan.docker) {
  try {
    $p = Start-Process -FilePath $plan.docker -ArgumentList @('install', '--quiet', '--accept-license', '--backend=wsl-2') -Wait -PassThru -ErrorAction Stop
    $done.docker = @{ code = $p.ExitCode; text = '' }
  } catch { $done.docker = @{ code = -1; text = "$_" } }
}
[System.IO.File]::WriteAllText($plan.result, ($done | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $true))
'@
# $null when Windows was not given permission (refused, or no administrator
# here to give it).
function Invoke-Admin([hashtable]$plan) {
  $d = Join-Path ([System.IO.Path]::GetTempPath()) ('pental-report-admin-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $d | Out-Null
  $script = Join-Path $d 'admin.ps1'; $planFile = Join-Path $d 'plan.json'; $result = Join-Path $d 'result.json'
  $plan.result = $result
  $plan.dism = $DismExe
  $utf8 = New-Object System.Text.UTF8Encoding $true
  [System.IO.File]::WriteAllText($script, $AdminScript, $utf8)
  [System.IO.File]::WriteAllText($planFile, ($plan | ConvertTo-Json -Depth 4), $utf8)
  try {
    $p = Start-Process -FilePath $PsExe -Verb RunAs -WindowStyle Minimized -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"", "`"$planFile`"")
  } catch {
    Add-Content -Path $Log -Value ("Asking Windows for permission: " + $_.Exception.Message)
    return $null
  }
  $finished = { (Test-Path $result) -or (& { try { [bool]$p.HasExited } catch { $false } }) }
  $null = Wait-Until 'Setting up, with the permission Windows gave (a few minutes)' $finished 3600
  $back = [pscustomobject]@{ lost = $true }
  if (Test-Path $result) {
    try { $back = [System.IO.File]::ReadAllText($result) | ConvertFrom-Json } catch {}
  }
  Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
  return $back
}
# Docker Desktop's installer, from Docker, checked to be signed by Docker.
function Get-DockerInstaller {
  $d = Join-Path ([System.IO.Path]::GetTempPath()) ('pental-report-docker-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $d | Out-Null
  $f = Join-Path $d 'Docker Desktop Installer.exe'
  if (-not (Get-Download $DockerUrl $f 'Downloading Docker Desktop' 3600)) {
    Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
    Fail 'Docker Desktop could not be downloaded.' @("From $DockerUrl", 'Check this computer can reach desktop.docker.com, then try again.') 'docker_download'
  }
  $sig = $null
  try { $sig = Get-AuthenticodeSignature -FilePath $f } catch {}
  $who = ''
  if ($sig -and $sig.SignerCertificate) { $who = [string]$sig.SignerCertificate.Subject }
  if (-not $sig -or [string]$sig.Status -ne 'Valid' -or $who -notmatch 'Docker') {
    Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
    Fail 'The Docker Desktop installer that was downloaded is not signed by Docker, so it was not run.' @("From $DockerUrl", 'Try again. If it says this again, install Docker Desktop from https://www.docker.com/products/docker-desktop/.') 'docker_signature'
  }
  Step 'Docker Desktop downloaded'
  return $f
}
# Opened, and waited for until its engine answers with Linux containers:
# opened again if it is closed meanwhile (three times at most), and switched
# to Linux containers if it is set to Windows containers.
function Docker-Start([int]$seconds, [bool]$open) {
  $app = Docker-App
  $st = @{ opened = Get-Date; again = 0; switched = $false }
  if ($open -and $app) { Start-Process -FilePath $app | Out-Null }
  $up = {
    $t = Docker-OsType
    if ($t -eq 'linux') { return $true }
    if ($t -eq 'windows' -and -not $st.switched) {
      $st.switched = $true
      Add-Content -Path $Log -Value 'Docker Desktop is set to Windows containers: switching it to Linux containers.'
      $r = Exe-Out 'docker' @('desktop', 'engine', 'use', 'linux')
      Add-Content -Path $Log -Value $r.Text
      if ($r.Code -ne 0 -and $app) {
        $cli = Join-Path (Split-Path -Parent $app) 'DockerCli.exe'
        if (Test-Path $cli) { $null = Exe-Out $cli @('-SwitchLinuxEngine') }
      }
      return $false
    }
    if ($t -eq '' -and $app -and $st.again -lt 3 -and ((Get-Date) - $st.opened).TotalSeconds -gt 45 -and -not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
      Add-Content -Path $Log -Value 'Docker Desktop was closed: opening it again.'
      Start-Process -FilePath $app | Out-Null
      $st.again++; $st.opened = Get-Date
    }
    return $false
  }
  return (Wait-Until 'Waiting for Docker Desktop to start' $up $seconds)
}
# Why Docker Desktop has not started, as far as can be told from here.
function Docker-Why {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return 'docker_install' }
  if ((Docker-OsType) -eq 'windows') { return 'docker_engine' }
  if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) { return 'docker_closed' }
  if (Restart-Pending) { return 'restart' }
  $v = Virt-State
  if ($v -eq 'off') { return 'docker_virtualisation' }
  if ($v -eq 'ready') { return 'docker_hypervisor' }
  if (-not (Terms-Accepted)) { return 'docker_terms' }
  if (Server-Off) { return 'docker_server' }
  return 'docker_start'
}
# Carrying on after a restart: a script Windows runs once, when you have signed
# in again (RunOnce), that runs this installer again with what it was given,
# and the same install ID. It removes itself first, so it runs only once.
function Set-CarryOn {
  New-Item -ItemType Directory -Force -Path $CarryDir | Out-Null
  $opts = @()
  if ($Domain) { $opts += '-Domain ' + (Q $Domain) }
  if ($Local) { $opts += '-Local' }
  if ($Tailscale) { $opts += '-Tailscale' }
  $opts += '-Dir ' + (Q $Dir)
  if ($VersionGiven) { $opts += '-Version ' + (Q $Version) }
  if ($Yes) { $opts += '-Yes' }
  if ($NoOpen) { $opts += '-NoOpen' }
  if ($NoTelemetry) { $opts += '-NoTelemetry' }
  $opts += '-Resumed'
  # The installer at pental.io, however this one was run: a script that runs
  # it can be anything, and is not the one to run again.
  $from = "& ([scriptblock]::Create((Invoke-RestMethod 'https://pental.io/report/install.ps1')))"
  $lines = @(
    '# Carries on installing Pental Report now that Windows has restarted. Its installer',
    '# made this, and Windows runs it once, when you sign in. It removes itself.',
    ('Remove-Item -LiteralPath ' + (Q $CarryFile) + ' -ErrorAction SilentlyContinue'),
    'try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}',
    ('$Env:PENTAL_REPORT_INSTALL_ID = ' + (Q $InstallId)),
    ($from + ' ' + ($opts -join ' '))
  )
  [System.IO.File]::WriteAllLines($CarryFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding $true))
  $cmd = '"' + $PsExe + '" -NoProfile -NoExit -ExecutionPolicy Bypass -File "' + $CarryFile + '"'
  if (-not (Test-Path $RunOnceKey)) { New-Item -Path $RunOnceKey -Force | Out-Null }
  New-ItemProperty -Path $RunOnceKey -Name $RunOnceName -Value $cmd -PropertyType String -Force | Out-Null
}
function Clear-CarryOn {
  try { Remove-ItemProperty -Path $RunOnceKey -Name $RunOnceName -ErrorAction Stop } catch {}
  Remove-Item -LiteralPath $CarryFile -Force -ErrorAction SilentlyContinue
}
# Windows restarts to finish what WSL needs; this carries on once you have
# signed in. Asked, never done unasked (and with -Yes, left to you).
function Ask-Restart([string]$why) {
  # Once only: after a restart, a second is not asked for (Windows can say it
  # needs one when an update of its own is stuck).
  if ($Resumed) {
    Fail 'Windows has restarted, but Docker Desktop still cannot start.' @(
      'Run Windows Update and restart if it asks, then run this again. If it says this',
      'again, install WSL from https://github.com/microsoft/WSL/releases and restart.') 'restart_again'
  }
  Set-CarryOn
  $S.Stage = 'restart'
  Send-Count 'failed'
  Write-Host ''
  Warn $why
  Note 'Once you have signed in again, this carries on by itself, in a new window.'
  $a = Ask 'Restart Windows now? Save your work first. [Y/n]' $(if ($Yes) { 'n' } else { 'y' })
  Write-Host ''
  if ($a -notmatch '^[nN]') {
    try { Restart-Computer -ErrorAction Stop; Note 'Windows is restarting.' }
    catch { Warn 'Windows would not restart from here: restart it from the Start menu.' }
  } else {
    Note 'Restart Windows when you are ready: this carries on once you have signed in.'
  }
  Write-Host ''
  throw $Stop
}

try {
Write-Host ''
Write-Host '  ' -NoNewline; Write-Host 'PENTAL' -ForegroundColor Red -NoNewline; Write-Host '  Report' -NoNewline; Write-Host "  $Version" -ForegroundColor DarkGray
Write-Host '  Free, open-source penetration test reporting, on your own server.' -ForegroundColor DarkGray
Write-Host ''
Clear-CarryOn
if ($Resumed) { Step 'Windows has restarted: carrying on' }

# -- This computer ----------------------------------------------------------------
# Docker Desktop runs on 64-bit Windows 10 or 11, not on Windows Server: said
# now, before anything is downloaded.
$S.Stage = 'system'
$os = Cim 'Win32_OperatingSystem' | Select-Object -First 1
$build = 0
if ($os) { $build = [int]('0' + ([string]$os.BuildNumber -replace '\D', '')) }
if ($os -and $os.ProductType -and [int]$os.ProductType -ne 1) {
  Fail 'Docker Desktop does not run on Windows Server, which this is.' @(
    'Install Pental Report on a Linux server instead:',
    '  curl -fsSL https://pental.io/report/install.sh | sh',
    'or on a Windows 10 or 11 computer.') 'system_server'
}
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Docker Desktop needs 64-bit Windows.' @('Install Pental Report on a 64-bit computer instead.') 'system_32bit' }
if ($build -gt 0 -and $build -lt 19041) {
  Fail 'This Windows is too old for Docker Desktop.' @('It needs Windows 10 version 22H2 or Windows 11. Run Windows Update, then run this again.') 'system_old'
}
if (($build -ge 19041 -and $build -lt 19045) -or ($build -ge 22000 -and $build -lt 22631)) {
  Warn 'Docker Desktop supports Windows 10 version 22H2, and Windows 11 version 23H2 or later.'
  Note 'This Windows is older: if Docker Desktop will not start, run Windows Update.'
}
if ($os -and $os.TotalVisibleMemorySize) {
  $ramGb = [math]::Round([double]$os.TotalVisibleMemorySize / 1048576)
  if ($ramGb -gt 0 -and $ramGb -lt 8) { Warn "Docker Desktop asks for 8 GB of memory, and this computer has $ramGb GB, so it may be slow." }
}
$sysDrive = $(if ($Env:SystemDrive) { $Env:SystemDrive } else { 'C:' })
$disk = Cim 'Win32_LogicalDisk' "DeviceID='$sysDrive'" | Select-Object -First 1
if ($disk -and $null -ne $disk.FreeSpace) {
  $freeGb = [math]::Floor([double]$disk.FreeSpace / 1073741824)
  if ($freeGb -lt 10) { Warn "Only $freeGb GB is free on ${sysDrive}, and Docker Desktop with Pental Report needs about 10 GB." }
}

# -- Docker -------------------------------------------------------------------
# Nothing is touched where Docker already answers. Otherwise: virtualisation
# must be on; WSL, the Virtual Machine Platform and Docker Desktop are put in
# where they are missing, in one go, with Windows asking permission once (and
# Docker Desktop for this account alone, which needs none, when that is all
# there is to do and permission was not given); Windows restarts when it has
# to; then Docker Desktop is opened and waited for.
$S.Stage = 'docker'
Refresh-Path
$engine = Docker-OsType
$installed = $false
if ($engine -eq '') {
  if ((Virt-State) -eq 'off') { Fail-Virtualisation }
  $wslV = Wsl-Version
  $wsl = $(if (-not $wslV) { 'install' } elseif ($wslV -lt $WslNeeded) { 'update' } else { '' })
  $vmp = Feature-State 'VirtualMachinePlatform'
  # Installing WSL turns the Virtual Machine Platform on itself.
  $feature = ($wsl -ne 'install') -and ($vmp -eq 2)
  $installer = $null
  if (-not (Docker-App)) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
      Warn 'Docker is not answering, and Docker Desktop is not installed.'
      Note 'If you use another Docker, such as Rancher Desktop, start it and run this again.'
    } else {
      Warn 'Docker Desktop is not installed.'
    }
    Note 'Docker Desktop is free for personal use, education, non-commercial open source and'
    Note 'businesses with fewer than 250 employees and under $10 million a year; others need'
    Note 'a paid Docker subscription. Installing it here accepts its terms:'
    Note 'https://www.docker.com/legal/docker-subscription-service-agreement'
    $want = Ask 'Install Docker Desktop now? [Y/n]' 'y'
    if ($want -match '^[nN]') {
      Fail 'Pental Report runs in Docker.' @('Install Docker Desktop from https://www.docker.com/products/docker-desktop/, then run this installer again.') 'docker_no'
    }
    $installer = Get-DockerInstaller
  }
  if ($wsl -or $feature -or $installer) {
    Write-Host ''
    Note 'Windows will ask for permission once, to:'
    if ($wsl -eq 'install') { Note '  install WSL, which Docker Desktop runs on' }
    if ($wsl -eq 'update') { Note "  update WSL to the version Docker Desktop needs ($WslNeeded or later)" }
    if ($feature) { Note "  turn on Windows' Virtual Machine Platform, which WSL needs" }
    if ($installer) { Note '  install Docker Desktop' }
    Note 'Choose Yes when it asks.'
    $plan = @{ wsl = $wsl; wslExe = $WslExe; feature = $feature; docker = $(if ($installer) { $installer } else { '' }) }
    $done = Invoke-Admin $plan
    $alone = $false
    if (-not $done -and $installer -and -not $wsl -and -not $feature) {
      # Docker Desktop for this account alone needs no permission: WSL is
      # ready for it already.
      $alone = $true
      Note 'Installing Docker Desktop for your account alone, which needs no permission.'
      if (-not (Run 'Installing Docker Desktop, which takes a few minutes' $installer @('install', '--user', '--quiet', '--accept-license'))) {
        Add-Content -Path $Log -Value 'Docker Desktop installer (for this account): it did not finish.'
      }
    }
    # Its installer is not needed again, whatever happened.
    if ($installer) { Remove-Item -LiteralPath (Split-Path -Parent $installer) -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not $done -and -not $alone) {
      Fail 'Windows was not given permission, so WSL and Docker Desktop could not be set up.' @(
        'Run this again and choose Yes when Windows asks. If your account cannot,',
        'ask an administrator of this computer to run it.') 'docker_permission'
    }
    if ($done -and $done.lost) {
      Fail 'The setup Windows gave permission for did not finish.' @('Run this again. If it stops here again, restart Windows first.') 'docker_install'
    }
    if ($done) {
      if ($wsl -and $done.wsl) {
        if ($done.wsl.text) { Add-Content -Path $Log -Value ([string]$done.wsl.text) }
        if (-not (Ok-Code $done.wsl.code)) {
          Fail 'WSL could not be installed, and Docker Desktop runs on it.' @(
            'Run Windows Update and restart, then run this again. If it says this again,',
            'install WSL from https://github.com/microsoft/WSL/releases and restart.') 'docker_wsl'
        }
      }
      if ($feature -and $done.feature) {
        if ($done.feature.text) { Add-Content -Path $Log -Value ([string]$done.feature.text) }
        if (-not (Ok-Code $done.feature.code)) {
          Fail "Windows' Virtual Machine Platform could not be turned on, and WSL needs it." @(
            'Turn it on in Windows Features (search for "Turn Windows features on or off"), restart,',
            'then run this again.') 'docker_wsl'
        }
      }
      if ($installer -and $done.docker -and $done.docker.text) { Add-Content -Path $Log -Value ([string]$done.docker.text) }
    }
    if ($installer) {
      Refresh-Path
      # Judged by what is on disk, whatever its installer answered.
      if (-not (Docker-App) -or -not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Fail 'Docker Desktop could not be installed.' @('Install it from https://www.docker.com/products/docker-desktop/, then run this again.') 'docker_install'
      }
      Step 'Docker Desktop installed'
      $installed = $true
    }
    if ($wsl -eq 'install') { Step 'WSL installed' }
    if ($wsl -eq 'update') { Step 'WSL updated' }
    if ($feature) { Step 'Virtual Machine Platform turned on' }
    # Turned on now, the Virtual Machine Platform starts with Windows.
    if (($wsl -or $feature) -and ((Restart-Pending) -or (Virt-State) -ne 'on')) {
      Ask-Restart 'Windows needs to restart to finish setting up WSL for Docker Desktop.'
    }
  }
}
if ($engine -ne 'linux') {
  if ($installed) {
    Note 'Docker Desktop is opening for the first time: skip signing in, or create an account,'
    Note 'on to its main screen. This carries on by itself once it has started.'
  } elseif ($engine -eq '') {
    Note 'If Docker Desktop asks, accept its terms, then skip signing in or create an account,'
    Note 'on to its main screen: it starts only then, and this carries on by itself.'
  }
  if (-not (Docker-Start $(if ($installed) { 900 } else { 600 }) ($engine -eq ''))) {
    $why = Docker-Why
    Docker-LogTail
    switch ($why) {
      'restart' { Ask-Restart 'Windows needs to restart before Docker Desktop can start.' }
      'docker_virtualisation' { Fail-Virtualisation }
      'docker_install' { Fail 'Docker Desktop is installed, but its docker command was not found.' @('Restart Windows, then run this again. If it says this again, reinstall Docker Desktop.') $why }
      'docker_engine' { Fail 'Docker Desktop is set to Windows containers, and could not be switched to Linux containers.' @("Choose Switch to Linux containers in Docker Desktop's menu (its whale, by the clock), then run this again.") $why }
      'docker_closed' { Fail 'Docker Desktop was closed before it had started.' @('Open Docker Desktop from the Start menu and wait until it says it is running, then run this again.') $why }
      'docker_hypervisor' {
        Fail "Windows' hypervisor is not running, so WSL cannot start Docker Desktop's engine." @(
          'Restart Windows, then run this again. If it says this again, Windows is set not to start',
          'the hypervisor: in PowerShell as administrator, run  bcdedit /set hypervisorlaunchtype auto',
          'and restart. (Some older virtualisation software needs it left off.)') $why
      }
      'docker_terms' { Fail 'Docker Desktop is waiting for its terms to be accepted.' @('Accept them in Docker Desktop, then skip signing in or create an account, and run this again.') $why }
      'docker_server' {
        Fail "Windows' Server service is off, and Docker Desktop needs it." @(
          'In PowerShell as administrator, run:',
          '  Set-Service LanmanServer -StartupType Automatic; Start-Service LanmanServer',
          'then restart Docker Desktop and run this again.') $why
      }
      default {
        Fail 'Docker Desktop has not started.' @(
          'Open Docker Desktop: if it shows an error, its Troubleshoot page (the bug icon) can restart',
          'it. Once it says it is running, run this again, in this window or a new one.') 'docker_start'
      }
    }
  }
}
# Windows PowerShell turns a program's error output into an error of its own
# when it is redirected, so the answer is read inside a try.
$composeOk = $false
try { & docker compose version *> $null; $composeOk = ($LASTEXITCODE -eq 0) } catch {}
if (-not $composeOk) { Fail "Docker Compose v2 is needed (the 'docker compose' command)." @('Update Docker Desktop, then run this again.') 'docker_compose' }
$dv = ''
try { $dv = (& docker version --format '{{.Server.Version}}' 2>$null) } catch {}
Step ("Docker " + $(if ($dv) { "$dv " } else { '' }) + 'is ready')

# -- Download -----------------------------------------------------------------
$S.Stage = 'download'
$update = Test-Path (Join-Path $Dir '.env')
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('pental-report-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$url = "https://github.com/$Repo/archive/refs/tags/v$Version.zip"
$zip = Join-Path $tmp 'report.zip'
$got = $false
for ($n = 1; $n -le 3 -and -not $got; $n++) {
  $got = Get-Download $url $zip "Downloading Pental Report $Version" 600
  if (-not $got -and $n -lt 3) { Add-Content -Path $Log -Value "Trying again ($($n + 1) of 3)."; Start-Sleep -Seconds (5 * $n) }
}
if (-not $got) { Fail "Pental Report $Version could not be downloaded." @("From $url", 'Check this computer can reach github.com, then try again.') }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'docker-compose.yml'))) { Fail 'That download was not a Pental Report release.' @("From $url") }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# The app's own files are replaced whole; .env and anything else of yours stay.
foreach ($d in 'server', 'web', 'db') { $p = Join-Path $Dir $d; if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
Copy-Item -Path (Join-Path $src.FullName '*') -Destination $Dir -Recurse -Force
Get-ChildItem -Path $src.FullName -Force -Filter '.*' | Copy-Item -Destination $Dir -Recurse -Force
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Step "Pental Report $Version is in $Dir"
Set-Location $Dir

# -- Settings -----------------------------------------------------------------
$S.Stage = 'settings'
if (-not $update) {
  $mode = ''
  if ($Domain) { $mode = 'domain' } elseif ($Tailscale) { $mode = 'tailscale' } elseif ($Local) { $mode = 'local' }
  if (-not $mode) {
    Write-Host ''
    Write-Host '  Where will your team open it?'
    Write-Host '    ' -NoNewline; Write-Host '1' -ForegroundColor Red -NoNewline; Write-Host '  On this computer, to try it'
    Write-Host '    ' -NoNewline; Write-Host '2' -ForegroundColor Red -NoNewline; Write-Host '  On your Tailscale network: your team opens it from their own computers, privately'
    Write-Host '    ' -NoNewline; Write-Host '3' -ForegroundColor Red -NoNewline; Write-Host '  On a domain of yours over HTTPS, such as reports.yourfirm.com'
    $choice = Ask 'Choose 1, 2 or 3 [1]' '1'
    $mode = $(if ($choice -like '2*') { 'tailscale' } elseif ($choice -like '3*') { 'domain' } else { 'local' })
    Write-Host ''
  }
  if ($mode -eq 'tailscale') { $Tailscale = $true }
  if ($mode -eq 'domain') {
    if (-not $Domain) { $Domain = Ask 'Domain name' '' }
    $Domain = ($Domain -replace '\s', '') -replace '^https?://', '' -replace '/.*$', ''
    if ($Domain -notmatch '\.') { Fail "That is not a domain name: '$Domain'." @('Give one such as reports.yourfirm.com, or choose this computer.') }
    foreach ($p in 80, 443) { if (Port-Busy $p) { Warn "Port $p is already in use here, and Caddy needs it to serve $Domain." } }
    try { [System.Net.Dns]::GetHostAddresses($Domain) | Out-Null } catch { Warn "$Domain does not resolve yet. Point it at this server: its certificate is fetched once it does." }
  } else { $Domain = '' }
  $port = 8080
  while (Port-Busy $port) { $port++ }
  if ($port -ne 8080) { Note "Port 8080 is in use, so it listens on $port" }
  if ($Domain) { $addr = "https://$Domain"; $profiles = 'https'; $trust = '1' } else { $addr = "http://localhost:$port"; $profiles = ''; $trust = 'false' }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ')
  $lines = @(
    "# Pental Report, made by its installer on $stamp.",
    '# These are the keys to your reports. Keep this file, keep it private, and',
    '# back it up with the database: without VAULT_KEY a backup cannot be opened.',
    '',
    "POSTGRES_PASSWORD=$(New-Secret 32)",
    "REPORT_DB_PASSWORD=$(New-Secret 32)",
    "JWT_SECRET=$(New-Secret 48)",
    "VAULT_KEY=$(New-Secret 32)",
    "SETUP_TOKEN=prs_$(New-Secret 24)",
    '',
    "PUBLIC_URL=$addr",
    "DOMAIN=$Domain",
    "COMPOSE_PROFILES=$profiles",
    "TRUST_PROXY=$trust",
    "PORT=$port",
    '',
    '# See .env.example for everything else you can set here (file storage in an',
    '# S3 bucket, upload size).'
  )
  [System.IO.File]::WriteAllLines((Join-Path $Dir '.env'), [string[]]$lines, (New-Object System.Text.UTF8Encoding $false))
  Step "Settings made, with new secrets, in $Dir\.env"
} else {
  Step "Your settings are kept ($Dir\.env)"
}
Env-Set 'REPORT_VERSION' $Version
# What Pental Report is told of this computer, so the app gives the exact
# command that updates it when a release is out. Forward slashes, which
# PowerShell takes in a path, so .env reads it as written.
Env-Set 'REPORT_HOST' 'windows'
Env-Set 'REPORT_DIR' ($Dir -replace '\\', '/')
# This install's random ID, kept; and not counted, kept so for the app too.
if ((Env-Get 'INSTALL_ID') -ne $InstallId) { Env-Set 'INSTALL_ID' $InstallId }
if ($OffNow) { Env-Set 'TELEMETRY' 'off' }
$port = Env-Get 'PORT'; if (-not $port) { $port = '8080' }
$Domain = Env-Get 'DOMAIN'
$addr = Env-Get 'PUBLIC_URL'; if (-not $addr) { $addr = "http://localhost:$port" }
# Shared over Tailscale before, or asked for now (an install made for this
# computer alone can be shared with -Tailscale later, the same way).
$share = [bool]$Tailscale -or ((Env-Get 'TAILSCALE') -eq '1')
if ($share -and $Domain) { Fail "This Pental Report is served at https://$Domain already." @('Tailscale is for one without a domain of its own.') }

# -- Start --------------------------------------------------------------------
$S.Stage = 'start'
if ($Domain) {
  if (-not (Run-Again 'Fetching PostgreSQL and Caddy' 'docker' @('compose', 'pull', '--quiet', 'db', 'caddy'))) { Fail 'PostgreSQL and Caddy could not be fetched.' @('Check this computer can reach Docker Hub, then try again.') }
} else {
  if (-not (Run-Again 'Fetching PostgreSQL' 'docker' @('compose', 'pull', '--quiet', 'db'))) { Fail 'PostgreSQL could not be fetched.' @('Check this computer can reach Docker Hub, then try again.') }
}
Step $(if ($Domain) { 'PostgreSQL and Caddy fetched' } else { 'PostgreSQL fetched' })
if (Run-Again "Fetching Pental Report $Version" 'docker' @('pull', '--quiet', "${Image}:$Version")) {
  Step "Pental Report $Version fetched"
} else {
  if (-not (Run "Building Pental Report $Version from its source" 'docker' @('compose', 'build', 'report'))) { Fail 'Pental Report could not be built.' }
  Step "Pental Report $Version built"
}
if (-not (Run 'Starting it' 'docker' @('compose', 'up', '-d', '--no-build', '--remove-orphans'))) { Fail 'Pental Report could not be started.' }
$answers = { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/health").StatusCode -eq 200 } catch { $false } }
if (-not (Wait-Until 'Waiting for it to answer' $answers 300)) {
  Fail "Pental Report did not answer on port $port." @("See what it is doing: cd `"$Dir`"; docker compose logs --tail 50 report")
}
Step 'Pental Report is running'

# -- Your team, over Tailscale --------------------------------------------------
# Tailscale's own HTTPS proxy (tailscale serve) shares the app with your
# tailnet at this computer's name there, with a certificate Tailscale issues:
# nothing is opened to the internet, and there is no domain to set up. The
# app stays listening on this computer alone; the address the team uses is
# PUBLIC_URL (the links Pental Report hands out, and security keys, are made
# for it), and Tailscale's proxy is the one in front (TRUST_PROXY=1).
if ($share) {
  $S.Stage = 'tailscale'
  $ts = $null
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { $ts = $cmd.Source } else {
    $p = Join-Path $Env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path $p) { $ts = $p }
  }
  if (-not $ts) {
    Warn 'Tailscale is not installed.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      $want = Ask 'Install it now with winget? [Y/n]' 'y'
      if ($want -notmatch '^[nN]') {
        if (-not (Run 'Installing Tailscale' 'winget' @('install', '-e', '--id', 'Tailscale.Tailscale', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'))) {
          Fail 'Tailscale could not be installed.' @('Install it from https://tailscale.com/download/windows, then run this again.')
        }
        Step 'Tailscale installed'
        Fail 'Open Tailscale from the Start menu and sign in, then run this installer again.' @('Pental Report is already running here; this shares it with your team.')
      }
    }
    Fail 'Sharing with your team over Tailscale needs Tailscale.' @('Install it from https://tailscale.com/download/windows and sign in, then run this again.')
  }
  $tsStatus = { try { (& $ts status --json 2>$null | Out-String) | ConvertFrom-Json } catch { $null } }
  $st = & $tsStatus
  if (-not $st -or $st.BackendState -ne 'Running') {
    Fail 'Tailscale is not signed in.' @('Open Tailscale from the Start menu and sign in, then run this installer again.')
  }
  # 443 unless something else of yours is served there already.
  $tsPort = 443
  $now = ''
  try { $now = (& $ts serve status --json 2>$null | Out-String) } catch {}
  if ($now -match '"443"' -and $now -notmatch [regex]::Escape("127.0.0.1:$port")) { $tsPort = 8443 }
  # In the open, not in the log: the first time, Tailscale may show a link to
  # turn sharing on for the tailnet, and waits until it is.
  Note 'Sharing it on your tailnet. If Tailscale shows a link to turn on HTTPS, open it and say yes.'
  $served = $false
  try { & $ts serve --bg "--https=$tsPort" "http://127.0.0.1:$port"; $served = ($LASTEXITCODE -eq 0) } catch {}
  if (-not $served) {
    Fail 'Tailscale could not share it.' @("Turn on HTTPS for your tailnet (Tailscale's admin console, DNS, HTTPS Certificates),", 'then run this installer again with -Tailscale. If it says access is denied, run PowerShell as administrator.')
  }
  $st = & $tsStatus
  $name = ''
  if ($st -and $st.Self) { $name = ([string]$st.Self.DNSName).TrimEnd('.') }
  if (-not $name) { Fail "Tailscale did not say this computer's name on your tailnet." @('Check Tailscale is signed in, then run this again.') }
  $addr = "https://$name"; if ($tsPort -ne 443) { $addr = "${addr}:$tsPort" }
  if ((Env-Get 'PUBLIC_URL') -ne $addr -or (Env-Get 'TRUST_PROXY') -ne '1' -or (Env-Get 'TAILSCALE') -ne '1') {
    Env-Set 'PUBLIC_URL' $addr; Env-Set 'TRUST_PROXY' '1'; Env-Set 'TAILSCALE' '1'
    if (-not (Run "Restarting it at $addr" 'docker' @('compose', 'up', '-d', '--no-build', 'report'))) { Fail 'Pental Report could not be restarted.' }
    if (-not (Wait-Until 'Waiting for it to answer' $answers 300)) {
      Fail "Pental Report did not answer on port $port." @("See what it is doing: cd `"$Dir`"; docker compose logs --tail 50 report")
    }
  }
  Step "Shared with your tailnet at $addr"
}

$first = $false
try { $first = ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$port/reporter/v1/config").Content -match '"first_run":true') } catch {}
$token = Env-Get 'SETUP_TOKEN'

# -- Done ---------------------------------------------------------------------
$S.Stage = 'done'
# What carried the install over a restart is not needed now.
foreach ($f in $CarryFile, $IdFile) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
if ((Test-Path $CarryDir) -and -not (Get-ChildItem -LiteralPath $CarryDir -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $CarryDir -Force -ErrorAction SilentlyContinue }
$rule = $H * 60
function BarLine([string]$label, [string]$value) {
  Write-Host "  $Bar  " -ForegroundColor DarkGray -NoNewline
  if ($label) { Write-Host $label.PadRight(13) -ForegroundColor DarkGray -NoNewline; Write-Host $value }
  else { Write-Host $value -ForegroundColor DarkGray }
}
Write-Host ''
Write-Host "  $Top$rule" -ForegroundColor DarkGray
Write-Host "  $Bar  " -ForegroundColor DarkGray -NoNewline
if ($update) { Write-Host "Pental Report is updated to $Version." } else { Write-Host 'Pental Report is installed.' }
BarLine '' ''
BarLine 'Open' $addr
if ($first) {
  BarLine 'Setup code' $token
  BarLine '' ''
  BarLine '' 'The setup code makes you its first administrator. It is also'
  BarLine '' "SETUP_TOKEN in $Dir\.env."
}
if ($Domain) {
  BarLine '' ''
  BarLine '' "$Domain must point at this computer, with ports 80 and 443 open:"
  BarLine '' 'its certificate is fetched the first time it is opened.'
}
if ($share) {
  BarLine '' ''
  BarLine '' 'Your team opens it at that address from their own computers,'
  BarLine '' "once they are on your tailnet (Tailscale's admin console, Users)."
  BarLine '' 'Nothing is open to the internet. Keep this computer on.'
}
Write-Host "  $Bot$rule" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Lives in  ' -ForegroundColor DarkGray -NoNewline; Write-Host $Dir
Write-Host '  Logs      ' -ForegroundColor DarkGray -NoNewline; Write-Host "cd `"$Dir`"; docker compose logs -f report"
Write-Host '  Stop      ' -ForegroundColor DarkGray -NoNewline; Write-Host "cd `"$Dir`"; docker compose stop"
Write-Host '  Update    ' -ForegroundColor DarkGray -NoNewline; Write-Host 'run this installer again'
if ($Counting) {
  Write-Host '  Counting  ' -ForegroundColor DarkGray -NoNewline; Write-Host 'pental.io counts installs and running copies by a random ID, with'
  Write-Host '            the version and system only. TELEMETRY=off in .env turns it off.'
} else {
  Write-Host '  Counting  ' -ForegroundColor DarkGray -NoNewline; Write-Host 'off (TELEMETRY=off in .env)'
}
Write-Host ''
Remove-Item $Log -ErrorAction SilentlyContinue

if (-not $NoOpen -and $first -and -not $Domain) {
  # The setup code after a #, so the first-run page fills it in. A # part is
  # never sent to the server, and the page takes it off the address at once.
  Start-Process "$addr/#setup=$token"
}
# Last, so nothing above waits on it.
Send-Count $(if ($update) { 'updated' } else { 'installed' })
} catch {
  # Fail has said what went wrong; anything else is said here, plainly,
  # rather than as PowerShell's own error block.
  if ($_.Exception.Message -ne $Stop) {
    Write-Host ''
    Write-Host '  ' -NoNewline; Write-Host $Cross -ForegroundColor Red -NoNewline; Write-Host ' Something unexpected stopped the installer:'
    Write-Host ('    ' + $_.Exception.Message)
    Write-Host "    Its log: $Log" -ForegroundColor DarkGray
    Write-Host ''
    Send-Count 'failed'
  }
} finally {
  try { [Console]::OutputEncoding = $prevEnc } catch {}
}
} @args
