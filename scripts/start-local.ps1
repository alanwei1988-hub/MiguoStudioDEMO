[CmdletBinding()]
param(
  [ValidateSet('mock', 'miguo')]
  [string]$Provider = 'mock',

  [ValidateRange(1, 65535)]
  [int]$Port = 4317,

  [string]$CredentialFile = '',

  [switch]$AllowRealProvider,
  [switch]$AcknowledgeInternalP0,
  [switch]$Install,
  [switch]$OpenBrowser,
  [switch]$ValidateOnly,

  [ValidateSet('none', 'network_once')]
  [string]$FaultMode = 'none'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectPrefix = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$previousPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
$managedNames = @(
  'HOST', 'PORT', 'DEFAULT_PROVIDER', 'P0_FAULT_MODE',
  'MIGUO_ACCOUNT_ID', 'MIGUO_API_TOKEN', 'MIGUO_MCP_URL',
  'ALLOW_REAL_PROVIDER', 'P0_INTERNAL_USE_ACK'
)
$previousEnvironment = @{}

foreach ($name in $managedNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Set-ProcessValue {
  param([string]$Name, [AllowEmptyString()][string]$Value)
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Unquote-Value {
  param([string]$Value)
  $trimmed = $Value.Trim()
  if ($trimmed.Length -ge 2) {
    $first = $trimmed[0]
    $last = $trimmed[$trimmed.Length - 1]
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      return $trimmed.Substring(1, $trimmed.Length - 2)
    }
  }
  return $trimmed
}

function Read-ExternalMiguoCredential {
  param([string]$Path)

  if (-not $Path) {
    $accountFromEnvironment = [Environment]::GetEnvironmentVariable('MIGUO_ACCOUNT_ID', 'Process')
    $tokenFromEnvironment = [Environment]::GetEnvironmentVariable('MIGUO_API_TOKEN', 'Process')
    $urlFromEnvironment = [Environment]::GetEnvironmentVariable('MIGUO_MCP_URL', 'Process')
    if ($accountFromEnvironment -and $tokenFromEnvironment) {
      return @{ AccountId = $accountFromEnvironment; ApiToken = $tokenFromEnvironment; McpUrl = $urlFromEnvironment }
    }
    throw 'Real mode requires -CredentialFile or MIGUO_ACCOUNT_ID and MIGUO_API_TOKEN in the current process.'
  }

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $fullPath = [System.IO.Path]::GetFullPath($resolved)
  if ($fullPath.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The credential file must be outside the project directory.'
  }

  $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $fullPath
  $accountId = $null
  $apiToken = $null
  $mcpUrl = $null
  $accountLabel = ([string][char]0x6211) + [char]0x7684 + [char]0x8D26 + [char]0x53F7
  $endpointLabel = ([string][char]0x63A5) + [char]0x53E3 + [char]0x5730 + [char]0x5740

  try {
    $object = $raw | ConvertFrom-Json -ErrorAction Stop
    foreach ($propertyName in @('MIGUO_ACCOUNT_ID', 'accountId', 'account_id')) {
      $property = $object.PSObject.Properties[$propertyName]
      if ($property -and $property.Value) { $accountId = $property.Value; break }
    }
    foreach ($propertyName in @('MIGUO_API_TOKEN', 'apiToken', 'api_token')) {
      $property = $object.PSObject.Properties[$propertyName]
      if ($property -and $property.Value) { $apiToken = $property.Value; break }
    }
    foreach ($propertyName in @('MIGUO_MCP_URL', 'mcpUrl', 'mcp_url', 'baseUrl', 'base_url')) {
      $property = $object.PSObject.Properties[$propertyName]
      if ($property -and $property.Value) { $mcpUrl = $property.Value; break }
    }
  } catch {
    foreach ($rawLine in ($raw -split "`r?`n")) {
      $line = $rawLine.Trim()
      if (-not $line -or $line.StartsWith('#')) { continue }
      if ($line -notmatch '^(?<key>[^:=]+)\s*[:=]\s*(?<value>.*)$') { continue }
      $key = $Matches.key.Trim().ToUpperInvariant().Replace('-', '_').Replace(' ', '_')
      $value = Unquote-Value $Matches.value
      if ($key -in @('MIGUO_ACCOUNT_ID', 'ACCOUNT_ID', 'ACCOUNTID', $accountLabel)) { $accountId = $value }
      if ($key -in @('MIGUO_API_TOKEN', 'API_TOKEN', 'API_KEY', 'APITOKEN', 'TOKEN')) { $apiToken = $value }
      if ($key -in @('MIGUO_MCP_URL', 'MCP_URL', 'ENDPOINT', 'URL', $endpointLabel)) { $mcpUrl = $value }
    }
  }

  if (-not $accountId -or -not $apiToken) {
    throw 'Credential format not recognized. Use MIGUO_ACCOUNT_ID=... and MIGUO_API_TOKEN=..., or the documented JSON format.'
  }

  if ($mcpUrl) {
    try { $parsedUrl = [uri]([string]$mcpUrl) } catch { throw 'The MCP endpoint in the credential file is not a valid URL.' }
    if ($parsedUrl.Scheme -ne 'https' -or $parsedUrl.Host -ne 'factory.miguocomics.com') {
      throw 'The MCP endpoint must use HTTPS on factory.miguocomics.com.'
    }
  }

  return @{ AccountId = [string]$accountId; ApiToken = [string]$apiToken; McpUrl = [string]$mcpUrl }
}

try {
  $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pnpmCommand) {
    $pnpmPath = $pnpmCommand.Source
  } else {
    $bundledRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
    $bundledPnpm = Join-Path $bundledRoot 'bin\fallback\pnpm.cmd'
    $bundledNode = Join-Path $bundledRoot 'node\bin'
    if (Test-Path -LiteralPath $bundledPnpm) {
      [Environment]::SetEnvironmentVariable('PATH', "$bundledNode;$previousPath", 'Process')
      $pnpmPath = $bundledPnpm
    } else {
      throw 'pnpm was not found. Run this in the Codex workspace terminal, or install Node.js 24 and pnpm.'
    }
  }

  Set-ProcessValue 'HOST' '127.0.0.1'
  Set-ProcessValue 'PORT' ([string]$Port)
  Set-ProcessValue 'P0_FAULT_MODE' $FaultMode

  if ($Provider -eq 'mock') {
    Set-ProcessValue 'DEFAULT_PROVIDER' 'mock'
    Set-ProcessValue 'MIGUO_ACCOUNT_ID' ''
    Set-ProcessValue 'MIGUO_API_TOKEN' ''
    Set-ProcessValue 'ALLOW_REAL_PROVIDER' 'false'
    Set-ProcessValue 'P0_INTERNAL_USE_ACK' 'false'
    Write-Host ''
    Write-Host 'SAFE MODE: mock provider' -ForegroundColor Green
    Write-Host 'No Miguo request, upload, or real point charge will occur.'
  } else {
    if (-not $AllowRealProvider -or -not $AcknowledgeInternalP0) {
      throw 'Real mode requires both -AllowRealProvider and -AcknowledgeInternalP0.'
    }
    if ($FaultMode -ne 'none') {
      throw 'Fault injection is mock-only. Use -FaultMode none with Miguo.'
    }
    $credential = Read-ExternalMiguoCredential $CredentialFile
    Set-ProcessValue 'DEFAULT_PROVIDER' 'miguo'
    Set-ProcessValue 'MIGUO_ACCOUNT_ID' $credential.AccountId
    Set-ProcessValue 'MIGUO_API_TOKEN' $credential.ApiToken
    if ($credential.McpUrl) { Set-ProcessValue 'MIGUO_MCP_URL' $credential.McpUrl }
    Set-ProcessValue 'ALLOW_REAL_PROVIDER' 'true'
    Set-ProcessValue 'P0_INTERNAL_USE_ACK' 'true'
    Write-Host ''
    Write-Host 'REAL MIGUO MODE IS ENABLED' -ForegroundColor Yellow
    Write-Host 'Assets will be sent to Miguo and real points may be charged. Validate one panel first.'
  }

  if ($ValidateOnly) {
    Write-Host 'Configuration validation passed. No server was started and no provider request was sent.' -ForegroundColor Green
    return
  }

  Push-Location $projectRoot
  try {
    if ($Install -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
      Write-Host ''
      Write-Host 'Installing local runtime dependencies...'
      & $pnpmPath install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Keep the error output above.' }
    }

    $url = "http://127.0.0.1:$Port"
    Write-Host ''
    Write-Host "Workbench URL: $url" -ForegroundColor Cyan
    Write-Host 'Press Ctrl+C to stop. Batches and images remain in the data directory.'
    Write-Host ''

    if ($OpenBrowser) {
      $browserCommand = "Start-Sleep -Seconds 2; Start-Process '$url'"
      Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $browserCommand) -WindowStyle Hidden | Out-Null
    }

    & $pnpmPath start
    if ($LASTEXITCODE -ne 0) { throw 'The workbench failed to start or exited unexpectedly.' }
  } finally {
    Pop-Location
  }
} finally {
  [Environment]::SetEnvironmentVariable('PATH', $previousPath, 'Process')
  foreach ($name in $managedNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}
