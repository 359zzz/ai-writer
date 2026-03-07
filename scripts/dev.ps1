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

function Get-ProcessInfo([int]$ProcessId) {
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
}

function Get-ProcessLineage([int]$ProcessId, [int]$MaxDepth = 8) {
  $items = @()
  $seen = @{}
  $currentId = $ProcessId
  for ($i = 0; $i -lt $MaxDepth -and $currentId -gt 0; $i++) {
    if ($seen.ContainsKey($currentId)) { break }
    $seen[$currentId] = $true
    $proc = Get-ProcessInfo -ProcessId $currentId
    if (-not $proc) { break }
    $items += $proc
    $parentId = [int]$proc.ParentProcessId
    if ($parentId -le 0 -or $parentId -eq $currentId) { break }
    $currentId = $parentId
  }
  return @($items)
}

function Get-LineageMatchedPids([int[]]$ProcessIds, [string]$CommandLineRegex) {
  if (-not $CommandLineRegex) { return @() }
  $matched = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($procId in $ProcessIds) {
    foreach ($proc in (Get-ProcessLineage -ProcessId $procId -MaxDepth 12)) {
      if ($proc.CommandLine -and ($proc.CommandLine -match $CommandLineRegex)) {
        [void]$matched.Add([int]$proc.ProcessId)
      }
    }
  }
  return @($matched)
}

function Stop-ProcessTree([int]$ProcessId) {
  try {
    & taskkill /PID $ProcessId /T /F | Out-Null
    return $true
  } catch {
    # ignore
  }
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    # ignore
  }
  return $false
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

function Wait-ForApiHealth([int]$Port, [int]$TimeoutMs = 12000, [int]$PollMs = 400) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  do {
    $health = Test-AiWriterApiHealth -Port $Port
    if ($health) { return $health }
    Start-Sleep -Milliseconds $PollMs
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Wait-ForUrl([string]$Url, [int]$TimeoutMs = 12000, [int]$PollMs = 400) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  do {
    try {
      $res = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($res) { return $true }
    } catch {
      # ignore
    }
    Start-Sleep -Milliseconds $PollMs
  } while ((Get-Date) -lt $deadline)
  return $false
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

  $matchedCmdPids = @()
  if ($CommandLineRegex) {
    $matchedCmdPids = @(Get-LineageMatchedPids -ProcessIds $pids -CommandLineRegex $CommandLineRegex)
  }
  $matchedCmd = ($matchedCmdPids.Count -gt 0)

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

  $killSet = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($p in $pids) { [void]$killSet.Add([int]$p) }
  foreach ($p in $matchedCmdPids) { [void]$killSet.Add([int]$p) }

  $killRoots = @()
  foreach ($targetPid in @($killSet)) {
    $proc = Get-ProcessInfo -ProcessId $targetPid
    $parentId = 0
    if ($proc) { $parentId = [int]$proc.ParentProcessId }
    if (-not $killSet.Contains($parentId)) {
      $killRoots += $targetPid
    }
  }

  foreach ($rootPid in ($killRoots | Sort-Object -Unique -Descending)) {
    [void](Stop-ProcessTree -ProcessId $rootPid)
  }

  Start-Sleep -Milliseconds 600
  if ((Get-ListeningPids -Port $Port).Count -eq 0) { return $true }

  foreach ($p in (Get-ListeningPids -Port $Port)) {
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
$skipApiStart = $false
if (-not $NoAutoKill) {
  $killed = Kill-ListenerOnPort -Port 8000 -Label "API" -HealthService "ai-writer-api" -CommandLineRegex "ai_writer_api\.main:app|uvicorn"
  if (-not $killed) {
    Write-Host "[dev] Port 8000 is still occupied. Skipping API startup to avoid binding the wrong process."
    $skipApiStart = $true
  }
} else {
  $existingApi = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existingApi) {
    $existingPid = $existingApi.OwningProcess
    Write-Host "[dev] WARNING: Port 8000 is already in use (PID=$existingPid). Stop it first to avoid running an old API."
    $cmd = Try-GetCommandLine -ProcessId $existingPid
    if ($cmd) { Write-Host "[dev] Existing process: $cmd" }
    $skipApiStart = $true
  }
}
if (-not $skipApiStart) {
  Start-Process -FilePath "powershell" -WorkingDirectory $apiDir -ArgumentList @(
    "-NoExit",
    "-Command",
    # IMPORTANT:
    # Uvicorn --reload may spawn child processes. Always use the venv's python.exe
    # to avoid accidentally starting the API with another Python from PATH.
    "& '$pythonExe' -m uvicorn ai_writer_api.main:app --reload --host 0.0.0.0 --port 8000"
  )

  $apiHealth = Wait-ForApiHealth -Port 8000 -TimeoutMs 15000
  if (-not $apiHealth) {
    Write-Host "[dev] WARNING: API didn't become healthy on port 8000 within 15s. Check the spawned API terminal for startup errors.";
  }
}

Write-Host "[dev] Starting Web on http://localhost:3000"
$skipWebStart = $false
if (-not $NoAutoKill) {
  $killedWeb = Kill-ListenerOnPort -Port 3000 -Label "Web" -CommandLineRegex "(start-server\.js|next(\.cmd)?\s+dev|next\\dist\\bin\\next.*\sdev|npm(\.cmd)?\s+run\s+dev|npm-cli\.js.*\srun\s+dev|--port\s+3000|-p\s+3000)"
  if (-not $killedWeb) {
    Write-Host "[dev] Port 3000 is still occupied. Skipping Web startup to avoid EADDRINUSE."
    $skipWebStart = $true
  }
} else {
  $existingWeb = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existingWeb) {
    $existingWebPid = $existingWeb.OwningProcess
    Write-Host "[dev] WARNING: Port 3000 is already in use (PID=$existingWebPid). Stop it first or omit -NoAutoKill."
    $cmd = Try-GetCommandLine -ProcessId $existingWebPid
    if ($cmd) { Write-Host "[dev] Existing process: $cmd" }
    $skipWebStart = $true
  }
}
if (-not $skipWebStart) {
  Start-Process -FilePath "powershell" -WorkingDirectory $webDir -ArgumentList @(
    "-NoExit",
    "-Command",
    "npm run dev -- --port 3000"
  )

  $webReady = Wait-ForUrl -Url "http://127.0.0.1:3000" -TimeoutMs 15000
  if (-not $webReady) {
    Write-Host "[dev] WARNING: Web didn't respond on port 3000 within 15s. Check the spawned Web terminal for startup errors.";
  }
}

Write-Host "[dev] Started. Close the two spawned terminals to stop."
