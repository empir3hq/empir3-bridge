import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const helper=path.resolve('build/bootstrap-go/uninstall-processes.ps1');
const psQuote=value=>`'${value.replaceAll("'","''")}'`;

for(const scenario of ['normal','already-exited','exited-during-identity','exited-during-kill','live-access-denied','unreadable-exit-state','changed-identity']) {
  test(`uninstall process boundary: ${scenario}`, {skip:process.platform!=='win32'},()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-uninstall-exit-race-'));
    const script=path.join(root,'fixture.ps1'),trace=path.join(root,'kill.txt');
    const bridge=path.join(root,'.empir3-bridge'),app=path.join(root,'Empir3');
    // Only process enumeration/control are fixtures. Execute the shipping
    // cleanup script, including its ownership, identity and failure checks.
    fs.writeFileSync(script,`
$ErrorActionPreference='Stop'
$global:e3FixtureKind=${psQuote(scenario)}
$global:e3FixtureTrace=${psQuote(trace)}
$when=[DateTime]::UtcNow
$exe=${psQuote(path.join(bridge,'node.exe'))}
$global:e3FixtureItem=[pscustomobject]@{ProcessId=2147482000;Name='node.exe';ExecutablePath=$exe;CreationDate=$when}
$global:e3FixtureProcess=[pscustomobject]@{Path=$exe;StartTime=$when;HasExited=$false}
if($global:e3FixtureKind -eq 'changed-identity'){$global:e3FixtureProcess.Path=${psQuote(path.join(root,'unrelated','node.exe'))}}
if($global:e3FixtureKind -eq 'already-exited'){$global:e3FixtureProcess.Path=$null;$global:e3FixtureProcess.HasExited=$true}
if($global:e3FixtureKind -eq 'exited-during-identity'){$global:e3FixtureProcess | Add-Member -Force ScriptProperty Path {$this.HasExited=$true;return $null}}
if($global:e3FixtureKind -eq 'unreadable-exit-state'){$global:e3FixtureProcess | Add-Member -Force ScriptProperty HasExited {throw 'exit state unreadable'}}
$global:e3FixtureProcess | Add-Member ScriptMethod Kill {
  Set-Content -LiteralPath $global:e3FixtureTrace -Value 'called'
  if($global:e3FixtureKind -in @('live-access-denied','unreadable-exit-state')){throw 'Access is denied'}
  $this.HasExited=$true
  if($global:e3FixtureKind -eq 'exited-during-kill'){throw 'Access is denied'}
}
$global:e3FixtureProcess | Add-Member ScriptMethod WaitForExit {param($timeout) return $this.HasExited}
function Get-CimInstance {param($ClassName) return $global:e3FixtureItem}
function Get-Process {param($Id) return $global:e3FixtureProcess}
& ${psQuote(helper)}
exit $LASTEXITCODE
`);
    try {
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{
        encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,
          EMPIR3_UNINSTALL_BRIDGE_ROOT:bridge,EMPIR3_UNINSTALL_APP_ROOT:app,
          EMPIR3_UNINSTALL_CALLER_PID:'2147481999',EMPIR3_UNINSTALL_TEST:'',EMPIR3_UNINSTALL_DRY_RUN:''},
      });
      const exitedBeforeKill=['already-exited','exited-during-identity'].includes(scenario);
      if(scenario==='normal'||scenario==='exited-during-kill'||exitedBeforeKill) {
        assert.equal(result.status,0,result.stderr||result.error?.message);
        assert.deepEqual(JSON.parse(result.stdout).killed,exitedBeforeKill?[]:[2147482000]);
      } else {
        assert.equal(result.status,1);
        assert.match(result.stderr,scenario==='changed-identity'?/identity changed/:/Access is denied|exit state unreadable/);
        assert.equal(result.stdout.trim(),'');
      }
      assert.equal(fs.existsSync(trace),scenario!=='changed-identity'&&!exitedBeforeKill);
    } finally {
      assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('bridge-uninstall-exit-race-'));
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
}

