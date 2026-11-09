import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(resolve(root,'src/desktop-core-contract.json'),'utf8');
const app=process.argv.find(a=>a.startsWith('--app-repo='))?.slice('--app-repo='.length);
if(!app) throw new Error('Pass --app-repo=<app worktree or keeper> and optionally --check.');
const target=resolve(app,'server/src/runtime/router/invocables/desktop-core-contract.json');
if(process.argv.includes('--check')) {
  if(!existsSync(target)||readFileSync(target,'utf8').replace(/\r\n/g,'\n')!==source.replace(/\r\n/g,'\n')) throw new Error('Desktop core contract drift: regenerate the app copy from the Bridge.');
  console.log('MCP and app desktop core contract copies match.');
} else { writeFileSync(target,source);console.log('Updated app desktop core contract.'); }
