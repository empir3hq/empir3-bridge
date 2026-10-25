param(
  [Parameter(Mandatory=$true)][string]$PlanPath,
  [Parameter(Mandatory=$true)][string]$ResultPath
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$started=Get-Date
$receipt=[ordered]@{schemaVersion=1;clean=$false;scanCompleted=$false;startedAt=$started.ToUniversalTime().ToString('o');files=@();detections=@();error=$null}
try {
  $plan=Get-Content -LiteralPath $PlanPath -Raw|ConvertFrom-Json
  if(@($plan.files).Count -eq 0 -or @($plan.scanPaths).Count -eq 0){throw 'Empty Defender scan plan'}
  $status=Get-MpComputerStatus
  if(-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled){throw 'Defender antivirus and real-time protection must be enabled'}
  $receipt.signatureVersion=$status.AntivirusSignatureVersion
  $receipt.engineVersion=$status.AMEngineVersion
  foreach($file in $plan.files){
    if((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash -ne $file.sha256){throw ('Pre-scan file missing or changed: '+$file.path)}
  }
  foreach($path in $plan.scanPaths){Start-MpScan -ScanType CustomScan -ScanPath $path}
  $receipt.scanCompleted=$true
  foreach($file in $plan.files){
    $hash=(Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hash -ne $file.sha256){throw ('Post-scan file changed: '+$file.path)}
    $receipt.files+=@{path=$file.path;sha256=$hash}
  }
  $patterns=@($plan.scanPaths|ForEach-Object{'(?i)'+[regex]::Escape(([string]$_).TrimEnd('\','/'))+'(?:[\\/;!]|$)'})
  $detections=@(Get-MpThreatDetection|Where-Object{
    $recent=$_.InitialDetectionTime -ge $started -or $_.LastThreatStatusChangeTime -ge $started
    $matching=$false
    foreach($resource in $_.Resources){foreach($pattern in $patterns){if([string]$resource -match $pattern){$matching=$true}}}
    $recent -and $matching
  })
  $receipt.detections=@($detections|Select-Object ThreatID,ActionSuccess,InitialDetectionTime,LastThreatStatusChangeTime,Resources)
  if($detections.Count -gt 0){throw 'Defender detected a threat in the scanned candidate; remediation is not a clean release result'}
  $status=Get-MpComputerStatus
  if(-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled){throw 'Defender protection became unavailable during scan'}
  $receipt.clean=$true
} catch {
  $receipt.error=$_.Exception.Message
} finally {
  $receipt.completedAt=(Get-Date).ToUniversalTime().ToString('o')
  $receipt|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $ResultPath -Encoding UTF8
}
if(-not $receipt.clean){Write-Error -Message $receipt.error -ErrorAction Continue;exit 1}
