'use strict';

// A stopped PID is insufficient: Magnifier may leave a window or restart with
// another PID. Query the desktop without changing accessibility settings.
const MAGNIFIER_STATE_PS = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Empir3MagnifierState {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public class Window { public long handle; public uint pid; public string className; public bool visible; }
  public static Window[] Read() {
    var found = new Dictionary<long, Window>();
    EnumProc inspect = (hwnd, ignored) => {
      var value = new StringBuilder(256); GetClassName(hwnd, value, value.Capacity);
      var name = value.ToString();
      if (name == "MagUIClass" || name == "ScreenMagnifierWindow") {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        found[hwnd.ToInt64()] = new Window { handle=hwnd.ToInt64(), pid=pid, className=name, visible=IsWindowVisible(hwnd) };
      }
      return true;
    };
    EnumWindows((hwnd, ignored) => { inspect(hwnd, ignored); EnumChildWindows(hwnd, inspect, IntPtr.Zero); return true; }, IntPtr.Zero);
    var result = new Window[found.Count]; found.Values.CopyTo(result, 0); return result;
  }
}
"@
$magnifierProcesses = @(Get-Process -Name magnify -ErrorAction SilentlyContinue | Select-Object @{n='pid';e={$_.Id}},@{n='name';e={$_.ProcessName}})
$magnifierWindows = @([Empir3MagnifierState]::Read())
[pscustomobject]@{ processes=$magnifierProcesses; windows=$magnifierWindows; processAbsent=($magnifierProcesses.Count -eq 0); magUIAbsent=(@($magnifierWindows | Where-Object className -eq 'MagUIClass').Count -eq 0); lensAbsent=(@($magnifierWindows | Where-Object className -eq 'ScreenMagnifierWindow').Count -eq 0) } | ConvertTo-Json -Depth 5 -Compress
`;
function magnifierAbsenceVerified(state) {
  return !!state && Array.isArray(state.processes) && state.processes.length === 0
    && Array.isArray(state.windows) && state.windows.length === 0
    && state.processAbsent === true && state.magUIAbsent === true && state.lensAbsent === true;
}
module.exports = { MAGNIFIER_STATE_PS, magnifierAbsenceVerified };
