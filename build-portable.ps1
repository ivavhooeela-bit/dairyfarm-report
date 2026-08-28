param(
    [string]$NodeExe = $env:DAIRYFARM_NODE_EXE,
    [string]$TargetName = 'DairyFarm-Report-Portable'
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'dist'))
if ($TargetName -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'TargetName may contain only letters, digits, dots, underscores and hyphens.'
}
$target = [System.IO.Path]::GetFullPath((Join-Path $distRoot $TargetName))
$zipPath = [System.IO.Path]::GetFullPath((Join-Path $distRoot ($TargetName + '.zip')))

if (-not $NodeExe) {
    $bundledNode = Join-Path $root 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $NodeExe = $bundledNode }
}
if (-not $NodeExe) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodeExe = $nodeCommand.Source }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw 'Pass the Node.js executable with -NodeExe or DAIRYFARM_NODE_EXE.'
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\exceljs')) -or
    -not (Test-Path -LiteralPath (Join-Path $root 'node_modules\playwright'))) {
    throw 'Production dependencies are missing. Run pnpm install first.'
}
if (-not $target.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe portable target path.'
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

New-Item -ItemType Directory -Force -Path $target | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $target 'runtime') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $target '.artifact-work') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $target 'config') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $target 'outputs') | Out-Null

Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $target 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $root 'server.mjs') -Destination $target
Copy-Item -LiteralPath (Join-Path $root 'start.ps1') -Destination $target
Copy-Item -LiteralPath (Join-Path $root 'start.cmd') -Destination $target
Copy-Item -LiteralPath (Join-Path $root 'start.cmd') -Destination (Join-Path $target 'START_DAIRYFARM_REPORT.cmd')
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $target
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $target
Copy-Item -LiteralPath (Join-Path $root 'template-converter.xlsx') -Destination $target
Copy-Item -LiteralPath (Join-Path $root '.artifact-work\workbook-writer.mjs') -Destination (Join-Path $target '.artifact-work')
Copy-Item -LiteralPath (Join-Path $root 'lib') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $root 'public') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $root 'node_modules') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $root 'config\1369.json') -Destination (Join-Path $target 'config')
Copy-Item -LiteralPath (Join-Path $root 'config\bases.json') -Destination (Join-Path $target 'config')
Copy-Item -LiteralPath (Join-Path $root 'config\workbook-mapping.json') -Destination (Join-Path $target 'config')
Copy-Item -LiteralPath (Join-Path $root 'config\presentation-mapping.json') -Destination (Join-Path $target 'config')

New-Item -ItemType Directory -Force -Path (Join-Path $target 'third-party-licenses') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'node_modules\exceljs\LICENSE') -Destination (Join-Path $target 'third-party-licenses\ExcelJS-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $root 'node_modules\playwright\LICENSE') -Destination (Join-Path $target 'third-party-licenses\Playwright-LICENSE.txt')

Compress-Archive -LiteralPath $target -DestinationPath $zipPath -CompressionLevel Optimal

$nodeVersion = & (Join-Path $target 'runtime\node.exe') --version
$size = (Get-Item -LiteralPath $zipPath).Length
Write-Host "Portable folder: $target"
Write-Host "Portable archive: $zipPath"
Write-Host "Bundled Node.js: $nodeVersion"
Write-Host "Archive bytes: $size"
