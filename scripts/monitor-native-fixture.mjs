// Disposable native receiver. Tests read its event proof independently of Bridge.
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
export async function nativeMonitorFixture(state) {
  const result=join(state,'monitor-fixture.json'),path=join(state,'monitor-fixture.ps1');
  writeFileSync(path,String.raw`
param([string]$ResultPath)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class MonitorFixtureDpi {
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode);
}
"@
[MonitorFixtureDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$form=New-Object Windows.Forms.Form
$form.Text='Empir3 Monitor Acceptance';$form.StartPosition='Manual';$form.Location=New-Object Drawing.Point(180,180);$form.Size=New-Object Drawing.Size(700,520)
$text=New-Object Windows.Forms.TextBox;$text.Multiline=$true;$text.Location=New-Object Drawing.Point(30,30);$text.Size=New-Object Drawing.Size(600,140)
$button=New-Object Windows.Forms.Button;$button.Text='Count monitor click';$button.Location=New-Object Drawing.Point(30,200);$button.Size=New-Object Drawing.Size(200,45)
$panel=New-Object Windows.Forms.Panel;$panel.Location=New-Object Drawing.Point(30,300);$panel.Size=New-Object Drawing.Size(600,100);$panel.BackColor=[Drawing.Color]::LightGreen;$panel.TabStop=$true
$script:clicks=0;$script:right=0;$script:wheels=0;$script:down=$null;$script:up=$null;$script:moves=0;$script:hovers=0
function Rect($c) {$p=$c.PointToScreen([Drawing.Point]::Empty);return @{x=$p.X;y=$p.Y;width=$c.Width;height=$c.Height}}
function Save-Proof {[IO.File]::WriteAllText($ResultPath,(@{text=$text.Text;clicks=$script:clicks;right=$script:right;wheels=$script:wheels;down=$script:down;up=$script:up;moves=$script:moves;hovers=$script:hovers;field=(Rect $text);button=(Rect $button);panel=(Rect $panel)}|ConvertTo-Json -Depth 4 -Compress),(New-Object Text.UTF8Encoding $false))}
$text.Add_TextChanged({Save-Proof})
$text.Add_KeyDown({param($s,$e) if($e.Control -and $e.KeyCode -eq [Windows.Forms.Keys]::A){$text.SelectAll();$e.SuppressKeyPress=$true}})
$button.Add_Click({$script:clicks++;Save-Proof})
$panel.Add_MouseDown({param($s,$e) $panel.Focus();if($e.Button -eq [Windows.Forms.MouseButtons]::Right){$script:right++};$script:down=@{x=$e.X;y=$e.Y};$script:moves=0;Save-Proof})
$panel.Add_MouseMove({param($s,$e) if($e.Button -eq [Windows.Forms.MouseButtons]::Left){$script:moves++}else{$script:hovers++;Save-Proof}})
$panel.Add_MouseUp({param($s,$e) $script:up=@{x=$e.X;y=$e.Y};Save-Proof})
$panel.Add_MouseWheel({param($s,$e) $script:wheels+=$e.Delta;Save-Proof})
$form.Controls.AddRange(@($text,$button,$panel));$form.Add_Shown({[MonitorFixtureDpi]::ShowWindow($form.Handle,9)|Out-Null;Save-Proof})
$form.Add_LocationChanged({Save-Proof})
[Windows.Forms.Application]::Run($form)
`);
  const child=spawn('powershell.exe',['-NoProfile','-File',path,'-ResultPath',result],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  for(let i=0;i<100&&!existsSync(result)&&child.exitCode===null;i++)await delay(100);
  if(!existsSync(result)){child.kill();throw Error('Native fixture failed: '+log);}
  return {proof:()=>JSON.parse(readFileSync(result,'utf8')),stop:()=>{child.kill();writeFileSync(join(state,'monitor-fixture.log'),log);}};
}
