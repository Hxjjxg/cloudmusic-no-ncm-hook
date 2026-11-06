$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'plugin\manifest.json') | ConvertFrom-Json
$dist = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$name = $manifest.slug + '-' + $manifest.version
$zip = Join-Path $dist ($name + '.zip')
$output = Join-Path $dist ($name + '.plugin')
Compress-Archive -LiteralPath @(
    (Join-Path $projectRoot 'plugin\manifest.json'),
    (Join-Path $projectRoot 'plugin\hook.js'),
    (Join-Path $projectRoot 'plugin\main.js'),
    (Join-Path $projectRoot ('plugin\' + $manifest.preview))
) -DestinationPath $zip -Force
Move-Item -LiteralPath $zip -Destination $output -Force
Write-Output $output
