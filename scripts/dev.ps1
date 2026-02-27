Param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $SkipInstall) {
  & (Join-Path $PSScriptRoot "bootstrap.ps1")
}

$apiDir = Join-Path $RepoRoot "apps\\api"
$webDir = Join-Path $RepoRoot "apps\\web"
$pythonExe = Join-Path $apiDir ".venv\\Scripts\\python.exe"
$activateVenv = Join-Path $apiDir ".venv\\Scripts\\Activate.ps1"

if (-not (Test-Path -LiteralPath $pythonExe)) {
  throw "Backend venv missing. Run scripts/bootstrap.ps1 first."
}

Write-Host "[dev] Starting API on http://localhost:8000"
Start-Process -FilePath "powershell" -WorkingDirectory $apiDir -ArgumentList @(
  "-NoExit",
  "-Command",
  # IMPORTANT:
  # Uvicorn --reload may spawn a child process. If we don't activate the venv,
  # the child may accidentally use the system Python from PATH, causing version
  # mismatches (e.g. missing new endpoints).
  "& '$activateVenv'; python -m uvicorn ai_writer_api.main:app --reload --host 0.0.0.0 --port 8000"
)

Write-Host "[dev] Starting Web on http://localhost:3000"
Start-Process -FilePath "powershell" -WorkingDirectory $webDir -ArgumentList @(
  "-NoExit",
  "-Command",
  "npm run dev -- --port 3000"
)

Write-Host "[dev] Started. Close the two spawned terminals to stop."
