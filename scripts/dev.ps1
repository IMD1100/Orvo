param([switch]$CheckServices)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$cargo = (Get-Command cargo -ErrorAction Stop).Source
$cmake = (Get-Command cmake -ErrorAction Stop).Source
$env:ORVO_PROJECT_DIR = $projectRoot
$env:ORVO_PYTHON = Join-Path $projectRoot 'python/.venv/Scripts/python.exe'
$env:ORVO_ENGINE = Join-Path $projectRoot 'engine/build/orvo-engine_artefacts/Release/orvo-engine.exe'
if (-not (Test-Path -LiteralPath $env:ORVO_PYTHON)) { throw 'Python environment missing. Follow the README setup instructions.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'frontend/node_modules/vite/bin/vite.js'))) { throw 'Frontend dependencies missing. Follow the README setup instructions.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.deps/JUCE/CMakeLists.txt'))) { throw 'JUCE source missing. Follow the README setup instructions.' }
& $cmake -S (Join-Path $projectRoot 'engine') -B (Join-Path $projectRoot 'engine/build')
if ($LASTEXITCODE -ne 0) { throw 'Audio engine configuration failed.' }
& $cmake --build (Join-Path $projectRoot 'engine/build') --config Release --target orvo-engine --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'Audio engine build failed.' }
$devUrl = [uri]((Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'src-tauri/tauri.conf.json') | ConvertFrom-Json).build.devUrl)
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $devUrl.Port)
$probe.ExclusiveAddressUse = $true
try { $probe.Start() }
catch [System.Net.Sockets.SocketException] {
  $probe.Stop()
  $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $probe.Start()
  $devUrl = [uri]"http://127.0.0.1:$($probe.LocalEndpoint.Port)"
  $env:TAURI_CONFIG = @{ build = @{ devUrl = $devUrl.AbsoluteUri } } | ConvertTo-Json -Compress
}
finally { $probe.Stop() }
$frontend = Join-Path $projectRoot 'frontend'
$log = Join-Path ([IO.Path]::GetTempPath()) "orvo-vite-$PID.log"
$vite = Start-Process -FilePath $node -ArgumentList @('node_modules/vite/bin/vite.js', '--port', $devUrl.Port.ToString()) -WorkingDirectory $frontend -WindowStyle Hidden -RedirectStandardError $log -PassThru
try {
  $ready = $false
  for ($i = 0; $i -lt 75; $i++) {
    if ($vite.HasExited) { throw (Get-Content -Raw -LiteralPath $log) }
    try { $ready = (Invoke-WebRequest -UseBasicParsing -Uri $devUrl -TimeoutSec 1).StatusCode -eq 200 } catch { }
    if ($ready) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) { throw 'Vite did not start.' }
  $runArgs = @('run', '--locked', '--no-default-features', '--manifest-path', (Join-Path $projectRoot 'src-tauri/Cargo.toml'))
  if ($CheckServices) { $runArgs += '--', '--check-services' }
  & $cargo @runArgs
  exit $LASTEXITCODE
} finally {
  if (-not $vite.HasExited) { Stop-Process -InputObject $vite -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
}
