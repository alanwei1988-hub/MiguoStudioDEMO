[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4317,
  [switch]$OpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '..\..'))
$previewRoot = Join-Path $workspaceRoot 'work\manga-frontend-demo'
$previousDataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'Process')

try {
  [Environment]::SetEnvironmentVariable('DATA_ROOT', $previewRoot, 'Process')
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($nodeCommand) {
    $nodePath = $nodeCommand.Source
  } else {
    $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) {
      throw 'Node.js was not found. Run this script from the Codex workspace, or install Node.js 24.'
    }
  }

  Push-Location $projectRoot
  try {
    & $nodePath --disable-warning=ExperimentalWarning scripts/seed-frontend-demo.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Demo data could not be prepared.' }
    & (Join-Path $PSScriptRoot 'start-local.ps1') -Provider mock -Port $Port -OpenBrowser:$OpenBrowser
  } finally {
    Pop-Location
  }
} finally {
  [Environment]::SetEnvironmentVariable('DATA_ROOT', $previousDataRoot, 'Process')
}
