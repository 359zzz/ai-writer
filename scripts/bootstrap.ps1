Param(
  [switch]$SkipFrontend,
  [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $SkipBackend) {
  Write-Host "[bootstrap] Backend (Python 3.11 venv + deps)"
  $apiDir = Join-Path $RepoRoot "apps\\api"
  $venvDir = Join-Path $apiDir ".venv"
  $pythonExe = Join-Path $venvDir "Scripts\\python.exe"

  if (-not (Test-Path -LiteralPath $pythonExe)) {
    & py -3.11 -m venv $venvDir
  }

  & $pythonExe -m pip install --upgrade pip | Out-Null
  & $pythonExe -m pip install -r (Join-Path $apiDir "requirements.txt")
}

if (-not $SkipFrontend) {
  Write-Host "[bootstrap] Frontend (npm install)"
  $webDir = Join-Path $RepoRoot "apps\\web"
  if (-not (Test-Path -LiteralPath (Join-Path $webDir "package.json"))) {
    throw "Frontend not initialized yet: missing apps/web/package.json"
  }
  Push-Location $webDir
  try {
    npm install
  } finally {
    Pop-Location
  }
}

Write-Host "[bootstrap] Done."

