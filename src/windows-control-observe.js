'use strict';
// PrintWindow asks the selected app to render its window, independently of
// overlapping windows. Unsupported renderers fail rather than returning a
// different application's pixels. Worker timeout bounds unresponsive providers.
const WINDOW_CAPTURE_PS = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3WindowCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
}
"@
$h=[IntPtr]::new([long]$control.windowHandle)
if (-not [Empir3WindowCapture]::IsWindow($h) -or [Empir3WindowCapture]::IsIconic($h)) { throw 'capture_unavailable: window closed or minimized.' }
$r=New-Object Empir3WindowCapture+RECT
if (-not [Empir3WindowCapture]::GetWindowRect($h,[ref]$r)) { throw 'capture_unavailable: cannot read window bounds.' }
$w=$r.Right-$r.Left; $hgt=$r.Bottom-$r.Top
if ($w -lt 1 -or $hgt -lt 1 -or ([long]$w*$hgt) -gt 24000000) { throw 'capture_unavailable: unsupported window dimensions.' }
$bmp=New-Object Drawing.Bitmap($w,$hgt); $g=[Drawing.Graphics]::FromImage($bmp)
try {
 $dc=$g.GetHdc()
 try { $ok=[Empir3WindowCapture]::PrintWindow($h,$dc,2) } finally { $g.ReleaseHdc($dc) }
 if (-not $ok) { throw 'capture_unavailable: app does not support window rendering; use a visible region screenshot.' }
 $scale=[Math]::Min(1,[double]$control.maxWidth/$w)
 $ow=[Math]::Max(1,[int][Math]::Round($w*$scale)); $oh=[Math]::Max(1,[int][Math]::Round($hgt*$scale))
 $small=New-Object Drawing.Bitmap($ow,$oh); $sg=[Drawing.Graphics]::FromImage($small)
 try {
  $sg.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp,0,0,$ow,$oh)
  $codec=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'} | Select-Object -First 1
  $parameters=New-Object Drawing.Imaging.EncoderParameters(1)
  try {
   $parameters.Param[0]=New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality,[long]75)
   $small.Save([string]$control.path,$codec,$parameters)
  } finally { $parameters.Dispose() }
 } finally { $sg.Dispose();$small.Dispose() }
 [pscustomobject]@{path=$control.path;mimeType='image/jpeg';width=$ow;height=$oh;originX=$r.Left;originY=$r.Top;scaleX=([double]$w/$ow);scaleY=([double]$hgt/$oh);windowHandle=$control.windowHandle;method='PrintWindow';coordinateSpace='image-pixels';note='Map image x/y using origin + coordinate * scale. Some GPU/protected renderers may return blank content; use visible region capture if needed.'} | ConvertTo-Json -Compress
} finally { $g.Dispose();$bmp.Dispose() }
`;
module.exports = { WINDOW_CAPTURE_PS };
