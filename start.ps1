$ErrorActionPreference = 'Stop'
$nodeExe = Join-Path $PSScriptRoot 'runtime\node.exe'

if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw 'Portable Node.js runtime was not found. Extract the complete application archive and try again.'
}

$existingListener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($existingListener.OwningProcess)" -ErrorAction SilentlyContinue
    $expectedServer = Join-Path $PSScriptRoot 'server.mjs'
    if ($existingProcess -and $existingProcess.Name -eq 'node.exe' -and $existingProcess.CommandLine -like "*$expectedServer*") {
        Stop-Process -Id $existingListener.OwningProcess -Force
        Start-Sleep -Milliseconds 500
    }
    else {
        throw 'Port 8787 is already used by another application.'
    }
}

# Open the interface shortly after the local server starts.
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile',
    '-Command',
    'Start-Sleep -Seconds 2; Start-Process "http://127.0.0.1:8787"'
)

Push-Location $PSScriptRoot
try {
    & $nodeExe "$PSScriptRoot\server.mjs"
}
finally {
    Pop-Location
}
