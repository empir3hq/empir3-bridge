param(
  [string]$CanaryRoot = 'C:\Users\vault\AppData\Local\Temp\empir3-held-canary-0.3.95',
  [int]$Port = 39194,
  [string]$ExpectedVersion = '0.3.95'
)

$ErrorActionPreference = 'Stop'
$server = $null

try {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Canary port $Port is already in use"
  }

  $nodeExe = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.empir3-bridge\node') `
    -Filter node.exe -File -Recurse | Select-Object -First 1 -ExpandProperty FullName
  if (-not $nodeExe) { throw 'Installed Bridge Node runtime was not found' }
  $serverArgs = @{
    FilePath = $nodeExe
    ArgumentList = @((Join-Path $CanaryRoot 'serve-held-canary.cjs'), $CanaryRoot, "$Port")
    PassThru = $true
    WindowStyle = 'Hidden'
    RedirectStandardOutput = Join-Path $env:TEMP 'empir3-held-canary-http.log'
    RedirectStandardError = Join-Path $env:TEMP 'empir3-held-canary-http.err.log'
  }
  $server = Start-Process @serverArgs

  $manifestUrl = "http://127.0.0.1:$Port/bridge-version.json"
  $manifest = $null
  for ($attempt = 0; $attempt -lt 20 -and -not $manifest; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { $manifest = Invoke-RestMethod $manifestUrl } catch { }
  }
  if (-not $manifest) { throw 'Canary HTTP server did not become ready' }
  if ($manifest.version -ne $ExpectedVersion) { throw "Unexpected canary version $($manifest.version)" }

  $env:EMPIR3_BRIDGE_VERSION_URL = $manifestUrl
  & (Join-Path $CanaryRoot 'Empir3Setup.exe')
  if ($LASTEXITCODE -ne 0) { throw "Installer exited $LASTEXITCODE" }
  Start-Sleep -Seconds 4

  $stable = Join-Path $env:APPDATA 'Empir3\Empir3Setup.exe'
  $installedVersion = (& $stable --version).Trim()
  $bootstrapVersion = (& $stable --bootstrap-version).Trim()
  $signature = Get-AuthenticodeSignature -LiteralPath $stable
  if ($installedVersion -ne $ExpectedVersion) { throw "Installed version is $installedVersion" }
  if ($signature.Status -ne 'Valid') { throw "Stable bootstrap signature is $($signature.Status)" }

  [pscustomobject]@{
    InstalledVersion = $installedVersion
    BootstrapVersion = $bootstrapVersion
    SignatureStatus = [string]$signature.Status
    Signer = $signature.SignerCertificate.Subject
    CanaryServerPid = $server.Id
  } | Format-List
}
finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
}
