import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectReadiness} from '../src/readiness.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
test('readiness accepts an actual non-Git directory without initializing it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'apix-nongit-readiness-'));
  try{const result=await projectReadiness({project:{id:'p',path:dir},employees:[],runtimes:[],settings:{provider:'',model:'',apiKeyEnv:''},managerAvailable:false});assert.equal(result.checks[0].state,'ready');assert.match(result.checks[0].message,/托管 Git 快照/);}finally{assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
test('a missing Git executable is not treated as a usable non-Git project',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'apix-missing-git-'));const previous=process.env.PATH;
  try{process.env.PATH='';const result=await projectReadiness({project:{id:'p',path:dir},employees:[],runtimes:[],settings:{provider:'',model:'',apiKeyEnv:''},managerAvailable:false});assert.equal(result.checks[0].state,'missing');assert.match(result.checks[0].message,/Git 安装/);}finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
import {readinessView} from '../dist/web/readiness.js';
const defaults={project:{id:'p',path:'/fixture'},employees:[],runtimes:[],settings:{model:'',apiKeyEnv:''},managerAvailable:false,inspect:async()=>{},policy:{mode:'ask_approval'}};
test('readiness never treats entry discovery as verified auth, and provides precise missing steps',async()=>{
  const missing=await projectReadiness({...defaults,project:null});
  assert.equal(missing.canPlan,false);assert.equal(missing.canExecute,false);assert.equal(missing.authenticationVerified,false);
  assert.deepEqual(missing.checks.filter(c=>c.state==='missing').map(c=>c.id),['project','manager','employees']);
  assert.match(missing.checks.find(c=>c.id==='manager').message,/npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/);
  const ready=await projectReadiness({...defaults,managerAvailable:true,employees:[{runtime:'codex',enabled:1}],runtimes:[{id:'codex',available:true,managed:true}]});
  assert.equal(ready.canExecute,true);assert.equal(ready.checks.find(c=>c.id==='model').state,'check');
  assert.equal((await projectReadiness({...defaults,inspect:async()=>{throw new Error('failure')}})).checks[0].state,'missing');
});
test('missing credentials, strict budget and read-only permission remain explicit blockers',async()=>{
  const data=await projectReadiness({...defaults,managerAvailable:true,settings:{model:'test',apiKeyEnv:'APIX_TEST_MISSING_READINESS_KEY'},budget:{policy:{limitMinor:10,requireFreshQuota:true},accounts:[]},policy:{mode:'read_only'}});
  assert.equal(data.canPlan,false);assert.equal(data.canExecute,false);
  assert(data.checks.some(c=>c.id==='model'&&c.state==='missing'));assert(data.checks.some(c=>c.id==='budget'&&c.state==='missing'));
  assert(!JSON.stringify(data).includes('APIX_TEST_MISSING_READINESS_KEY'));
});
test('actual readiness rendering escapes messages and only offers known repair actions',()=>{
  const html=readinessView({canExecute:false,checks:[{id:'model',state:'missing',message:'<script>secret</script>',action:'model'},{id:'x',state:'check',message:'unknown',action:'unrecognized'}]});
  assert(html.includes('data-setup-action="model"'));assert(!html.includes('<script>'));assert(!html.includes('data-setup-action="unrecognized"'));assert(html.includes(' open'));
});
test('strict manager quota and money requirements are checked without reserving funds',async()=>{
  const policy={managerAccountId:'a',limitMinor:10,currency:'USD',managerEstimateMinor:null,requireFreshQuota:true};
  const account={id:'a',type:'api',limitMinor:null,currency:'USD',quotaState:'stale'};
  for(const accounts of [[account],[{...account,quotaState:'known'}]]){
    const data=await projectReadiness({...defaults,managerAvailable:true,budget:{policy,accounts}});
    assert.equal(data.canPlan,false);assert(data.checks.some(c=>c.id==='budget'&&c.state==='missing'));
  }
  const data=await projectReadiness({...defaults,managerAvailable:true,budget:{policy:{...policy,managerEstimateMinor:1},accounts:[{...account,quotaState:'known'}]}});
  assert.equal(data.canPlan,true);
});
