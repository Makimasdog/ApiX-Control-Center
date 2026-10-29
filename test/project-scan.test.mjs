import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,openSync,closeSync,writeSync,rmSync,lstatSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {projectFingerprint} from '../dist/src/assistant/assistant-tools.js';
import {reviewSnapshot} from '../dist/src/assistant/assistant-delivery.js';
import {sourceManifest} from '../dist/src/validation/node-project.js';
import {scanProjectFile} from '../dist/src/infrastructure/project-scan.js';

test('project above 8 MiB hashes all bytes and freezes bounded previews',()=>{
 const dir=mkdtempSync(join(tmpdir(),'apix-large-scan-'));try{
  const path=join(dir,'large.dat');writeFileSync(path,Buffer.alloc(9*1024*1024,65));
  const first=projectFingerprint(dir),manifest=sourceManifest(dir);assert.equal(manifest.bytes,9*1024*1024);
  const frozen=reviewSnapshot(dir);assert.equal(frozen.files[0].size,9*1024*1024);assert.equal(frozen.files[0].content,undefined);
  const fd=openSync(path,'r+');try{writeSync(fd,Buffer.from('B'),0,1,8*1024*1024+100);}finally{closeSync(fd);}
  assert.notEqual(projectFingerprint(dir),first);assert.notEqual(sourceManifest(dir).hash,manifest.hash);
  const stale=lstatSync(path);writeFileSync(path,'changed');assert.throws(()=>scanProjectFile(path,stale),/变化/);
 }finally{assert(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
