import test from 'node:test';
import assert from 'node:assert/strict';
import {cdpHttpRefusal} from '../src/cdp-http-boundary.js';
const opts={port:9867};
test('native wrapper and MCP HTTP clients remain available on exact local hosts',()=>{
 for(const host of ['127.0.0.1:9867','localhost:9867','[::1]:9867'])assert.equal(cdpHttpRefusal({host},opts),null);
 assert.equal(cdpHttpRefusal({host:'192.168.1.10:9867'},{...opts,host:'192.168.1.10'}),null);
 assert.equal(cdpHttpRefusal({host:'localhost:9867','sec-fetch-mode':'cors'},opts),null,'Node native fetch remains available');
});
test('browser requests cannot reach commands, screenshots or setup proxy routes',()=>{
 for(const pathname of ['/evaluate','/snapshot','/screenshot','/api/command','/api/install/sign-out','/health']){
  for(const browser of [{origin:'https://untrusted.example'},{origin:'http://localhost:3006'},{origin:'null'},{origin:''},{'sec-fetch-site':'cross-site'},{'sec-fetch-mode':'no-cors'},{'sec-fetch-dest':'image'}]){
   assert.match(cdpHttpRefusal({host:'localhost:9867',...browser},{...opts,pathname,method:'POST'}),/Browser pages/);
  }
 }
 assert.match(cdpHttpRefusal({host:'localhost:9867',origin:'https://untrusted.example'},{...opts,method:'OPTIONS'}),/Browser pages/);
});
test('DNS rebinding and malformed Host headers cannot name the internal service',()=>{
 for(const host of [undefined,['localhost:9867'],'evil.example:9867','localhost.evil.example:9867','localhost:9868','user@localhost:9867','localhost:9867/path','localhost:9867?x','localhost:9867#x','0.0.0.0:9867'])assert.ok(cdpHttpRefusal({host},opts),String(host));
});
test('legacy setup navigations can redirect to the maintained console',()=>{
 assert.equal(cdpHttpRefusal({host:'localhost:9867','sec-fetch-mode':'navigate','sec-fetch-site':'cross-site'},{...opts,pathname:'/welcome'}),null);
 assert.ok(cdpHttpRefusal({host:'localhost:9867',origin:'https://untrusted.example'},{...opts,pathname:'/welcome',method:'POST'}));
});
