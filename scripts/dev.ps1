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

if (-not (Test-Path -LiteralPath $pythonExe)) {
  throw "Backend venv missing. Run scripts/bootstrap.ps1 first."
}

Write-Host "[dev] Starting API on http://localhost:8000"
Start-Process -FilePath "powershell" -WorkingDirectory $apiDir -ArgumentList @(
  "-NoExit",
  "-Command",
  "$pythonExe -m uvicorn ai_writer_api.main:app --reload --host 0.0.0.0 --port 8000"
)

Write-Host "[dev] Starting Web on http://localhost:3000"
Start-Process -FilePath "powershell" -WorkingDirectory $webDir -ArgumentList @(
  "-NoExit",
  "-Command",
  "npm run dev -- --port 3000"
)

Write-Host "[dev] Started. Close the two spawned terminals to stop."

