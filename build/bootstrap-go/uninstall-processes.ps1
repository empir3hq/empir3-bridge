$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Shared by the native bootstrap and both legacy JavaScript uninstall paths.
# Ports and image names alone never establish installation ownership.
if ($env:EMPIR3_UNINSTALL_TEST -eq '1') {
  @{ ok=$true; killed=@(); testMode=$true } | ConvertTo-Json -Compress
  exit 0
}

function Resolve-InstallRoot([string]$Value, [string]$Leaf) {
  if (-not $Value -or -not [IO.Path]::IsPathRooted($Value)) { throw 'Missing absolute installation root' }
  $result = [IO.Path]::GetFullPath($Value).TrimEnd([char]92, [char]47)
  if ([IO.Path]::GetFileName($result) -ne $Leaf) { throw 'Unexpected installation root' }
  return $result
}

function Test-UnderRoot([string]$Value, [string]$Root) {
  if (-not $Value -or -not [IO.Path]::IsPathRooted($Value)) { return $false }
  try { return [IO.Path]::GetFullPath($Value).StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
}

function Test-InstalledProcess($Item, [string]$BridgeRoot, [string]$AppRoot) {
  if ($Item.Name -in @('node.exe','Empir3Tray.exe','Empir3Setup.exe')) {
    return (Test-UnderRoot $Item.ExecutablePath $BridgeRoot) -or (Test-UnderRoot $Item.ExecutablePath $AppRoot)
  }
  if ($Item.Name -ne 'chrome.exe' -or -not $Item.ExecutablePath -or -not $Item.CommandLine) { return $false }
  $match = [regex]::Match($Item.CommandLine, '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))(?=\s|$)')
  if (-not $match.Success) { return $false }
  $profile = @($match.Groups | Select-Object -Skip 1 | Where-Object Success)[0].Value
  return (Test-UnderRoot $profile $BridgeRoot) -or (Test-UnderRoot $profile $AppRoot)
}

try {
  $bridgeRoot = Resolve-InstallRoot $env:EMPIR3_UNINSTALL_BRIDGE_ROOT '.empir3-bridge'
  $appRoot = Resolve-InstallRoot $env:EMPIR3_UNINSTALL_APP_ROOT 'Empir3'
  $caller = [int]$env:EMPIR3_UNINSTALL_CALLER_PID
  if ($caller -le 0) { throw 'Missing uninstaller identity' }
  $targets = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $caller -and $_.ProcessId -ne $PID -and (Test-InstalledProcess $_ $bridgeRoot $appRoot)
  } | Sort-Object @{Expression={if ($_.Name -eq 'Empir3Tray.exe') { 0 } else { 1 }}})
  if ($env:EMPIR3_UNINSTALL_DRY_RUN -eq '1') {
    @{ok=$true; candidates=@($targets | Select-Object ProcessId,Name); killed=@()} | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }
  $killed = @()
  foreach ($item in $targets) {
    $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    # Recheck executable and creation time before terminating the process
    # object. A reused PID never inherits the earlier ownership decision.
    if (-not [string]::Equals($process.Path, $item.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        [Math]::Abs(($process.StartTime.ToUniversalTime() - $item.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) {
      throw 'Process identity changed during uninstall; no further processes were stopped'
    }
    $process.Kill()
    if (-not $process.WaitForExit(10000)) { throw 'An installation process did not stop' }
    $killed += [int]$item.ProcessId
  }
  @{ok=$true; killed=@($killed)} | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
