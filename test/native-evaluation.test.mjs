import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {previousReservation,main,allocateNativeBudget} from '../scripts/evaluation/evaluate-native-collaboration.mjs';
import {startDeliveryFixture} from './delivery-fixture.mjs';

test('native evaluation carries prior reservation and every retained native attempt without resetting the total',()=>{
 const root=mkdtempSync(join(tmpdir(),'apix-native-budget-'));
 for(const [name,value] of [['native-first',.25],['native-failed',.5],['other-suite',30]]){mkdirSync(join(root,name));writeFileSync(join(root,name,'budget.json'),JSON.stringify({reservedCny:value}));}
 const result=previousReservation(root);assert.equal(result.baselineReservedCny,1.972464);assert.equal(result.later.length,2);assert.equal(result.reservedCny,2.722464);
});

test('employee upper bound is reserved once across retries while manager charges keep accumulating',()=>{
 const first=allocateNativeBudget({reservedCny:2,later:[]},10);assert.equal(first.workerReservation,10);assert.equal(first.remaining,8);
 const retry=allocateNativeBudget({reservedCny:12.2,later:[{workerReservationCny:10}]},10);assert.equal(retry.workerReservation,0);assert.equal(retry.remaining,7.800000000000001);
 assert.throws(()=>allocateNativeBudget({reservedCny:1.972464,later:[]},20),/20 CNY.*exhausted/);
 assert.throws(()=>allocateNativeBudget({reservedCny:22.462128,later:[{workerReservationCny:20}]},20),/20 CNY.*exhausted/);
});

test('native inference cannot start without explicit worker billing confirmation',{timeout:40000},async()=>{
 await assert.rejects(()=>main(['--approve-cost']),/confirmation.*included/);
 await assert.rejects(()=>main(['--approve-cost','--workers-max-cny','21']),/upper bound/);
 await assert.rejects(()=>main(['--approve-cost','--workers-max-cny','invalid']),/upper bound/);
});

test('native evaluation can freeze its test plan before permissions allow automatic dispatch',{timeout:60000},async()=>{
 let employeeId;const h=await startDeliveryFixture({startupMs:30000,requestMs:30000,plan:()=>({steps:[{employeeId,prompt:'inspect isolated files',dependsOn:[]}]})});
 try{
  employeeId=(await h.request('/api/employees',{runtime:'codex',name:'plan gate',role:'inspect'})).id;
  await h.request('/api/permissions',{projectId:h.projectId,subject:employeeId,mode:'ask_approval',version:0});
  let s=await h.request('/api/coordination/sessions',{projectId:h.projectId,goal:'inspect isolated files'});const base='/api/coordination/sessions/'+s.id;
  for(const[field,value]of Object.entries({scope:'isolated fixture',constraints:'read only',deliverable:'report',acceptance:'observed files'}))s=await h.request(base+'/answers',{revision:s.revision,field,value});
  s=await h.request(base+'/confirm',{revision:s.revision});assert.equal(s.status,'plan_review');assert.equal((await h.request('/api/snapshot')).runs.length,0);
  s=await h.request(base+'/plan',{revision:s.revision,planVersion:s.planVersion,steps:[{employeeId,prompt:'fixed controlled task',dependsOn:[]}]});
  await h.request('/api/permissions',{projectId:h.projectId,subject:employeeId,mode:'full_access',version:1});
  s=await h.request(base+'/dispatch',{planVersion:s.planVersion});assert.equal(s.failures.length,0);assert.equal(s.tasks[0].prompt,'fixed controlled task');
  for(const r of (await h.request('/api/snapshot')).runs.filter(r=>r.status==='running'))await h.request('/api/runs/'+r.id+'/stop',{});
 }finally{await h.close();}
});
