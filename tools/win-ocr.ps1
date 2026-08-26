# Recognise one image with the OCR engine built into Windows.
#
# Windows 10/11 ship Windows.Media.Ocr, and this machine has the zh-Hans-CN
# recogniser installed — which is what these books need. Using it keeps the
# engine's zero-dependency, no-network promise: nothing is installed, nothing is
# downloaded, and no page ever leaves the machine.
#
# Must run under Windows PowerShell 5.1. PowerShell 7 removed the WinRT
# projection, so `pwsh` cannot load these types at all.
#
# Usage:  powershell.exe -NoProfile -File win-ocr.ps1 -Image <path> [-Language zh-Hans-CN]
# Output: the recognised text on stdout, one line per recognised line.

param(
  [Parameter(Mandatory = $true)][string]$Image,
  [string]$Language = 'zh-Hans-CN',
  # Written as UTF-8 without going through the console. Piping stdout through a
  # legacy code page turns every Han character into a question mark.
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# WinRT returns IAsyncOperation; PowerShell needs it bridged to a Task to wait.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$full = (Resolve-Path -LiteralPath $Image).Path

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = [Windows.Globalization.Language]::new($Language)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {
  # Fall back to whatever the user's profile offers rather than failing outright;
  # the caller decides whether the result is usable.
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) { throw "no OCR engine for '$Language' and none from the user profile" }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

# One output line per recognised line, so the caller keeps the page's structure.
$lines = @()
foreach ($line in $result.Lines) { $lines += $line.Text }
$text = ($lines -join "`n")

if ($Out) {
  [System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding $false))
} else {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.WriteLine($text)
}

$stream.Dispose()
