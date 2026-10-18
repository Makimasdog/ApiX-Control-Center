import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createScheduling} from '../dist/src/scheduling.js';
import {createAssistantInference} from '../dist/src/assistant-inference.js';
import {ModelCleanupUnknownError} from '../dist/src/model-backend.js';

function fixture(work){
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p');CREATE TABLE employees(id TEXT);CREATE TABLE tasks(id TEXT);CREATE TABLE runs(id TEXT,status TEXT)");
 const store={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};
 const s=createScheduling(store,{employees:()=>[],available:()=>true,denied:()=>false,waiting:()=>null});
 s.saveAccount({id:'shared',version:0,alias:'shared',type:'api',currency:'USD',limitMinor:100,remainingPercent:90,reservePercent:0,observedAt:new Date().toISOString()});
 s.savePolicy('p',{version:0,requireFreshQuota:false,managerAccountId:'shared',managerEstimateMinor:1});
 db.exec("CREATE TRIGGER refuse_settlement BEFORE UPDATE ON scheduling_reservations BEGIN SELECT RAISE(FAIL,'ledger private-accounting-secret');END;");
 return Promise.resolve().then(()=>work(s,store)).finally(()=>db.close());
}
for(const primary of [true,false])test(`real SQLite settlement failure preserves safety, primary=${primary}`,{timeout:5000},()=>fixture(async(s,store)=>{
 const previous=process.env.APIX_ACCOUNTING_TEST_KEY;process.env.APIX_ACCOUNTING_TEST_KEY='private-accounting-secret';const records=[];let calls=0;
 const deps={settings:()=>({apiKeyEnv:'APIX_ACCOUNTING_TEST_KEY'}),account:()=> 'shared',reserve:s.reserveManager,settle:s.settle,pause:s.pauseAccountId,quotaFailure:()=>false,recordFailure:r=>records.push(r),infer:async()=>{calls++;if(primary)throw new ModelCleanupUnknownError('model resource unknown');return 'ok';}};
 const infer=createAssistantInference(deps);
 try{await assert.rejects(infer('p','task',undefined,'chat'),e=>{if(primary)assert(e instanceof ModelCleanupUnknownError);else assert.equal(e.code,'INFERENCE_ACCOUNTING_UNKNOWN');assert(e.accountingFailures.some(f=>f.stage==='settle'&&!f.error.includes('private-accounting-secret')));return true;});assert(records.some(r=>r.stage==='settle'));assert.equal(store.row('SELECT state FROM scheduling_reservations').state,'reserved');
 await assert.rejects(infer('p','again',undefined,'chat'),/暂停|核对|账本/);assert.equal(calls,1);
 // Reconstruct the scheduler, clearing in-memory active managers, with the unresolved ledger intact.
 const restored=createScheduling(store,{employees:()=>[],available:()=>true,denied:()=>false,waiting:()=>null});assert.throws(()=>restored.reserveManager('assistant:new','p'),/暂停|核对/);
 store.db.exec('DROP TRIGGER refuse_settlement');const reservation=store.row('SELECT id FROM scheduling_reservations');restored.settleReported('p',{id:reservation.id,reviewed:true,confirmedStopped:true,actualMinor:1});assert.equal(store.row('SELECT state FROM scheduling_reservations').state,'settled');
 }finally{if(previous===undefined)delete process.env.APIX_ACCOUNTING_TEST_KEY;else process.env.APIX_ACCOUNTING_TEST_KEY=previous;}
}));

test('real pause failure is recorded independently and blocks shared-account restart',{timeout:5000},()=>fixture(async(s,store)=>{
 store.db.exec("DROP TRIGGER refuse_settlement;CREATE TABLE assistant_events(kind TEXT,body TEXT);CREATE TRIGGER refuse_pause BEFORE INSERT ON scheduling_account_pauses BEGIN SELECT RAISE(FAIL,'pause failed');END;");
 s.saveAccount({id:'shared',version:1,alias:'shared',type:'api',currency:'USD',limitMinor:null,remainingPercent:90,reservePercent:0,observedAt:new Date().toISOString()});s.savePolicy('p',{version:1,requireFreshQuota:false,managerAccountId:'shared',managerEstimateMinor:null});
 const infer=createAssistantInference({settings:()=>({apiKeyEnv:'NONE'}),account:()=> 'shared',reserve:s.reserveManager,settle:s.settle,pause:s.pauseAccountId,quotaFailure:()=>true,recordFailure:r=>store.db.prepare('INSERT INTO assistant_events VALUES (?,?)').run('inference_accounting_failure',JSON.stringify(r)),infer:async()=>{throw new ModelCleanupUnknownError('quota cleanup unknown');}});
 await assert.rejects(infer('p','task'),e=>{assert(e instanceof ModelCleanupUnknownError);assert(e.accountingFailures.some(f=>f.stage==='pause'&&f.persisted));return true;});assert.equal(store.row('SELECT state FROM scheduling_reservations').state,'unmeasured');
 const restored=createScheduling(store,{employees:()=>[],available:()=>true,denied:()=>false,waiting:()=>null});assert.throws(()=>restored.reserveManager('assistant:new','p'),/账本|核对/);
}));
