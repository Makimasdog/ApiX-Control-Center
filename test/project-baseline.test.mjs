import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync,symlinkSync,unlinkSync,realpathSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {projectBaseline,projectSourceVersion} from '../src/projects/project-baseline.mjs';
import {createTaskDelivery} from '../src/projects/task-delivery.mjs';
const git=(cwd,args)=>execFileSync('git',['-c','core.autocrlf=false',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(work){const dir=mkdtempSync(join(tmpdir(),'apix-baseline-'));const source=join(dir,'source');mkdirSync(source);try{work({dir,source,data:join(dir,'data')});}finally{assert(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
test('ApiX data root cannot be snapshotted as a project',()=>fixture(({source})=>{
  writeFileSync(join(source,'apix.sqlite'),'private state');assert.throws(()=>projectBaseline(source,'plan',source),/数据目录不能/);
  assert(!existsSync(join(source,'project-baselines')));
}));
test('non-Git and empty projects get stable plan baselines without touching source, secrets or ignored inputs',()=>fixture(({source,data})=>{
  writeFileSync(join(source,'README.md'),'initial');writeFileSync(join(source,'.env'),'secret');writeFileSync(join(source,'private.pem'),'secret');
  writeFileSync(join(source,'.gitignore'),'cache/\n');mkdirSync(join(source,'cache'));writeFileSync(join(source,'cache','huge'),Buffer.alloc(101*1024*1024));
  const repo=projectBaseline(source,'plan',data);assert(!existsSync(join(source,'.git')));
  assert(!existsSync(join(repo,'.env')));assert(!existsSync(join(repo,'private.pem')));assert(!existsSync(join(repo,'cache')));
  const head=git(repo,['rev-parse','HEAD']);const worker=join(data,'worker');git(repo,['worktree','add','--detach',worker,head]);
  writeFileSync(join(worker,'README.md'),'worker');assert.equal(readFileSync(join(source,'README.md'),'utf8'),'initial');
  writeFileSync(join(source,'README.md'),'later');assert.equal(projectBaseline(source,'plan',data,{create:false}),repo);assert.equal(readFileSync(join(repo,'README.md'),'utf8'),'initial');
  const next=projectBaseline(source,'next',data);assert.equal(readFileSync(join(next,'README.md'),'utf8'),'later');
  git(source,['init']);assert.notEqual(projectBaseline(source,'empty-git',data),source);
}));
test('existing Git stays in its repository and managed baseline tampering is rejected',()=>fixture(({source,data})=>{
  const repo=projectBaseline(source,'plan',data);writeFileSync(join(repo,'a'),'tamper');git(repo,['add','a']);git(repo,['-c','user.name=Test','-c','user.email=test@local.invalid','commit','-m','tamper']);
  assert.throws(()=>projectBaseline(source,'plan',data),/基线已变化/);
  git(source,['init']);writeFileSync(join(source,'a'),'source');git(source,['add','a']);git(source,['-c','user.name=Test','-c','user.email=test@local.invalid','commit','-m','initial']);
  assert.equal(projectBaseline(source,'other',data),realpathSync.native(source));
}));
test('links and excessive inputs fail without publishing an incomplete baseline',()=>fixture(({source,data,dir})=>{
  const external=join(dir,'external');mkdirSync(external);writeFileSync(join(external,'secret'),'outside');symlinkSync(external,join(source,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>projectBaseline(source,'plan',data),/链接/);assert(!existsSync(join(source,'.git')));
  assert.throws(()=>projectBaseline(source,'plan',data,{create:false}),/尚未建立/);
  unlinkSync(join(source,'linked'));writeFileSync(join(source,'huge'),Buffer.alloc(101*1024*1024));
  assert.throws(()=>projectBaseline(source,'plan',data),/100 MiB/);assert.throws(()=>projectBaseline(source,'plan',data,{create:false}),/尚未建立/);
}));
test('failed non-Git tasks without a workspace have recoverable source fingerprints that change with content',()=>fixture(({source,data})=>{
  writeFileSync(join(source,'README.md'),'before');const before=projectSourceVersion(source,data);
  const task={id:'t',project_id:'p',status:'failed',workspace_path:null};
  const row=(sql)=>sql.startsWith('SELECT * FROM tasks')?task:sql.startsWith('SELECT path FROM projects')?{path:source}:null;
  const delivery=createTaskDelivery({row,codeHandoffs:{},dataDir:data})('t');
  assert.equal(delivery.error,null);assert.equal(delivery.sourceHead,before);assert(delivery.recoveryFingerprint);
  writeFileSync(join(source,'README.md'),'after');assert.notEqual(projectSourceVersion(source,data),before);
  assert.notEqual(createTaskDelivery({row,codeHandoffs:{},dataDir:data})('t').recoveryFingerprint,delivery.recoveryFingerprint);
}));


test('Windows transient rename locks retry without replacing the saved baseline', {skip:process.platform!=='win32'},()=>fixture(({source,data})=>{
 writeFileSync(join(source,'README.md'),'retry snapshot');const original=fs.renameSync;let attempts=0;
 fs.renameSync=(from,to)=>{if(++attempts<3)throw Object.assign(new Error('fixture lock'),{code:'EPERM'});return original(from,to);};syncBuiltinESMExports();
 try{const repo=projectBaseline(source,'retry-plan',data);assert.equal(attempts,3);assert.equal(readFileSync(join(repo,'README.md'),'utf8'),'retry snapshot');assert.equal(projectBaseline(source,'retry-plan',data),repo);assert.equal(attempts,3);}
 finally{fs.renameSync=original;syncBuiltinESMExports();}
}));

for(const [code,expected] of [['EIO',1],['EPERM',6]])test('baseline rename '+code+' fails without publishing partial state',{skip:process.platform!=='win32'},()=>fixture(({source,data})=>{
 writeFileSync(join(source,'README.md'),'source survives');const original=fs.renameSync;let attempts=0;
 fs.renameSync=()=>{attempts++;throw Object.assign(new Error('fixture '+code),{code});};syncBuiltinESMExports();
 try{assert.throws(()=>projectBaseline(source,'failed-plan',data),new RegExp(code));assert.equal(attempts,expected);assert.deepEqual(fs.readdirSync(join(data,'project-baselines')),[]);assert.equal(readFileSync(join(source,'README.md'),'utf8'),'source survives');}
 finally{fs.renameSync=original;syncBuiltinESMExports();}
}));
