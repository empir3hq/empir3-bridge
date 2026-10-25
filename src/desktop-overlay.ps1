param(
  [Parameter(Mandatory=$true)] [string]$SnapshotPath
)

$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3OverlayDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
try { [Empir3OverlayDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3OverlayDpi]::SetProcessDPIAware() | Out-Null } catch {}
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Calculate union of all screens for fullscreen overlay across multi-monitor
$screens = [System.Windows.Forms.Screen]::AllScreens
$minX = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
$minY = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
$maxX = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
$maxY = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
$vWidth = $maxX - $minX
$vHeight = $maxY - $minY

$script:elements = @()
$script:lastMTime = $null

function Load-Snapshot {
  if (-not (Test-Path $SnapshotPath)) { return $false }
  try {
    $mtime = (Get-Item $SnapshotPath).LastWriteTime
    if ($script:lastMTime -and $mtime -eq $script:lastMTime) { return $false }
    $script:lastMTime = $mtime
    $raw = Get-Content $SnapshotPath -Raw
    $data = $raw | ConvertFrom-Json
    $script:elements = $data.elements
    return $true
  } catch { return $false }
}

Load-Snapshot | Out-Null

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($minX, $minY)
$form.Size = New-Object System.Drawing.Size($vWidth, $vHeight)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
# Opacity 1.0: rely purely on the TransparencyKey for see-through. Box interiors
# are left transparent (no fill) so the user can read the UI behind them; only
# the borders + number labels are painted opaque.
$form.Opacity = 1.0

$form.Add_Shown({
  $hwnd = $form.Handle
  $GWL_EXSTYLE = -20
  $WS_EX_TRANSPARENT = 0x20
  $WS_EX_LAYERED = 0x80000
  $WS_EX_NOACTIVATE = 0x08000000
  $WS_EX_TOOLWINDOW = 0x80
  $current = [Empir3OverlayDpi]::GetWindowLong($hwnd, $GWL_EXSTYLE)
  $new = $current -bor $WS_EX_TRANSPARENT -bor $WS_EX_LAYERED -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [Empir3OverlayDpi]::SetWindowLong($hwnd, $GWL_EXSTYLE, $new) | Out-Null
})

$form.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'

  $boxColor = [System.Drawing.Color]::FromArgb(255, 32, 220, 120)
  $labelBg = [System.Drawing.Color]::FromArgb(255, 18, 18, 28)
  $labelFg = [System.Drawing.Color]::FromArgb(255, 240, 255, 240)
  $boxPen = New-Object System.Drawing.Pen($boxColor, 3)
  $labelBgBrush = New-Object System.Drawing.SolidBrush($labelBg)
  $labelFgBrush = New-Object System.Drawing.SolidBrush($labelFg)
  $font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)

  foreach ($el in $script:elements) {
    if (-not $el.bounds) { continue }
    $x = [int]$el.bounds.x - $minX
    $y = [int]$el.bounds.y - $minY
    $w = [int]$el.bounds.width
    $h = [int]$el.bounds.height
    if ($w -le 0 -or $h -le 0) { continue }

    $rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
    # No interior fill — keep it see-through. Border + label only.
    $g.DrawRectangle($boxPen, $rect)

    # Label "d0" in a chip at top-left of the box
    $label = $el.ref
    $textSize = $g.MeasureString($label, $font)
    $labelRect = New-Object System.Drawing.Rectangle($x, ($y - [int]$textSize.Height - 2), ([int]$textSize.Width + 10), ([int]$textSize.Height + 2))
    if ($labelRect.Y -lt 0) { $labelRect.Y = $y + 1 }
    $g.FillRectangle($labelBgBrush, $labelRect)
    $g.DrawString($label, $font, $labelFgBrush, ($labelRect.X + 5), $labelRect.Y)
  }
})

# Watcher: poll snapshot file every 750ms; re-paint if changed
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 750
$timer.Add_Tick({
  if (Load-Snapshot) { $form.Invalidate() }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
