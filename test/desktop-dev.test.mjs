import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const {startDevelopment}=createRequire(import.meta.url)('../desktop/dev-watch.cjs');
async function until(check){for(let i=0;i<100;i++){if(check())return;await delay(40);}throw Error('watcher timeout');}
async function fixture(work){const root=mkdtempSync(resolve('.tmp-desktop-watch-'));mkdirSync(join(root,'src'));mkdirSync(join(root,'web'));const log=new PassThrough();let output='';log.on('data',c=>output+=c);let watcher;try{await work({root,log,output:()=>output,start:options=>watcher=startDevelopment({root,log,...options})});}finally{await watcher?.stop();rmSync(root,{recursive:true,force:true});}}
test('development refreshes frontend, compiles TS, serializes backend changes, and stops watching',()=>fixture(async f=>{
  const actions=[];let builds=0,release;const watcher=f.start({build:async()=>{builds++;if(builds===2)await new Promise(r=>release=r);},reload:()=>actions.push('reload'),restart:()=>actions.push('restart')});
  writeFileSync(join(f.root,'web/style.css'),'a');await until(()=>actions.length===1);assert.deepEqual(actions,['reload']);assert.equal(builds,0);
  writeFileSync(join(f.root,'web/page.ts'),'a');await until(()=>actions.length===2);assert.equal(builds,1);assert.equal(actions[1],'reload');
  writeFileSync(join(f.root,'src/service.ts'),'a');await until(()=>builds===2);writeFileSync(join(f.root,'server.mjs'),'a');await delay(500);assert.equal(actions.length,2);release();await until(()=>actions.length===4);assert.deepEqual(actions.slice(2),['restart','restart']);
  await watcher.stop();writeFileSync(join(f.root,'web/style.css'),'b');await delay(450);assert.equal(actions.length,4);
}));
test('failed compilation keeps the current process and a later edit recovers',()=>fixture(async f=>{
  let fail=true,restarts=0;f.start({build:async()=>{if(fail)throw Error('fixture compilation failed');},reload:()=>assert.fail('unexpected refresh'),restart:()=>restarts++});
  writeFileSync(join(f.root,'src/service.ts'),'bad');await until(()=>f.output().includes('fixture compilation failed'));assert.equal(restarts,0);
  fail=false;writeFileSync(join(f.root,'src/service.ts'),'fixed');await until(()=>restarts===1);
}));
