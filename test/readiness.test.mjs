import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectReadiness} from '../src/readiness.mjs';
import {readinessView} from '../dist/web/readiness.js';
const defaults={project:{id:'p',path:'/fixture'},employees:[],runtimes:[],settings:{model:'',apiKeyEnv:''},managerAvailable:false,inspect:async()=>{},policy:{mode:'ask_approval'}};
test('readiness never treats entry discovery as verified auth, and provides precise missing steps',async()=>{
  const missing=await projectReadiness({...defaults,project:null});
  assert.equal(missing.canPlan,false);assert.equal(missing.canExecute,false);assert.equal(missing.authenticationVerified,false);
  assert.deepEqual(missing.checks.filter(c=>c.state==='missing').map(c=>c.id),['project','manager','employees']);
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
