param(
  [string]$OutputPath = "$env:USERPROFILE\.codex\bin\hidden-stdio-launcher-v2.exe"
)

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "hidden-stdio-launcher.cs"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "C# compiler not found in the Windows .NET Framework directories."
}

$outputDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
& $compiler /nologo /target:exe /optimize+ "/out:$OutputPath" $source
if ($LASTEXITCODE -ne 0) {
  throw "hidden stdio launcher compilation failed with exit code $LASTEXITCODE"
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath
[pscustomobject]@{
  Path = $hash.Path
  SHA256 = $hash.Hash
  Bytes = (Get-Item -LiteralPath $OutputPath).Length
}
