param(
  [int]$Port = 3006
)

$ErrorActionPreference = 'Stop'
$pattern = 'higgsfield|codebase-memory|mcp-cli-proxy|mcp-proxy|codex.*mcp|--mcp'
$baseline = @{}
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -match $pattern
} | ForEach-Object { $baseline[[int]$_.ProcessId] = $true }

$uri = "http://127.0.0.1:$Port/api/cli/verify-auth"
$job = Start-Job -ScriptBlock {
  param($VerifyUri)
  Invoke-RestMethod -Method Post -Uri $VerifyUri -ContentType 'application/json' `
    -Body '{"provider":"grok"}' -TimeoutSec 120
} -ArgumentList $uri

$foreign = @{}
try {
  while ($job.State -in @('NotStarted', 'Running')) {
    Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -and $_.CommandLine -match $pattern -and -not $baseline.ContainsKey([int]$_.ProcessId)
    } | ForEach-Object {
      $match = [regex]::Match($_.CommandLine, $pattern, 'IgnoreCase').Value
      $foreign[[int]$_.ProcessId] = [pscustomobject]@{
        ProcessId = [int]$_.ProcessId
        Name = $_.Name
        Match = $match
      }
    }
    Start-Sleep -Milliseconds 100
    $job = Get-Job -Id $job.Id
  }
  $result = Receive-Job -Job $job -ErrorAction Stop
  [pscustomobject]@{
    Ok = [bool]$result.ok
    Verified = [bool]$result.verified
    LastVerifiedAt = $result.lastVerifiedAt
    ForeignHelperCount = $foreign.Count
    ForeignHelpers = @($foreign.Values)
  } | ConvertTo-Json -Depth 5
  if (-not $result.ok -or -not $result.verified -or $foreign.Count -gt 0) { exit 1 }
}
finally {
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}
