# PowerShell OCG PIPELINE launcher
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Starting OCG PIPELINE Launcher..." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

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

# 3. Port check & Application Identity check on port 8090
$port = 8090
$url = "http://127.0.0.1:$port/health"

# Check if port 8090 is in use
$inUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Host "[INFO] Port $port is in use. Checking application identity..." -ForegroundColor Yellow
    try {
        $res = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 3
        if ($res.application -eq "OCG PIPELINE") {
            Write-Host "[SUCCESS] Found existing running PIPELINE instance." -ForegroundColor Green
            Write-Host "Opening browser to http://127.0.0.1:$port ..." -ForegroundColor Green
            Start-Process "http://127.0.0.1:$port"
            Exit 0
        } else {
            Write-Host "[ERROR] PORT_8090_IN_USE_BY_ANOTHER_PROCESS" -ForegroundColor Red
            Write-Host "Port $port is in use by another application that is not OCG PIPELINE." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            Exit 1
        }
    } catch {
        Write-Host "[ERROR] PORT_8090_IN_USE_BY_ANOTHER_PROCESS" -ForegroundColor Red
        Write-Host "Port $port is in use, but the health check failed or returned an invalid response." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        Exit 1
    }
}

# 4. Start PIPELINE server using node server.js
Write-Host "Starting PIPELINE server on port $port ..." -ForegroundColor Cyan
$process = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru -ErrorAction SilentlyContinue

if (-not $process) {
    Write-Host "[ERROR] Failed to start Node process." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    Exit 1
}

# 5. Poll health endpoint
Write-Host "Waiting for PIPELINE to initialize..." -ForegroundColor Cyan
$ready = $false
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $res = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 2
        if ($res.application -eq "OCG PIPELINE" -and $res.database -eq "available") {
            $ready = $true
            break
        }
    } catch {
        # Silently retry during boot
    }
}

if ($ready) {
    Write-Host "[SUCCESS] PIPELINE is healthy." -ForegroundColor Green
    Write-Host "Opening browser to http://127.0.0.1:$port ..." -ForegroundColor Green
    Start-Process "http://127.0.0.1:$port"
    Exit 0
} else {
    Write-Host "[ERROR] Health check failed or timed out." -ForegroundColor Red
    if ($process.HasExited) {
        Write-Host "Process exit code: $($process.ExitCode)" -ForegroundColor Red
    } else {
        # Clean up process if it's still running but unhealthy
        Stop-Process -Id $process.Id -Force
    }
    Read-Host "Press Enter to exit"
    Exit 1
}
