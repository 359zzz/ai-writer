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
$existingApi = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingApi) {
  $existingPid = $existingApi.OwningProcess
  Write-Host "[dev] WARNING: Port 8000 is already in use (PID=$existingPid). Stop it first to avoid running an old API."
  try {
    $existingProc = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid"
    if ($existingProc -and $existingProc.CommandLine) {
      Write-Host "[dev] Existing process: $($existingProc.CommandLine)"
    }
  } catch {
    # ignore
  }
}
Start-Process -FilePath "powershell" -WorkingDirectory $apiDir -ArgumentList @(
  "-NoExit",
  "-Command",
  # IMPORTANT:
  # Uvicorn --reload may spawn child processes. Always use the venv's python.exe
  # to avoid accidentally starting the API with another Python from PATH.
  "& '$pythonExe' -m uvicorn ai_writer_api.main:app --reload --host 0.0.0.0 --port 8000"
)

Write-Host "[dev] Starting Web on http://localhost:3000"
Start-Process -FilePath "powershell" -WorkingDirectory $webDir -ArgumentList @(
  "-NoExit",
  "-Command",
  "npm run dev -- --port 3000"
)

Write-Host "[dev] Started. Close the two spawned terminals to stop."
