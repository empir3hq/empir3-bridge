'use strict';
const {getControlLimits, DEFAULT_CONTROL_LIMITS} = require('./control-limits.js');

// Literal Unicode text and shortcuts deliberately use different primitives.
// All key-up events are paired, including on cancellation/focus failure.
const NATIVE_INPUT_PS = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
using System.Text;
using System.Collections.Generic;
public static class Empir3NativeInput {
  public static int NativeTextDeadlineMs = ${DEFAULT_CONTROL_LIMITS.nativeTextDeadlineMs};
  public static int EditorAckTimeoutMs = ${DEFAULT_CONTROL_LIMITS.editorAckTimeoutMs};
  public static int CursorAckTimeoutMs = ${DEFAULT_CONTROL_LIMITS.cursorAckTimeoutMs};
  public static int SnapshotLifetimeMs = ${DEFAULT_CONTROL_LIMITS.snapshotLifetimeMs};
  public static int AncestorDepth = ${DEFAULT_CONTROL_LIMITS.ancestorDepth};
  public static int BoundsTolerancePx = ${DEFAULT_CONTROL_LIMITS.boundsTolerancePx};
  public static int CursorTolerancePx = ${DEFAULT_CONTROL_LIMITS.cursorTolerancePx};
  public static int MoveMinMs = ${DEFAULT_CONTROL_LIMITS.moveMinMs};
  public static int MoveMaxMs = ${DEFAULT_CONTROL_LIMITS.moveMaxMs};
  public static double MoveDistanceFactor = ${DEFAULT_CONTROL_LIMITS.moveDistanceFactor};
  public static int MoveArcPx = ${DEFAULT_CONTROL_LIMITS.moveArcPx};
  public static int MoveFrameMs = ${DEFAULT_CONTROL_LIMITS.moveFrameMs};
  public static string PauseFile;
  public static IntPtr RequiredWindow;
  public static bool ReducedMotion;
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action,uint param,out bool value,uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool MonitorEnum(IntPtr monitor, IntPtr dc, ref RECT bounds, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnum callback, IntPtr data);
  static RECT[] MonitorRects() {
    var screens=new List<RECT>();
    MonitorEnum collect=delegate(IntPtr monitor,IntPtr dc,ref RECT bounds,IntPtr data){screens.Add(bounds);return true;};
    if(!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,collect,IntPtr.Zero)||screens.Count==0)
      throw new Exception("desktop_unavailable: cannot observe monitor geometry.");
    return screens.ToArray();
  }
  public static POINT ProjectToMonitors(POINT requested, RECT[] screens) {
    double closest=Double.MaxValue; POINT result=requested;
    foreach(RECT screen in screens) {
      if(screen.Right<=screen.Left||screen.Bottom<=screen.Top)continue;
      POINT candidate=new POINT();
      candidate.X=Math.Max(screen.Left,Math.Min(screen.Right-1,requested.X));
      candidate.Y=Math.Max(screen.Top,Math.Min(screen.Bottom-1,requested.Y));
      double dx=(double)candidate.X-requested.X,dy=(double)candidate.Y-requested.Y,distance=dx*dx+dy*dy;
      if(distance<closest){closest=distance;result=candidate;}
    }
    if(closest==Double.MaxValue)throw new Exception("desktop_unavailable: no valid monitor geometry.");
    return result;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool IsWindowUnicode(IntPtr h);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr ReplaceSelection(IntPtr h, uint message, UIntPtr undo, string text, uint flags, uint timeout, out UIntPtr result);
  public static IntPtr HitWindow(int x, int y) { POINT p=new POINT(); p.X=x;p.Y=y;return WindowFromPoint(p); }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int size, out int needed);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr process);
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public uint size, flags; public IntPtr active, focus, capture, menuOwner, moveSize, caret; public RECT caretRect; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  static string DesktopName(IntPtr desktop) {
    var name=new StringBuilder(256); int needed;
    if (desktop==IntPtr.Zero || !GetUserObjectInformation(desktop,2,name,512,out needed)) throw new Exception("desktop_locked: input desktop is unavailable.");
    return name.ToString();
  }
  static IntPtr Focus(IntPtr window) {
    var info=new GUITHREADINFO(); info.size=(uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(window,IntPtr.Zero),ref info)) throw new Exception("stale_observation: cannot identify focused control.");
    return info.focus;
  }
  public static void Check(IntPtr expected) {
    if (!String.IsNullOrEmpty(PauseFile) && System.IO.File.Exists(PauseFile)) throw new Exception("control_paused: resume from the local Bridge control panel.");
    if (RequiredWindow != IntPtr.Zero && GetForegroundWindow() != RequiredWindow) throw new Exception("target_changed: selected window lost focus; observe again.");
    IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) throw new Exception("desktop_locked: unlock Windows before input.");
    try { if (DesktopName(desktop) != DesktopName(GetThreadDesktop(GetCurrentThreadId()))) throw new Exception("desktop_locked: unlock Windows before input."); }
    finally { CloseDesktop(desktop); }
    if (expected != IntPtr.Zero && GetForegroundWindow() != expected) throw new Exception("stale_observation: foreground window changed; observe again.");
    if ((GetAsyncKeyState(0x1B) & 0x8000) != 0) throw new Exception("input_cancelled: Escape is held.");
  }
  static void Send(INPUT[] events) {
    if (SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(INPUT))) != events.Length)
      throw new Exception("input_incomplete: Windows refused input (possibly an elevated app); inspect state before retrying.");
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT e = new INPUT(); e.type=1; e.data.key.vk=vk; e.data.key.scan=scan; e.data.key.flags=flags; return e;
  }
  public static bool UsesSelectionText(string className, bool unicode) {
    return unicode && String.Equals(className,"RichEditD2DPT",StringComparison.OrdinalIgnoreCase);
  }
  public static void InsertSelectionText(string text, Action check, Func<string,bool> insert) {
    if(text.IndexOf('\0')>=0)throw new Exception("unsupported_text: this editor cannot insert NUL characters.");
    check();
    if(!insert(text))throw new Exception("input_incomplete: editor did not acknowledge text; inspect partial text before retrying.");
  }
  public static string Text(string text, IntPtr expected) {
    Check(expected);
    IntPtr focused=Focus(expected); var timer=Stopwatch.StartNew();
    var className=new StringBuilder(256); GetClassName(focused,className,className.Capacity);
    bool selectionText=UsesSelectionText(className.ToString(),IsWindowUnicode(focused));
    if(selectionText && !IsChild(expected,focused)) throw new Exception("stale_observation: editor does not belong to selected window.");
    foreach (int vk in new int[]{0x10,0x11,0x12,0x5B,0x5C})
      if ((GetAsyncKeyState(vk) & 0x8000) != 0) throw new Exception("input_busy: release modifier keys before typing.");
    if(selectionText) {
      // Notepad reproduced trailing-character corruption through VK_PACKET.
      // EM_REPLACESEL inserts at the caret or replaces the current selection,
      // preserves undo, and is synchronously marshalled by Windows (< WM_USER).
      InsertSelectionText(text,()=>{
        Check(expected);
        if(Focus(expected)!=focused)throw new Exception("stale_observation: focused editor changed before text input.");
      },value=>{UIntPtr result;return ReplaceSelection(focused,0x00C2,(UIntPtr)1,value,0x22,(uint)EditorAckTimeoutMs,out result)!=IntPtr.Zero;});
      return "editor-replace-selection";
    }
    foreach (char ch in text) {
      Check(expected);
      if (Focus(expected)!=focused) throw new Exception("stale_observation: focused control changed; inspect partial text before retrying.");
      if (timer.ElapsedMilliseconds>NativeTextDeadlineMs) throw new Exception("input_incomplete: text deadline reached; inspect partial text before retrying.");
      Send(new INPUT[]{Key(0,ch,4),Key(0,ch,6)});
    }
    return "unicode-input";
  }
  public static void Keys(int[] keys, IntPtr expected) {
    Check(expected); int held=0;
    try {
      foreach (int vk in keys) { Check(expected); Send(new INPUT[]{Key((ushort)vk,0,0)}); held++; }
    } finally { for (int i=held-1;i>=0;i--) Send(new INPUT[]{Key((ushort)keys[i],0,2)}); }
  }
  public static void Mouse(uint flags, int wheel) {
    INPUT e = new INPUT(); e.type=0; e.data.mouse.dwFlags=flags; e.data.mouse.mouseData=unchecked((uint)wheel); Send(new INPUT[]{e});
  }
  public static void Click(uint down, uint up) {
    INPUT a=new INPUT();a.type=0;a.data.mouse.dwFlags=down;
    INPUT b=new INPUT();b.type=0;b.data.mouse.dwFlags=up;
    try { Send(new INPUT[]{a,b}); }
    catch { Mouse(up,0);throw; }
  }
  public static int AbsoluteCoordinate(int pixel, int origin, int extent) {
    if (extent<=0 || pixel<origin || (long)pixel>=(long)origin+extent)
      throw new Exception("invalid_coordinates: point is outside the virtual desktop.");
    // Address the center of a physical pixel in SendInput's 0..65535 space.
    return (int)(((2L*((long)pixel-origin)+1)*65536)/(2L*extent));
  }
  static void MovePointer(int x, int y) {
    INPUT e=new INPUT(); e.type=0;
    e.data.mouse.dx=AbsoluteCoordinate(x,GetSystemMetrics(76),GetSystemMetrics(78));
    e.data.mouse.dy=AbsoluteCoordinate(y,GetSystemMetrics(77),GetSystemMetrics(79));
    // Real mouse input is required by WM_POINTER clients such as modern Paint.
    // SetCursorPos moves the visible cursor but does not deliver their stroke stream.
    e.data.mouse.dwFlags=0x8000|0x4000|0x2000|0x0001;
    Send(new INPUT[]{e});
  }
  static POINT ReadCursor() {
    POINT point;
    if (!GetCursorPos(out point)) throw new Exception("input_failed: cursor position unavailable.");
    return point;
  }
  static bool Near(POINT a, POINT b) { return Math.Abs(a.X-b.X)<=CursorTolerancePx && Math.Abs(a.Y-b.Y)<=CursorTolerancePx; }
  public static POINT AwaitCursor(POINT previous, POINT requested, Func<POINT> read, Action check) {
    // Windows can return before GetCursorPos reflects the input request. Accept
    // only the last acknowledged point while waiting, never arbitrary travel.
    var timer=Stopwatch.StartNew();
    while (true) {
      check(); POINT actual=read();
      if (actual.X==requested.X && actual.Y==requested.Y) return actual;
      if (!Near(actual,previous) && !Near(actual,requested))
        throw new Exception("input_cancelled: cursor moved outside the pending request; observe again.");
      if (timer.ElapsedMilliseconds>=CursorAckTimeoutMs)
        throw new Exception("input_incomplete: cursor position did not acknowledge the requested move after "+timer.ElapsedMilliseconds+"ms; previous="+previous.X+","+previous.Y+" requested="+requested.X+","+requested.Y+" actual="+actual.X+","+actual.Y+". Observe again.");
      Thread.Sleep(1);
    }
  }
  public static void Move(int x, int y, int duration, IntPtr expected) {
    Check(expected); POINT start=ReadCursor();
    RECT[] screens=MonitorRects();
    POINT destination=new POINT();destination.X=x;destination.Y=y;
    POINT validDestination=ProjectToMonitors(destination,screens);
    if(validDestination.X!=x||validDestination.Y!=y)
      throw new Exception("invalid_coordinates: destination is not on a physical monitor; observe again.");
    POINT last=start,requested=start;
    double dx=x-start.X,dy=y-start.Y,distance=Math.Sqrt(dx*dx+dy*dy);
    bool animations=true;SystemParametersInfo(0x1042,0,out animations,0);
    if(duration==100)duration=(int)Math.Min(MoveMaxMs,MoveMinMs+Math.Sqrt(distance)*MoveDistanceFactor);
    if(ReducedMotion||!animations)duration=0;
    if (start.X==x && start.Y==y) duration=0;
    // A small deterministic arc for travel; held-button drags stay straight.
    bool dragging=(GetAsyncKeyState(1)&0x8000)!=0||(GetAsyncKeyState(2)&0x8000)!=0||(GetAsyncKeyState(4)&0x8000)!=0;
    double bend=dragging||distance<40?0:Math.Min(MoveArcPx,distance*0.018);
    var timer=Stopwatch.StartNew();
    while (duration > 0 && timer.ElapsedMilliseconds < duration) {
      Check(expected);
      POINT actual=ReadCursor();
      if (Math.Abs(actual.X-last.X)>CursorTolerancePx || Math.Abs(actual.Y-last.Y)>CursorTolerancePx) throw new Exception("input_cancelled: unexpected cursor movement; previous="+last.X+","+last.Y+" requested="+requested.X+","+requested.Y+" actual="+actual.X+","+actual.Y+" start="+start.X+","+start.Y+" target="+x+","+y+". Observe again.");
      double t=Math.Min(1.0, timer.Elapsed.TotalMilliseconds/duration);
      double eased=t*t*t*(t*(t*6-15)+10),arc=bend*Math.Sin(Math.PI*eased);
      requested.X=(int)Math.Round(start.X+dx*eased-(distance>0?dy/distance*arc:0));requested.Y=(int)Math.Round(start.Y+dy*eased+(distance>0?dx/distance*arc:0));
      // The virtual bounding rectangle includes gaps between staggered screens.
      // Project only intermediate travel points onto real pixels; Windows
      // otherwise clamps them and exact acknowledgement can never succeed.
      requested=ProjectToMonitors(requested,screens);
      MovePointer(requested.X,requested.Y);
      last=AwaitCursor(last,requested,ReadCursor,()=>Check(expected));
      Thread.Sleep(MoveFrameMs);
    }
    Check(expected);POINT final=ReadCursor();
    if(duration>0&&(Math.Abs(final.X-last.X)>CursorTolerancePx||Math.Abs(final.Y-last.Y)>CursorTolerancePx))throw new Exception("input_cancelled: unexpected cursor movement at target; observe again.");
    MovePointer(x,y);
    AwaitCursor(final,destination,ReadCursor,()=>Check(expected));
  }
}
"@
[Empir3NativeInput]::NativeTextDeadlineMs = if ($null -ne $control.controlLimits.nativeTextDeadlineMs) { $control.controlLimits.nativeTextDeadlineMs } else { ${DEFAULT_CONTROL_LIMITS.nativeTextDeadlineMs} }
[Empir3NativeInput]::EditorAckTimeoutMs = if ($null -ne $control.controlLimits.editorAckTimeoutMs) { $control.controlLimits.editorAckTimeoutMs } else { ${DEFAULT_CONTROL_LIMITS.editorAckTimeoutMs} }
[Empir3NativeInput]::CursorAckTimeoutMs = if ($null -ne $control.controlLimits.cursorAckTimeoutMs) { $control.controlLimits.cursorAckTimeoutMs } else { ${DEFAULT_CONTROL_LIMITS.cursorAckTimeoutMs} }
[Empir3NativeInput]::SnapshotLifetimeMs = if ($null -ne $control.controlLimits.snapshotLifetimeMs) { $control.controlLimits.snapshotLifetimeMs } else { ${DEFAULT_CONTROL_LIMITS.snapshotLifetimeMs} }
[Empir3NativeInput]::AncestorDepth = if ($null -ne $control.controlLimits.ancestorDepth) { $control.controlLimits.ancestorDepth } else { ${DEFAULT_CONTROL_LIMITS.ancestorDepth} }
[Empir3NativeInput]::BoundsTolerancePx = if ($null -ne $control.controlLimits.boundsTolerancePx) { $control.controlLimits.boundsTolerancePx } else { ${DEFAULT_CONTROL_LIMITS.boundsTolerancePx} }
[Empir3NativeInput]::CursorTolerancePx = if ($null -ne $control.controlLimits.cursorTolerancePx) { $control.controlLimits.cursorTolerancePx } else { ${DEFAULT_CONTROL_LIMITS.cursorTolerancePx} }
[Empir3NativeInput]::MoveMinMs = if ($null -ne $control.controlLimits.moveMinMs) { $control.controlLimits.moveMinMs } else { ${DEFAULT_CONTROL_LIMITS.moveMinMs} }
[Empir3NativeInput]::MoveMaxMs = if ($null -ne $control.controlLimits.moveMaxMs) { $control.controlLimits.moveMaxMs } else { ${DEFAULT_CONTROL_LIMITS.moveMaxMs} }
[Empir3NativeInput]::MoveDistanceFactor = if ($null -ne $control.controlLimits.moveDistanceFactor) { $control.controlLimits.moveDistanceFactor } else { ${DEFAULT_CONTROL_LIMITS.moveDistanceFactor} }
[Empir3NativeInput]::MoveArcPx = if ($null -ne $control.controlLimits.moveArcPx) { $control.controlLimits.moveArcPx } else { ${DEFAULT_CONTROL_LIMITS.moveArcPx} }
[Empir3NativeInput]::MoveFrameMs = if ($null -ne $control.controlLimits.moveFrameMs) { $control.controlLimits.moveFrameMs } else { ${DEFAULT_CONTROL_LIMITS.moveFrameMs} }
[Empir3NativeInput]::PauseFile = [string]$control.pausePath
[Empir3NativeInput]::RequiredWindow = [IntPtr]::new([long]$control.requiredWindow)
[Empir3NativeInput]::ReducedMotion = [bool]$control.reducedMotion
`;

const KEY_CODES = { ctrl:17, control:17, shift:16, alt:18, win:91, meta:91, command:91, enter:13, return:13, tab:9, escape:27, esc:27, backspace:8, delete:46, space:32, home:36, end:35, pageup:33, pagedown:34, up:38, down:40, left:37, right:39, insert:45 };
function keyCodes(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > getControlLimits().shortcutKeys) throw new Error(`Provide 1–${getControlLimits().shortcutKeys} keys, for example ["CTRL", "A"].`);
  return keys.map(key => {
    const name = String(key).toLowerCase();
    if (KEY_CODES[name]) return KEY_CODES[name];
    if (/^[a-z0-9]$/.test(name)) return name.toUpperCase().charCodeAt(0);
    if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(name)) return 111 + Number(name.slice(1));
    throw new Error(`Unknown shortcut key: ${key}. Use literal text with the type tool.`);
  });
}
function literalTextBase64(text) {
  if (typeof text !== 'string' || !text.length || text.length > getControlLimits().textCharacters) throw new Error(`Provide 1–${getControlLimits().textCharacters} literal text characters.`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error('Text contains an incomplete Unicode surrogate pair.');
  return Buffer.from(text, 'utf16le').toString('base64');
}
const NATIVE_TARGET_GUARD_PS = String.raw`
$empir3SnapshotLifetimeMs = if ($null -ne $control.controlLimits.snapshotLifetimeMs) { $control.controlLimits.snapshotLifetimeMs } else { ${DEFAULT_CONTROL_LIMITS.snapshotLifetimeMs} }
$empir3AncestorDepth = if ($null -ne $control.controlLimits.ancestorDepth) { $control.controlLimits.ancestorDepth } else { ${DEFAULT_CONTROL_LIMITS.ancestorDepth} }
$empir3BoundsTolerancePx = if ($null -ne $control.controlLimits.boundsTolerancePx) { $control.controlLimits.boundsTolerancePx } else { ${DEFAULT_CONTROL_LIMITS.boundsTolerancePx} }
$empir3InvokeTarget=$null
if ($control.target) {
  $guard=$control.target
  if (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[long]$guard.capturedAt) -gt $empir3SnapshotLifetimeMs) { throw 'stale_observation: queued snapshot expired; observe again.' }
  [Empir3NativeInput]::Check([IntPtr]::new([long]$guard.window.handle))
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  $candidate=$global:Empir3DesktopRefs[$guard.ref]
  if ($null -eq $candidate) { throw 'stale_observation: worker snapshot expired; observe again.' }
  $observedNode=$candidate
  if (($candidate.GetRuntimeId() -join ',') -ne $guard.runtimeId) { throw 'stale_observation: observed control identity changed; observe again.' }
  $currentBounds=$candidate.Current.BoundingRectangle
  if ($candidate.Current.IsOffscreen -or -not $candidate.Current.IsEnabled -or
      [Math]::Abs($currentBounds.X-$guard.bounds.x) -gt $empir3BoundsTolerancePx -or [Math]::Abs($currentBounds.Y-$guard.bounds.y) -gt $empir3BoundsTolerancePx -or
      [Math]::Abs($currentBounds.Width-$guard.bounds.width) -gt $empir3BoundsTolerancePx -or [Math]::Abs($currentBounds.Height-$guard.bounds.height) -gt $empir3BoundsTolerancePx) {
    throw 'stale_observation: observed control moved or became unavailable; observe again.'
  }
  $nativeHandle=[IntPtr]::new($candidate.Current.NativeWindowHandle)
  $hitHandle=[Empir3NativeInput]::HitWindow($guard.bounds.cx,$guard.bounds.cy)
  if ($nativeHandle -ne [IntPtr]::Zero) {
    if ($hitHandle -ne $nativeHandle -and -not [Empir3NativeInput]::IsChild($nativeHandle,$hitHandle)) { throw 'stale_observation: target is covered; observe again.' }
  } else {
    $candidate=[System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($guard.bounds.cx,$guard.bounds.cy)))
  }
  $pointNode=$candidate
  $matched=$false
  $mismatch='hit test did not resolve the observed control'
  for ($depth=0; $depth -lt $empir3AncestorDepth -and $null -ne $candidate; $depth++) {
    if (($candidate.GetRuntimeId() -join ',') -eq $guard.runtimeId) {
      $bounds=$candidate.Current.BoundingRectangle
      $mismatch="expected bounds $($guard.bounds.x),$($guard.bounds.y),$($guard.bounds.width),$($guard.bounds.height); actual $($bounds.X),$($bounds.Y),$($bounds.Width),$($bounds.Height); offscreen=$($candidate.Current.IsOffscreen); enabled=$($candidate.Current.IsEnabled)"
      $matched=(-not $candidate.Current.IsOffscreen) -and $candidate.Current.IsEnabled -and
        ([Math]::Abs($bounds.X-$guard.bounds.x) -le $empir3BoundsTolerancePx) -and ([Math]::Abs($bounds.Y-$guard.bounds.y) -le $empir3BoundsTolerancePx) -and
        ([Math]::Abs($bounds.Width-$guard.bounds.width) -le $empir3BoundsTolerancePx) -and ([Math]::Abs($bounds.Height-$guard.bounds.height) -le $empir3BoundsTolerancePx)
      break
    }
    $candidate=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($candidate)
  }
  # Some WinUI providers hit-test to a native hosting pane. Never turn this
  # into an unchecked coordinate click. Permit only exact button invocation
  # or exact editable-field focus, after proving the pane is its ancestor.
  $semanticButton=$control.allowSemanticInvoke -and $observedNode.Current.ControlType -eq [Windows.Automation.ControlType]::Button
  $semanticField=$control.allowSemanticFocus -and $observedNode.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and $observedNode.Current.IsKeyboardFocusable -and -not $observedNode.Current.IsPassword
  # WinUI popup fields can be absent from point hit-testing while owning the
  # actual keyboard focus. Semantic fill sends no coordinate input. Accept
  # only the exact focused field, after the identity/bounds/window checks above;
  # the fill operation rechecks focus before sending any text.
  if (-not $matched -and $semanticField -and $nativeHandle -eq [IntPtr]::Zero -and $observedNode.Current.HasKeyboardFocus) {
    $focusedNode=[Windows.Automation.AutomationElement]::FocusedElement
    $matched=$null -ne $focusedNode -and ($focusedNode.GetRuntimeId() -join ',') -eq $guard.runtimeId
  }
  if (-not $matched -and ($semanticButton -or $semanticField) -and $nativeHandle -eq [IntPtr]::Zero -and
      $null -ne $pointNode -and $pointNode.Current.ControlType -eq [Windows.Automation.ControlType]::Pane -and
      $pointNode.Current.NativeWindowHandle -ne 0 -and $pointNode.Current.NativeWindowHandle -eq $hitHandle.ToInt64()) {
    $hitRuntime=($pointNode.GetRuntimeId() -join ',')
    $ancestor=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($observedNode)
    for ($depth=0; $depth -lt $empir3AncestorDepth -and $null -ne $ancestor; $depth++) {
      if ($ancestor.Current.NativeWindowHandle -eq $guard.window.handle) { break }
      if (($ancestor.GetRuntimeId() -join ',') -eq $hitRuntime) {
        if ($semanticButton) {
          try { $empir3InvokeTarget=$observedNode.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern) } catch {}
          $matched=$null -ne $empir3InvokeTarget
        } else { $matched=$true }
        break
      }
      $ancestor=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
    }
  }
  if (-not $matched) { throw "stale_observation: target moved, changed or became covered ($mismatch); call desktop_snapshot again." }
}
`;
module.exports = { NATIVE_INPUT_PS, NATIVE_TARGET_GUARD_PS, keyCodes, literalTextBase64 };
