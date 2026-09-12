# One-click publish to the VS Code Marketplace.
#
# Precondition: a valid Azure DevOps PAT for publisher "tacrine" must be available.
# Provide it either via the VSCE_PAT environment variable or by logging in once:
#
#   $env:VSCE_PAT="<your-token>"    # or
#   npx vsce login tacrine
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/publish-marketplace.ps1
param(
    [switch]$Login
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($Login) {
    npx vsce login tacrine
    if ($LASTEXITCODE -ne 0) { throw "vsce login failed" }
    exit 0
}

if (-not $env:VSCE_PAT) {
    Write-Host "No VSCE_PAT set. Either set it, or run:  .\scripts\publish-marketplace.ps1 -Login" -ForegroundColor Yellow
    exit 1
}

Write-Host "Packaging and publishing..." -ForegroundColor Cyan
npx vsce publish --no-dependencies
if ($LASTEXITCODE -ne 0) { throw "vsce publish failed" }

Write-Host "Published successfully." -ForegroundColor Green