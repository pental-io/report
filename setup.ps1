# Makes .env for Pental Report on Windows: new secrets, and the address your
# team will use. The installer runs it for you; by hand, run it once in
# PowerShell, then `docker compose up -d`.
#
#   .\setup.ps1                                asks for a domain
#   .\setup.ps1 -Domain reports.yourfirm.com
#   .\setup.ps1 -Domain ''                     this machine only, http://localhost:8080
#   .\setup.ps1 -Domain '' -Port 8090          the same, on another port
#
# SPDX-License-Identifier: AGPL-3.0-only
param([string]$Domain = $null, [int]$Port = 8080, [switch]$Quiet)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (Test-Path .env) {
  Write-Host ".env already exists, so nothing was changed. Its secrets protect the data"
  Write-Host "already in your database: keep it. To start again from nothing, remove"
  Write-Host "both .env and the database (docker compose down -v) first."
  exit 1
}

function New-Secret([int]$Bytes) {
  $b = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# A [string] parameter is never $null, so whether one was given is asked of
# the parameters themselves.
if (-not $PSBoundParameters.ContainsKey('Domain')) {
  $Domain = Read-Host 'Domain for HTTPS, such as reports.yourfirm.com (leave blank to use it on this machine only)'
}
$Domain = ($Domain -replace '\s', '') -replace '^https?://', '' -replace '/.*$', ''

if ($Domain) { $Url = "https://$Domain"; $Profiles = 'https'; $Trust = '1' }
else { $Url = "http://localhost:$Port"; $Profiles = ''; $Trust = 'false' }
$Token = 'prs_' + (New-Secret 24)
$Stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ')

$lines = @(
  "# Pental Report, made by setup.ps1 on $Stamp.",
  '# These are the keys to your reports. Keep this file, keep it private, and',
  '# back it up with the database: without VAULT_KEY a backup cannot be opened.',
  '',
  "POSTGRES_PASSWORD=$(New-Secret 32)",
  "REPORT_DB_PASSWORD=$(New-Secret 32)",
  "JWT_SECRET=$(New-Secret 48)",
  "VAULT_KEY=$(New-Secret 32)",
  "SETUP_TOKEN=$Token",
  '',
  "PUBLIC_URL=$Url",
  "DOMAIN=$Domain",
  "COMPOSE_PROFILES=$Profiles",
  "TRUST_PROXY=$Trust",
  "PORT=$Port",
  '',
  '# See .env.example for everything else you can set here (file storage in an',
  '# S3 bucket, upload size).'
)
# UTF-8 without a byte order mark, which docker compose reads cleanly.
[System.IO.File]::WriteAllLines((Join-Path $PSScriptRoot '.env'), $lines, (New-Object System.Text.UTF8Encoding $false))
if ($Quiet) { exit 0 }

Write-Host ''
Write-Host 'Made .env.'
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. docker compose up -d'
if ($Domain) {
  Write-Host "     ($Domain must point at this machine, with ports 80 and 443 open,"
  Write-Host '     for the certificate to be issued.)'
}
Write-Host "  2. Open $Url"
Write-Host '  3. Enter this setup token to make the first administrator:'
Write-Host ''
Write-Host "     $Token"
Write-Host ''
Write-Host 'It is also in .env (SETUP_TOKEN), and is only asked for once.'
