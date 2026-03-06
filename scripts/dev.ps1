Param(
  [switch]$SkipInstall,
  [switch]$NoAutoKill,
  [switch]$ForceKill
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

function Get-ListeningPids([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $conns) { return @() }
  return @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Try-GetCommandLine([int]$ProcessId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine) { return [string]$p.CommandLine }
  } catch {
    # ignore
  }
  return $null
}

function Test-AiWriterApiHealth([int]$Port) {
  $url = "http://127.0.0.1:$Port/api/health"
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1
    if (-not $res -or -not $res.Content) { return $null }
    $obj = $res.Content | ConvertFrom-Json -ErrorAction Stop
    if ($obj -and $obj.service -eq "ai-writer-api") { return $obj }
  } catch {
    # ignore
  }
  return $null
}

function Kill-ListenerOnPort(
  [int]$Port,
  [string]$Label,
  [string]$HealthService = $null,
  [string]$CommandLineRegex = $null
) {
  $pids = Get-ListeningPids -Port $Port
  if (-not $pids -or $pids.Count -eq 0) { return $true }

  $health = $null
  if ($HealthService) {
    $health = Test-AiWriterApiHealth -Port $Port
  }

  $matchedCmd = $false
  if ($CommandLineRegex) {
    foreach ($p in $pids) {
      $cmd = Try-GetCommandLine -ProcessId $p
      if ($cmd -and ($cmd -match $CommandLineRegex)) {
        $matchedCmd = $true
        break
      }
    }
  }

  $isKnownOccupant = $false
  if ($HealthService) {
    $isKnownOccupant = [bool]($health -and $health.service -eq $HealthService)
  }
  if (-not $isKnownOccupant -and $matchedCmd) {
    $isKnownOccupant = $true
  }

  if ($isKnownOccupant) {
    if ($health -and $health.version) {
      Write-Host "[dev] $Label already running on port $Port (version=$($health.version)). Auto-stopping old process..."
    } else {
      Write-Host "[dev] $Label already running on port $Port. Auto-stopping old process..."
    }
  } else {
    Write-Host "[dev] WARNING: Port $Port is in use, and the listener doesn't look like our $Label."
    foreach ($p in $pids) {
      $cmd = Try-GetCommandLine -ProcessId $p
      if ($cmd) { Write-Host "[dev] Port $Port PID=${p}: $cmd" } else { Write-Host "[dev] Port $Port PID=${p}" }
    }
    if ($ForceKill) {
      Write-Host "[dev] ForceKill enabled. Attempting to stop the listener anyway..."
    } else {
      Write-Host "[dev] Tip: re-run with -ForceKill if you really want to kill the occupant automatically."
      return $false
    }
  }

  foreach ($p in $pids) {
    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { }
  }

  Start-Sleep -Milliseconds 400
  if ((Get-ListeningPids -Port $Port).Count -eq 0) { return $true }

  # Uvicorn --reload on Windows may leave an orphan worker whose command line is
  # "spawn_main(parent_pid=...)" even if the parent PID is already gone.
  foreach ($parent in $pids) {
    try {
      $orphans = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "parent_pid=$parent" } |
        Select-Object -ExpandProperty ProcessId
      foreach ($op in $orphans) {
        try { Stop-Process -Id $op -Force -ErrorAction SilentlyContinue } catch { }
      }
    } catch {
      # ignore
    }
  }

  Start-Sleep -Milliseconds 400
  return ((Get-ListeningPids -Port $Port).Count -eq 0)
}

Write-Host "[dev] Starting API on http://localhost:8000"
if (-not $NoAutoKill) {
  $killed = Kill-ListenerOnPort -Port 8000 -Label "API" -HealthService "ai-writer-api" -CommandLineRegex "ai_writer_api\.main:app|uvicorn"
  if (-not $killed) {
    Write-Host "[dev] Port 8000 is still occupied. API may fail to start."
  }
} else {
  $existingApi = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existingApi) {
    $existingPid = $existingApi.OwningProcess
    Write-Host "[dev] WARNING: Port 8000 is already in use (PID=$existingPid). Stop it first to avoid running an old API."
    $cmd = Try-GetCommandLine -ProcessId $existingPid
    if ($cmd) { Write-Host "[dev] Existing process: $cmd" }
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

Start-Sleep -Milliseconds 900
$apiHealth = Test-AiWriterApiHealth -Port 8000
if (-not $apiHealth) {
  Write-Host "[dev] WARNING: API didn't become healthy on port 8000. Check the spawned API terminal for startup errors.";
}

Write-Host "[dev] Starting Web on http://localhost:3000"
if (-not $NoAutoKill) {
  $killedWeb = Kill-ListenerOnPort -Port 3000 -Label "Web" -CommandLineRegex "(next(\.cmd)?\s+dev|next\\\dist\\\bin\\\next.*\sdev|--port\s+3000|-p\s+3000)"
  if (-not $killedWeb) {
    Write-Host "[dev] Port 3000 is still occupied. Web may fail to start."
  }
}
Start-Process -FilePath "powershell" -WorkingDirectory $webDir -ArgumentList @(
  "-NoExit",
  "-Command",
  "npm run dev -- --port 3000"
)

Start-Sleep -Milliseconds 900
try {
  $res = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000" -TimeoutSec 1
  if (-not $res) { throw "empty" }
} catch {
  Write-Host "[dev] WARNING: Web didn't respond on port 3000 yet. Check the spawned Web terminal for startup errors.";
}

Write-Host "[dev] Started. Close the two spawned terminals to stop."
