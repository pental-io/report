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
#
# Copyright (c) Pental Limited.
# SPDX-License-Identifier: AGPL-3.0-only

& {
param(
  [string]$Domain = '',
  [switch]$Local,
  [switch]$Tailscale,
  [string]$Dir = '',
  [string]$Version = '0.1.8',
  [switch]$Yes,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times faster without its bar
# GitHub and Docker Hub take TLS 1.2 or later, which Windows PowerShell 5.1 does not always offer by itself.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Stop = 'Pental Report was not installed.'

$Repo = 'pental-io/report'
$Image = 'ghcr.io/pental-io/report'
$Version = $Version.TrimStart('v')
if (-not $Dir) { $Dir = Join-Path $HOME 'pental-report' }
$Log = Join-Path ([System.IO.Path]::GetTempPath()) 'pental-report-install.log'
Set-Content -Path $Log -Value '' -Encoding UTF8

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
function Fail([string]$t, [string[]]$more = @()) {
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
  throw $Stop
}
function Ask([string]$q, [string]$default) {
  if ($Yes) { return $default }
  Write-Host '  ' -NoNewline; Write-Host $Arrow -ForegroundColor Red -NoNewline
  $a = Read-Host " $q"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}
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
  $p.WaitForExit()
  Write-Host ("`r" + (' ' * ($label.Length + 6)) + "`r") -NoNewline
  Get-Content $out, $err -ErrorAction SilentlyContinue | Add-Content -Path $Log
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  return ($p.ExitCode -eq 0)
}
function Wait-Until([string]$label, [scriptblock]$ok, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds); $i = 0
  while ((Get-Date) -lt $deadline) {
    if (& $ok) { Write-Host ("`r" + (' ' * ($label.Length + 6)) + "`r") -NoNewline; return $true }
    for ($k = 0; $k -lt 10; $k++) {
      Write-Host ("`r  " + $Frames[$i % $Frames.Length]) -ForegroundColor Red -NoNewline
      Write-Host " $label" -NoNewline
      Start-Sleep -Milliseconds 100; $i++
    }
  }
  Write-Host ("`r" + (' ' * ($label.Length + 6)) + "`r") -NoNewline
  return $false
}
function Docker-Ok { try { & docker info *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false } }
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

try {
Write-Host ''
Write-Host '  ' -NoNewline; Write-Host 'PENTAL' -ForegroundColor Red -NoNewline; Write-Host '  Report' -NoNewline; Write-Host "  $Version" -ForegroundColor DarkGray
Write-Host '  Free, open-source penetration test reporting, on your own server.' -ForegroundColor DarkGray
Write-Host ''

# -- Docker -------------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Warn 'Docker Desktop is not installed.'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $want = Ask 'Install it now with winget? [Y/n]' 'y'
    if ($want -notmatch '^[nN]') {
      if (-not (Run 'Installing Docker Desktop' 'winget' @('install', '-e', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements'))) {
        Fail 'Docker Desktop could not be installed.' @('Install it from https://www.docker.com/products/docker-desktop/, then run this again.')
      }
      Step 'Docker Desktop installed'
      Fail 'Open Docker Desktop once to finish setting it up, then run this installer again.' @('(Windows may ask you to restart first.)')
    }
  }
  Fail 'Pental Report runs in Docker.' @('Install Docker Desktop from https://www.docker.com/products/docker-desktop/,', 'open it once, then run this installer again.')
}
if (-not (Docker-Ok)) {
  $dd = Join-Path $Env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) { Start-Process -FilePath $dd | Out-Null }
  if (-not (Wait-Until 'Starting Docker Desktop' { Docker-Ok } 180)) {
    Fail 'Docker Desktop is not running.' @('Open Docker Desktop, wait until it says it is running, then run this again.')
  }
}
# Windows PowerShell turns a program's error output into an error of its own
# when it is redirected, so the answer is read inside a try.
$composeOk = $false
try { & docker compose version *> $null; $composeOk = ($LASTEXITCODE -eq 0) } catch {}
if (-not $composeOk) { Fail "Docker Compose v2 is needed (the 'docker compose' command)." @('Update Docker Desktop, then run this again.') }
$dv = ''
try { $dv = (& docker version --format '{{.Server.Version}}' 2>$null) } catch {}
Step ("Docker " + $(if ($dv) { "$dv " } else { '' }) + 'is ready')

# -- Download -----------------------------------------------------------------
$update = Test-Path (Join-Path $Dir '.env')
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('pental-report-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$url = "https://github.com/$Repo/archive/refs/tags/v$Version.zip"
$zip = Join-Path $tmp 'report.zip'
$wc = New-Object System.Net.WebClient
$dl = $wc.DownloadFileTaskAsync($url, $zip)
$null = Wait-Until "Downloading Pental Report $Version" { $dl.IsCompleted } 600
if (-not $dl.IsCompleted -or $dl.IsFaulted) {
  if ($dl.Exception) { Add-Content -Path $Log -Value $dl.Exception.GetBaseException().Message }
  Fail "Pental Report $Version could not be downloaded." @("From $url", 'Check this computer can reach github.com, then try again.')
}
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
$port = Env-Get 'PORT'; if (-not $port) { $port = '8080' }
$Domain = Env-Get 'DOMAIN'
$addr = Env-Get 'PUBLIC_URL'; if (-not $addr) { $addr = "http://localhost:$port" }
# Shared over Tailscale before, or asked for now (an install made for this
# computer alone can be shared with -Tailscale later, the same way).
$share = [bool]$Tailscale -or ((Env-Get 'TAILSCALE') -eq '1')
if ($share -and $Domain) { Fail "This Pental Report is served at https://$Domain already." @('Tailscale is for one without a domain of its own.') }

# -- Start --------------------------------------------------------------------
if ($Domain) {
  if (-not (Run 'Fetching PostgreSQL and Caddy' 'docker' @('compose', 'pull', '--quiet', 'db', 'caddy'))) { Fail 'PostgreSQL and Caddy could not be fetched.' @('Check this computer can reach Docker Hub, then try again.') }
} else {
  if (-not (Run 'Fetching PostgreSQL' 'docker' @('compose', 'pull', '--quiet', 'db'))) { Fail 'PostgreSQL could not be fetched.' @('Check this computer can reach Docker Hub, then try again.') }
}
Step $(if ($Domain) { 'PostgreSQL and Caddy fetched' } else { 'PostgreSQL fetched' })
if (Run "Fetching Pental Report $Version" 'docker' @('pull', '--quiet', "${Image}:$Version")) {
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
        if (-not (Run 'Installing Tailscale' 'winget' @('install', '-e', '--id', 'Tailscale.Tailscale', '--accept-package-agreements', '--accept-source-agreements'))) {
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
Write-Host ''
Remove-Item $Log -ErrorAction SilentlyContinue

if (-not $NoOpen -and $first -and -not $Domain) {
  # The setup code after a #, so the first-run page fills it in. A # part is
  # never sent to the server, and the page takes it off the address at once.
  Start-Process "$addr/#setup=$token"
}
} catch {
  # Fail has said what went wrong; anything else is said here, plainly,
  # rather than as PowerShell's own error block.
  if ($_.Exception.Message -ne $Stop) {
    Write-Host ''
    Write-Host '  ' -NoNewline; Write-Host $Cross -ForegroundColor Red -NoNewline; Write-Host ' Something unexpected stopped the installer:'
    Write-Host ('    ' + $_.Exception.Message)
    Write-Host "    Its log: $Log" -ForegroundColor DarkGray
    Write-Host ''
  }
} finally {
  try { [Console]::OutputEncoding = $prevEnc } catch {}
}
} @args
