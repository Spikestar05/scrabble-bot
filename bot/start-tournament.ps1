# Windows launcher for the live bot (PowerShell equivalent of run-live.sh).
# Usage:  .\start-tournament.ps1                 (astronaut, tournament 2)
#         .\start-tournament.ps1 -Name astronaut -Tournament 2
# First run asks for the token from the website's /team page (input hidden);
# after the first connect it is cached in .token-<name> (gitignored).
# Clean stop: create ..\logs\STOP (finishes the current match), or Ctrl-C.
param(
  [string]$Name = "astronaut",
  [string]$Tournament = "2"
)
Set-Location $PSScriptRoot
$logDir = Join-Path $PSScriptRoot "..\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
Remove-Item (Join-Path $logDir "STOP") -ErrorAction SilentlyContinue
$log = Join-Path $logDir "live-$Name.log"

$env:BOT_NAME = $Name
if ($Tournament) { $env:TOURNAMENT_ID = $Tournament } else { Remove-Item Env:TOURNAMENT_ID -ErrorAction SilentlyContinue }

$tokenFile = Join-Path $PSScriptRoot ".token-$Name"
if (-not (Test-Path $tokenFile) -and -not $env:BOT_TOKEN) {
  $sec = Read-Host "Paste the bot token from /team (hidden)" -AsSecureString
  $env:BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

Write-Host "Starting bot '$Name' (tournament: $Tournament). Log: $log"
while ($true) {
  npx tsx src/index.ts 2>&1 | Tee-Object -FilePath $log -Append
  "$(Get-Date -Format o) bot exited with $LASTEXITCODE; restarting in 3s" | Tee-Object -FilePath $log -Append
  if (Test-Path (Join-Path $logDir "STOP")) { "STOP file found; exiting" | Tee-Object -FilePath $log -Append; break }
  if (Test-Path $tokenFile) { Remove-Item Env:BOT_TOKEN -ErrorAction SilentlyContinue }
  Start-Sleep 3
}
