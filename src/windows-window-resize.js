'use strict';

function normalizeWindowBounds(params, current) {
  const requested = {};
  for (const [name, fallback] of [['x', 'left'], ['y', 'top'], ['width', 'width'], ['height', 'height']]) {
    const value = Number(params?.[name] ?? current?.[fallback]);
    if (!Number.isFinite(value) || value < -2147483648 || value > 2147483647) throw new Error('invalid_window_bounds: use finite 32-bit coordinates and positive dimensions.');
    requested[name] = Math.round(value);
  }
  if (requested.width < 1 || requested.height < 1 || requested.x + requested.width > 2147483647 || requested.y + requested.height > 2147483647) {
    throw new Error('invalid_window_bounds: use positive dimensions within the Windows coordinate range.');
  }
  return requested;
}

const WINDOW_RESIZE_PS = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Empir3WindowResize {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowRect(IntPtr h,out RECT rect);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
}
"@
$h=[IntPtr]::new([long]$control.windowHandle)
$requested=$control.requested
if (-not [Empir3WindowResize]::IsWindow($h)) { throw 'target_changed: window no longer exists; list windows again.' }
$title=New-Object Text.StringBuilder 4096
[Empir3WindowResize]::GetWindowText($h,$title,$title.Capacity) | Out-Null
if ($title.ToString() -cne $control.windowTitle) { throw 'target_changed: window title changed; list windows again.' }
if ([Empir3WindowResize]::IsIconic($h) -or [Empir3WindowResize]::IsZoomed($h)) { throw 'window_not_normal: restore the selected window before resizing it.' }
# Preserve foreground and Z-order. Queue work on a different GUI thread rather
# than hanging behind that app's message handler; completion is read back below.
$accepted=[Empir3WindowResize]::SetWindowPos($h,[IntPtr]::Zero,$requested.x,$requested.y,$requested.width,$requested.height,16404)
if (-not $accepted) {
 @{success=$false;dispatched=$false;verified=$false;code='window_resize_refused';error="Windows refused the resize (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())). Inspect the selected window and its permissions."} | ConvertTo-Json -Compress
 return
}
$timer=[Diagnostics.Stopwatch]::StartNew();$actual=$null;$verified=$false
do {
 $rect=New-Object Empir3WindowResize+RECT
 if ([Empir3WindowResize]::GetWindowRect($h,[ref]$rect)) {
  $actual=@{left=$rect.Left;top=$rect.Top;width=($rect.Right-$rect.Left);height=($rect.Bottom-$rect.Top)}
  $verified=$actual.left -eq $requested.x -and $actual.top -eq $requested.y -and $actual.width -eq $requested.width -and $actual.height -eq $requested.height
 }
 if($verified){break}
 Start-Sleep -Milliseconds 40
} while($timer.ElapsedMilliseconds -lt 1000)
$result=@{success=$verified;dispatched=$true;verified=$verified;requested=$requested;actual=$actual;windowHandle=$h.ToInt64()}
if (-not $verified) {$result.code='window_resize_unverified';$result.error='Windows did not report the requested bounds. The app may constrain its size or still be processing the request. Inspect actual bounds before deciding the next action.'}
$result | ConvertTo-Json -Depth 5 -Compress
`;

module.exports = {normalizeWindowBounds, WINDOW_RESIZE_PS};
