'use strict';

const {randomUUID} = require('node:crypto');
const {mkdirSync, readFileSync} = require('node:fs');
const {join} = require('node:path');

// No wake keys, SwitchDesktop, focus changes or keep-awake lease. Reading the
// input desktop name refuses locked/secure desktops without activating them.
const SCREEN_READ_GUARD_PS = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Empir3ScreenRead {
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder text, int length, out int needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  public static bool Available() {
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) return false;
    try {
      var name = new StringBuilder(256); int needed;
      return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) && name.ToString() == "Default";
    } finally { CloseDesktop(desktop); }
  }
}
"@
if (-not [Empir3ScreenRead]::Available()) { throw 'desktop_locked: unlock the Windows desktop before observing it.' }
if ($control.windowHandle -and -not [Empir3ScreenRead]::IsWindow([IntPtr]::new([long]$control.windowHandle))) { throw 'target_closed: desktop window is unavailable.' }
`;

// Capture once, then resize/encode in the same resident process. Any payload
// budget retries reuse the bitmap; they never recapture or launch a process.
const SCREEN_CAPTURE_TYPES_PS = String.raw`
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
public static class Empir3ObservationCapture {
  public static int[] Save(int x, int y, int width, int height, string path, int dimension, int quality, int budget) {
    using (var original = new Bitmap(width, height)) {
      using (var graphics = Graphics.FromImage(original)) {
        graphics.CopyFromScreen(x, y, 0, 0, original.Size);
      }
      ImageCodecInfo jpeg = null;
      foreach (var codec in ImageCodecInfo.GetImageEncoders()) if (codec.MimeType == "image/jpeg") jpeg = codec;
      for (int attempt = 0; attempt < 5; attempt++) {
        double scale = Math.Min(1.0, (double)dimension / Math.Max(width, height));
        int w = Math.Max(1, (int)Math.Round(width * scale)), h = Math.Max(1, (int)Math.Round(height * scale));
        using (var resized = new Bitmap(w, h)) {
          using (var graphics = Graphics.FromImage(resized)) {
            graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
            graphics.DrawImage(original, 0, 0, w, h);
          }
          using (var encoding = new EncoderParameters(1)) {
            encoding.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
            resized.Save(path, jpeg, encoding);
          }
        }
        if (4 * ((new FileInfo(path).Length + 2) / 3) <= budget) return new int[] {w, h, quality};
        dimension = Math.Max(320, (int)(dimension * 0.75));
        quality = Math.Max(35, quality - 8);
      }
    }
    File.Delete(path);
    throw new InvalidOperationException("screenshot_payload_too_large: image could not fit the relay payload budget.");
  }
}
"@
`;
const SCREEN_CAPTURE_PS = SCREEN_CAPTURE_TYPES_PS + String.raw`
$screens = [System.Windows.Forms.Screen]::AllScreens
function Frame($id, $deviceName, $primary, $bounds) {
  $path = Join-Path $control.outDir ("desktop-" + $control.stamp + "-" + $id + ".jpg")
  $encoded = [Empir3ObservationCapture]::Save($bounds.x, $bounds.y, $bounds.width, $bounds.height, $path, $control.maxDimension, $control.quality, $control.maxBase64Chars)
  return [pscustomobject]@{ id=$id; deviceName=$deviceName; primary=$primary; path=$path; bounds=$bounds; width=$encoded[0]; height=$encoded[1]; quality=$encoded[2] }
}
function Bounds($x, $y, $w, $h) {
  return [pscustomobject]@{x=$x; y=$y; width=$w; height=$h; right=($x+$w); bottom=($y+$h)}
}
$captures = @(); $stitchedPath = $null; $region = $null; $wanted = $control.monitor
if ($control.region) {
  $r = $control.region
  $region = $r; $wanted = 'region'
  $captures += Frame 'region' 'region' $false (Bounds $r.x $r.y $r.width $r.height)
} else {
  foreach ($s in $screens) {
    $id = $s.DeviceName.Substring($s.DeviceName.LastIndexOf('\') + 1)
    if ($wanted -ne 'all' -and $wanted -ne $id -and $wanted -ne $s.DeviceName -and -not ($wanted -eq 'primary' -and $s.Primary)) { continue }
    $b = $s.Bounds
    $captures += Frame $id $s.DeviceName $s.Primary (Bounds $b.X $b.Y $b.Width $b.Height)
  }
  if ($captures.Count -eq 0) { throw 'desktop_screenshot: monitor not found.' }
  if ($wanted -eq 'all') {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $stitched = Frame 'all' 'all' $false (Bounds $b.X $b.Y $b.Width $b.Height)
    $stitchedPath = $stitched.path
  }
}
[pscustomobject]@{ dpiAware=$true; coordinateSpace='physical-virtual-screen'; monitor=$wanted; region=$region; stitchedPath=$stitchedPath; grid=$null; captures=$captures } | ConvertTo-Json -Depth 8 -Compress
`;

function bounded(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function captureOptions(params = {}, defaultBudget = 900000) {
  let region;
  if (params.region) {
    region = Object.fromEntries(['x','y','width','height'].map(k => [k, Math.round(Number(params.region[k]))]));
    if (!Object.values(region).every(Number.isFinite) || region.width <= 0 || region.height <= 0 || region.width * region.height > 100_000_000) {
      throw new Error('desktop_screenshot region requires numeric x, y, width>0, height>0 (at most 100 megapixels)');
    }
  }
  return {monitor:params.monitor || 'primary', region,
    maxDimension:bounded(params.maxDimension, 1800, 900, 2400),
    quality:bounded(params.quality, 70, 45, 82),
    maxBase64Chars:bounded(params.maxBase64Chars, defaultBudget, 200000, 900000)};
}
async function captureScreenObservation(run, outDir, params = {}, defaultBudget) {
  const options = captureOptions(params, defaultBudget);
  mkdirSync(outDir, {recursive:true});
  const shot = await run(SCREEN_CAPTURE_PS, undefined, {...options, outDir, stamp:randomUUID(), windowHandle:params.target?.windowHandle});
  // GUI has always returned the first capture; retain that selection for 'all'.
  const first = shot.captures[0];
  const buffer = readFileSync(first.path);
  const prepared = {path:first.path, buffer, mimeType:'image/jpeg', width:first.width, height:first.height,
    transformed:first.width !== first.bounds.width || first.height !== first.bounds.height,
    originalWidth:first.bounds.width, originalHeight:first.bounds.height, maxBase64Chars:options.maxBase64Chars};
  return {shot, prepared};
}

module.exports = {SCREEN_READ_GUARD_PS, SCREEN_CAPTURE_TYPES_PS, SCREEN_CAPTURE_PS, captureOptions, captureScreenObservation};
