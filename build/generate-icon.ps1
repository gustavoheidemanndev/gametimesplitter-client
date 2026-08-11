Add-Type -AssemblyName System.Drawing

$buildDirectory = $PSScriptRoot
$pngPath = Join-Path $buildDirectory 'icon.png'
$icoPath = Join-Path $buildDirectory 'icon.ico'

if (-not (Test-Path -LiteralPath $pngPath -PathType Leaf)) {
  throw "Source icon not found: $pngPath"
}

# icon.png is the approved GTS artwork. Never redraw or overwrite it here.
$sourceBitmap = [System.Drawing.Bitmap]::new($pngPath)
if ($sourceBitmap.Width -ne $sourceBitmap.Height -or $sourceBitmap.Width -lt 256) {
  $sourceBitmap.Dispose()
  throw 'build/icon.png must be a square image with at least 256x256 pixels.'
}

# Windows selects different resolutions for windows, taskbar, shortcuts and Explorer.
# Each frame is an exact downscaled copy of the approved PNG inside one ICO container.
$iconSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$iconFrames = @()
foreach ($iconSize in $iconSizes) {
  $resized = [System.Drawing.Bitmap]::new(
    $iconSize,
    $iconSize,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($resized)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.DrawImage(
    $sourceBitmap,
    [System.Drawing.Rectangle]::new(0, 0, $iconSize, $iconSize),
    0,
    0,
    $sourceBitmap.Width,
    $sourceBitmap.Height,
    [System.Drawing.GraphicsUnit]::Pixel
  )

  $memoryStream = [System.IO.MemoryStream]::new()
  $resized.Save($memoryStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $iconFrames += ,$memoryStream.ToArray()
  $memoryStream.Dispose()
  $graphics.Dispose()
  $resized.Dispose()
}
$sourceBitmap.Dispose()

$stream = [System.IO.File]::Create($icoPath)
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$iconFrames.Count)

$dataOffset = 6 + (16 * $iconFrames.Count)
for ($index = 0; $index -lt $iconFrames.Count; $index++) {
  $iconSize = $iconSizes[$index]
  $dimension = if ($iconSize -eq 256) { [Byte]0 } else { [Byte]$iconSize }
  $frame = $iconFrames[$index]
  $writer.Write($dimension)
  $writer.Write($dimension)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$frame.Length)
  $writer.Write([UInt32]$dataOffset)
  $dataOffset += $frame.Length
}

foreach ($frame in $iconFrames) {
  $writer.Write($frame)
}
$writer.Dispose()

Write-Host "Generated multi-resolution $icoPath from the approved $pngPath"
