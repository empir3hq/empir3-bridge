import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import presenceModule from '../src/windows-control-presence.js';

test('an unwritable feedback location does not fail an observation or claim a visible overlay',{skip:process.platform!=='win32'},()=>{
 const directory=mkdtempSync(join(tmpdir(),'empir3-presence-failure-'));
 const blocked=join(directory,'not-a-directory');writeFileSync(blocked,'fixture');
 const presence=presenceModule.createControlPresence(()=>blocked);
 try{
  assert.doesNotThrow(()=>presence.show([{x:0,y:0,width:720,height:560}]));
  assert.equal(presence.status().visible,false);assert.equal(presence.status().overlayRunning,false);
  assert.doesNotThrow(()=>presence.hide());
 }finally{presence.stop();unlinkSync(blocked);rmdirSync(directory);}
});
