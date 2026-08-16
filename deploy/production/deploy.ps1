# deploy.ps1 — Deploy standalone PIPELINE and OCG ONE integration to production VPS
param(
    [Parameter(Mandatory=$true)][string]$VpsIp,
    [Parameter(Mandatory=$true)][string]$SshUser,
    [Parameter(Mandatory=$false)][string]$IdentityFile = "$HOME\.ssh\id_rsa",
    [Parameter(Mandatory=$false)][int]$SshPort = 22
)

$ErrorActionPreference = "Stop"

Write-Host "=== Packaging & Copying Source Files to Production VPS ===" -ForegroundColor Cyan

# 1. Compress source code to copy over
$deployDir = Split-Path $MyInvocation.MyCommand.Path
$workspaceRoot = Resolve-Path "$deployDir\..\..\..\.."

# Ensure files exist locally
$ocgOneDir = "$workspaceRoot\apps\ocg-one"
$pipelineDir = "$workspaceRoot\apps\pipeline"

if (-not (Test-Path $ocgOneDir) -or -not (Test-Path $pipelineDir)) {
    Write-Error "Could not find both application directories under $workspaceRoot\apps."
}

# 2. SCP compose files, Dockerfiles, and Caddyfile to VPS
$sshArgs = "-P $SshPort -i `"$IdentityFile`""
Write-Host "Sending deployment scripts..."
scp $sshArgs "$deployDir\docker-compose.yml" "$deployDir\Caddyfile" "$deployDir\pipeline.Dockerfile" "$deployDir\ocg-one.Dockerfile" "$deployDir\deploy.sh" "$deployDir\bootstrap-server.sh" "$deployDir\generate-secrets.sh" "$deployDir\migrate-pipeline.sh" "$deployDir\migrate-production-data.sh" "$deployDir\verify-production.sh" "$deployDir\backup.sh" "$deployDir\restore.sh" "$deployDir\cutover.sh" "$deployDir\rollback.sh" "$SshUser@${VpsIp}:/tmp/"

# SSH commands to create dirs and move files
$remoteSetupCmd = "sudo mkdir -p /srv/ocg/compose && sudo mv /tmp/docker-compose.yml /tmp/Caddyfile /tmp/pipeline.Dockerfile /tmp/ocg-one.Dockerfile /tmp/deploy.sh /tmp/bootstrap-server.sh /tmp/generate-secrets.sh /tmp/migrate-pipeline.sh /tmp/migrate-production-data.sh /tmp/verify-production.sh /tmp/backup.sh /tmp/restore.sh /tmp/cutover.sh /tmp/rollback.sh /srv/ocg/compose/ && sudo chmod +x /srv/ocg/compose/*.sh"
ssh -p $SshPort -i $IdentityFile "$SshUser@$VpsIp" $remoteSetupCmd

# 3. SCP full application sources
Write-Host "Syncing app sources (this might take a few moments)..."
# Exclude node_modules, local databases, scratch directories, logs, etc.
$excludeList = "node_modules", "runtime", "scratch", "database/ocg_one.db", "playwright-report", "test-results", "storage", ".git"
$excludeArgs = ""
foreach ($ex in $excludeList) { $excludeArgs += " --exclude `"$ex`"" }

# We copy the entire apps tree. In a real environment, we'd use git clone or tarball, but SCP of tarball is best:
$tarPath = "$env:TEMP\ocg_apps.tar.gz"
Write-Host "Creating local archive..."
tar -czf $tarPath -C $workspaceRoot apps/ocg-one apps/pipeline --exclude="**/node_modules" --exclude="**/.git" --exclude="**/runtime" --exclude="**/scratch" --exclude="**/*.db" --exclude="**/storage"

Write-Host "Copying archive to VPS..."
scp $sshArgs $tarPath "$SshUser@${VpsIp}:/tmp/ocg_apps.tar.gz"

Write-Host "Extracting archive on VPS..."
$remoteExtractCmd = "sudo tar -xzf /tmp/ocg_apps.tar.gz -C /srv/ocg/ && sudo chown -R 1000:1000 /srv/ocg/apps && rm /tmp/ocg_apps.tar.gz"
ssh -p $SshPort -i $IdentityFile "$SshUser@$VpsIp" $remoteExtractCmd

Write-Host "=== Deployment Scripts Sync Complete ==="
Write-Host "Please SSH into the server and run bootstrap-server.sh, generate-secrets.sh, and deploy.sh in order." -ForegroundColor Green
