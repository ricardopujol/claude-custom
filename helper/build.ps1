# Builds the native hook helper (Native AOT) into .harness/hook-helper.exe
#
# vswhere.exe must be on PATH or the ILCompiler targets emit a malformed link
# command and fail with MSB3073 / exit code 123 -- the error names link.exe, so
# it reads like a missing linker when the linker is actually present and fine.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$installer = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer'

if (Test-Path (Join-Path $installer 'vswhere.exe')) {
    $env:PATH = "$installer;$env:PATH"
} else {
    Write-Warning "vswhere.exe not found at $installer - Native AOT publish will likely fail."
}

$out = Join-Path $repo '.harness\aot'
dotnet publish (Join-Path $PSScriptRoot 'hook-helper.csproj') -c Release -o $out
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with $LASTEXITCODE" }

Copy-Item (Join-Path $out 'hook-helper.exe') (Join-Path $repo '.harness\hook-helper.exe') -Force
Write-Host "hook-helper.exe -> $(Join-Path $repo '.harness\hook-helper.exe')"
