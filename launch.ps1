# PowerShell OCG PIPELINE launcher
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Starting OCG PIPELINE Launcher..." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

# Always operate relative to the repository, never the caller's working directory.
Set-Location $PSScriptRoot

# 0. Load local .env into this process so Node inherits PIPELINE configuration.
# Secrets are never printed. Existing process environment values are overwritten
# only by keys explicitly present in the local .env file.
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            if ($value.Length -ge 2) { $value = $value.Substring(1, $value.Length - 2) }
        }
        if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
    Write-Host "[INFO] Loaded local environment configuration from .env." -ForegroundColor DarkGray
} else {
    Write-Host "[INFO] No .env file found. PIPELINE will use safe defaults." -ForegroundColor DarkGray
}

$desiredPiperProvider = if ($env:PIPELINE_PIPER_PROVIDER) { $env:PIPELINE_PIPER_PROVIDER.ToLowerInvariant() } else { "none" }
$desiredPiperModelConfigured = -not [string]::IsNullOrWhiteSpace($env:PIPELINE_PIPER_MODEL)

# 1. Verify runtime node requirements
$nodeCheck = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCheck) {
    Write-Host "[ERROR] Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Please install Node.js (v18+) to run PIPELINE." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    Exit 1
}

# 2. Verify database file exists
$dbPath = Join-Path $PSScriptRoot "runtime\pipeline.db"
if (-not (Test-Path $dbPath)) {
    Write-Host "[ERROR] Database not found at: $dbPath" -ForegroundColor Red
    Write-Host "Please ensure the PIPELINE database exists in the runtime directory." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    Exit 1
}

# Ensure runtime logs directory exists
$logDir = Join-Path $PSScriptRoot "runtime\logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$stdoutLog = Join-Path $logDir "pipeline-launch.stdout.log"
$stderrLog = Join-Path $logDir "pipeline-launch.stderr.log"

# 3. Port check & Application Identity check on port 8090
$port = 8090
$baseUrl = "http://127.0.0.1:$port"
$healthUrl = "$baseUrl/health"

$inUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Host "[INFO] Port $port is in use. Checking application identity and Piper configuration..." -ForegroundColor Yellow
    try {
        $res = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3
        $isPipeline = $res.status -eq "ok" -and $res.application -eq "OCG PIPELINE" -and $res.database -eq "available"
        if (-not $isPipeline) {
            Write-Host "[ERROR] PORT_8090_IN_USE_BY_ANOTHER_PROCESS" -ForegroundColor Red
            Write-Host "Port $port is in use by another application that is not a healthy OCG PIPELINE instance." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            Exit 1
        }

        $runningProvider = if ($res.piperProvider) { ([string]$res.piperProvider).ToLowerInvariant() } else { "unknown" }
        $runningModelConfigured = [bool]$res.piperModelConfigured
        $providerMatches = $runningProvider -eq $desiredPiperProvider
        $modelMatches = ($desiredPiperProvider -eq "none") -or ($runningModelConfigured -eq $desiredPiperModelConfigured)

        if ($providerMatches -and $modelMatches) {
            Write-Host "[SUCCESS] Found existing healthy PIPELINE instance with matching Piper configuration." -ForegroundColor Green
            Write-Host "Opening browser to $baseUrl ..." -ForegroundColor Green
            Start-Process $baseUrl
            Exit 0
        }

        # The running process is PIPELINE but was booted with stale provider state.
        # Restart it so the current .env is actually applied.
        Write-Host "[INFO] Existing PIPELINE instance has stale Piper configuration. Restarting it..." -ForegroundColor Yellow
        $pids = $inUse | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pid in $pids) {
            try { Stop-Process -Id $pid -Force -ErrorAction Stop } catch { }
        }
        Start-Sleep -Milliseconds 750
    } catch {
        Write-Host "[ERROR] PORT_8090_IN_USE_BY_ANOTHER_PROCESS" -ForegroundColor Red
        Write-Host "Port $port is in use, but the health check failed or returned an invalid response." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        Exit 1
    }
}

# Clear previous logs if they exist (only done if starting a new instance)
if (Test-Path $stdoutLog) { Remove-Item $stdoutLog -Force -ErrorAction SilentlyContinue }
if (Test-Path $stderrLog) { Remove-Item $stderrLog -Force -ErrorAction SilentlyContinue }

# 4. Start PIPELINE server using node server.js with correct WorkingDirectory and logs
Write-Host "Starting PIPELINE server on port $port ..." -ForegroundColor Cyan
$process = Start-Process -FilePath "node" -ArgumentList "server.js" `
    -WorkingDirectory $PSScriptRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -NoNewWindow -PassThru -ErrorAction SilentlyContinue

if (-not $process) {
    Write-Host "[ERROR] Failed to start Node process." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    Exit 1
}

# 5. Poll health endpoint and verify that the server inherited the intended Piper configuration.
Write-Host "Waiting for PIPELINE to initialize..." -ForegroundColor Cyan
$ready = $false
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $res = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
        $healthy = $res.status -eq "ok" -and $res.application -eq "OCG PIPELINE" -and $res.database -eq "available"
        $providerReady = ([string]$res.piperProvider).ToLowerInvariant() -eq $desiredPiperProvider
        $modelReady = ($desiredPiperProvider -eq "none") -or ([bool]$res.piperModelConfigured -eq $desiredPiperModelConfigured)
        if ($healthy -and $providerReady -and $modelReady) {
            $ready = $true
            break
        }
    } catch {
        # Silently retry during boot
    }
}

if ($ready) {
    Write-Host "[SUCCESS] PIPELINE is healthy." -ForegroundColor Green
    Write-Host "[INFO] Piper provider: $desiredPiperProvider" -ForegroundColor Cyan

    # For a configured model provider, run the real provider/tool-call probe.
    # A configured-but-unreachable provider must not be presented as connected.
    if ($desiredPiperProvider -ne "none") {
        Write-Host "Verifying Piper provider and tool connection..." -ForegroundColor Cyan
        try {
            $probe = Invoke-RestMethod -Uri "$baseUrl/api/v1/piper/probe" -Method Post -ContentType "application/json" -Body "{}" -TimeoutSec 75
            if (-not $probe.ok) { throw "Piper probe returned not-ok" }
            Write-Host "[SUCCESS] Piper provider probe completed." -ForegroundColor Green
        } catch {
            Write-Host "[ERROR] PIPER_PROVIDER_NOT_READY" -ForegroundColor Red
            Write-Host "PIPELINE is running, but Piper's configured model provider did not pass its live probe." -ForegroundColor Red
            if (Test-Path $stderrLog) {
                Write-Host "`n--- Node server.js Stderr Output: ---" -ForegroundColor Yellow
                Get-Content $stderrLog -Tail 20
            }
            Read-Host "Press Enter to exit"
            Exit 1
        }
    }

    Write-Host "Opening browser to $baseUrl ..." -ForegroundColor Green
    Start-Process $baseUrl
    Exit 0
} else {
    Write-Host "[ERROR] Health check failed, timed out, or Piper configuration did not match .env." -ForegroundColor Red
    if ($process.HasExited) {
        Write-Host "Process exit code: $($process.ExitCode)" -ForegroundColor Red
    } else {
        Stop-Process -Id $process.Id -Force
    }

    if (Test-Path $stderrLog) {
        Write-Host "`n--- Node server.js Stderr Output: ---" -ForegroundColor Yellow
        Get-Content $stderrLog -Tail 20
    }
    Read-Host "Press Enter to exit"
    Exit 1
}
