'use strict';
const {getControlLimits} = require('./control-limits.js');
const {spawn}=require('node:child_process');
const {mkdirSync,writeFileSync,renameSync,unlinkSync}=require('node:fs');
const {join}=require('node:path');

// Local, click-through feedback. An observation is a snapshot, not a live feed:
// the border says "Observed" and expires unless another observation refreshes it.
const PRESENCE_PS=String.raw`param([string]$StatePath,[int]$OwnerPid)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @"
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class Empir3PresenceFrame : Form {
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 public string Caption="Observed by agent";
 public Empir3PresenceFrame(){DoubleBuffered=true;FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;BackColor=Color.Magenta;TransparencyKey=Color.Magenta;}
 protected override bool ShowWithoutActivation{get{return true;}}
 protected override CreateParams CreateParams{get{var p=base.CreateParams;p.ExStyle|=0x080800A0;return p;}}
 protected override void OnPaint(PaintEventArgs e){
  base.OnPaint(e); var g=e.Graphics;
  using(var dark=new Pen(Color.FromArgb(19,44,34),5))g.DrawRectangle(dark,2,2,Width-5,Height-5);
  using(var green=new Pen(Color.FromArgb(78,210,143),2))g.DrawRectangle(green,2,2,Width-5,Height-5);
  using(var font=new Font("Segoe UI",9,FontStyle.Bold))using(var bg=new SolidBrush(Color.FromArgb(19,44,34)))using(var fg=new SolidBrush(Color.FromArgb(232,255,244))){
   int w=Math.Min(Width-16,(int)g.MeasureString(Caption,font).Width+20);
   g.FillRectangle(bg,8,1,w,24);g.DrawString(Caption,font,fg,16,5);
  }
 }
}
"@
[Empir3PresenceFrame]::SetProcessDpiAwarenessContext([IntPtr](-4))|Out-Null
$forms=New-Object Collections.ArrayList
$owner=[Diagnostics.Process]::GetProcessById($OwnerPid)
$timer=New-Object Windows.Forms.Timer;$timer.Interval=100
$timer.Add_Tick({
 if($owner.HasExited){[Windows.Forms.Application]::Exit();return}
 try{$s=[IO.File]::ReadAllText($StatePath)|ConvertFrom-Json}catch{return}
 if(!$s.visible -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt $s.expiresAt){foreach($f in $forms){$f.Hide()};return}
 $regions=@($s.regions)
 while($forms.Count -lt $regions.Count){[void]$forms.Add((New-Object Empir3PresenceFrame))}
 for($i=0;$i -lt $forms.Count;$i++){
  $f=$forms[$i];if($i -ge $regions.Count){$f.Hide();continue}
  $r=$regions[$i];$f.Bounds=New-Object Drawing.Rectangle ([int]$r.x),([int]$r.y),([int]$r.width),([int]$r.height)
  $f.Caption=[string]$s.label;$f.Show();$f.Invalidate()
 }
})
$timer.Start()
[Windows.Forms.Application]::Run()
`;
function createControlPresence(directory) {
  let child=null,state=null;
  const file=()=>join(directory(),'presence.json');
  function save(){
    const tmp=file()+'.tmp';
    try{mkdirSync(directory(),{recursive:true});writeFileSync(tmp,JSON.stringify(state));renameSync(tmp,file());return true;}
    catch{try{unlinkSync(tmp);}catch{}return false;}
  }
  function show(regions,label='Observed by agent') {
    regions=regions.filter(r=>r&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>8&&r.height>8).slice(0,8);
    if(process.platform!=='win32'||!regions.length)return;
    state={visible:true,label,regions,expiresAt:Date.now()+getControlLimits().presenceHoldMs};
    // Feedback cannot turn a successful observation into a failed tool call.
    if(!save()){state.visible=false;return;}
    if(!child){
      try{
        const ps=join(directory(),'presence.ps1');writeFileSync(ps,PRESENCE_PS);
        child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',ps,'-StatePath',file(),'-OwnerPid',String(process.pid)],{windowsHide:true,stdio:'ignore'});
        const p=child;p.on('error',()=>{if(child===p)child=null;});p.on('exit',()=>{if(child===p)child=null;});
      }catch{child=null;state.visible=false;}
    }
  }
  function hide(){if(state){state={...state,visible:false};if(!save()){child?.kill();child=null;}}}
  function stop(){child?.kill();child=null;state=null;try{unlinkSync(file());}catch{}}
  return {show,hide,stop,status:()=>state?{...state,overlayRunning:!!child&&!child.killed,visible:!!child&&!child.killed&&state.visible&&state.expiresAt>Date.now()}:null};
}
module.exports={createControlPresence,PRESENCE_PS};
