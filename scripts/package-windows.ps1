$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $projectRoot 'release'
$stagingRoot = Join-Path $env:LOCALAPPDATA 'CASEBANG\packaging-output'

function Assert-ExactPath([string]$ActualPath, [string]$ExpectedPath, [string]$Label) {
  $actual = [IO.Path]::GetFullPath($ActualPath).TrimEnd('\')
  $expected = [IO.Path]::GetFullPath($ExpectedPath).TrimEnd('\')
  if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean $Label because path validation failed."
  }
}

function Assert-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Package validation failed: missing $Label at $Path"
  }
  if ((Get-Item -LiteralPath $Path).Length -le 0) {
    throw "Package validation failed: empty $Label at $Path"
  }
}

Assert-ExactPath $releaseRoot (Join-Path $projectRoot 'release') 'project output directory'
Assert-ExactPath $stagingRoot (Join-Path $env:LOCALAPPDATA 'CASEBANG\packaging-output') 'staging directory'

$electronRuntime = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
Assert-File $electronRuntime 'local Electron runtime'

if (Test-Path -LiteralPath $releaseRoot) {
  Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

Push-Location $projectRoot
try {
  Write-Host 'Building application code...' -ForegroundColor Cyan
  & pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw "Application build failed with exit code $LASTEXITCODE"
  }

  Write-Host 'Building the complete Windows installer in LocalAppData...' -ForegroundColor Cyan
  & pnpm electron-builder --win nsis "--config.directories.output=$stagingRoot"
  if ($LASTEXITCODE -ne 0) {
    throw "Windows packaging failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$unpackedRoot = Join-Path $stagingRoot 'win-unpacked'
$packagedExecutable = Join-Path $unpackedRoot 'CASEBANG-Automation.exe'
$packagedAsar = Join-Path $unpackedRoot 'resources\app.asar'
$packagedIcon = Join-Path $unpackedRoot 'resources\casebang-app-icon.png'

Assert-File $packagedExecutable 'main executable'
Assert-File $packagedAsar 'application archive'
Assert-File $packagedIcon 'runtime application icon'

$unpackedModules = Join-Path $unpackedRoot 'resources\app.asar.unpacked'
$nativeModules = @()
if (Test-Path -LiteralPath $unpackedModules -PathType Container) {
  $nativeModules = @(Get-ChildItem -LiteralPath $unpackedModules -Recurse -File -Filter '*.node')
}
if ($nativeModules.Count -eq 0) {
  throw 'Package validation failed: no unpacked native image module was found.'
}

$installers = @(Get-ChildItem -LiteralPath $stagingRoot -File -Filter '*.exe' | Where-Object {
  $_.Name -notlike '*.__uninstaller.exe'
})
if ($installers.Count -ne 1) {
  throw "Package validation failed: expected one installer, found $($installers.Count)."
}

Copy-Item -LiteralPath $installers[0].FullName -Destination $releaseRoot -Force
$blockMap = "$($installers[0].FullName).blockmap"
if (Test-Path -LiteralPath $blockMap -PathType Leaf) {
  Copy-Item -LiteralPath $blockMap -Destination $releaseRoot -Force
}
$effectiveConfig = Join-Path $stagingRoot 'builder-effective-config.yaml'
if (Test-Path -LiteralPath $effectiveConfig -PathType Leaf) {
  Copy-Item -LiteralPath $effectiveConfig -Destination $releaseRoot -Force
}

$finalInstaller = Get-Item -LiteralPath (Join-Path $releaseRoot $installers[0].Name)
$installerHash = Get-FileHash -LiteralPath $finalInstaller.FullName -Algorithm SHA256

Write-Host ''
Write-Host 'Windows installer completed successfully.' -ForegroundColor Green
Write-Host "Path: $($finalInstaller.FullName)"
Write-Host ("Size: {0:N1} MB" -f ($finalInstaller.Length / 1MB))
Write-Host "SHA256: $($installerHash.Hash)"
