param(
    [Parameter(Mandatory = $true)][string]$RuntimeJar,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\tmp\ocr-scratch-java\build'),
    [string]$JavaBin = 'C:\Program Files\Android\Android Studio\jbr\bin'
)
$ErrorActionPreference = 'Stop'
$runtimePath = (Resolve-Path -LiteralPath $RuntimeJar -Relative)
$compiler = Join-Path $JavaBin 'javac.exe'
$jarTool = Join-Path $JavaBin 'jar.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw "JDK compiler not found: $compiler" }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$classes = Join-Path $OutputDirectory 'classes'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.java' -Recurse | ForEach-Object { Resolve-Path -LiteralPath $_.FullName -Relative })
$classes = Resolve-Path -LiteralPath $classes -Relative
& $compiler --release 11 -cp $runtimePath -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw "Java compilation failed with exit code $LASTEXITCODE" }
$jarOutput = Join-Path (Resolve-Path -LiteralPath $OutputDirectory -Relative) 'scratch-formula-ocr.jar'
& $jarTool --create --file $jarOutput -C $classes .
if ($LASTEXITCODE -ne 0) { throw "Java packaging failed with exit code $LASTEXITCODE" }
Write-Output ([System.IO.Path]::GetFullPath($jarOutput))
