import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createScheduling,taskProfile,overlaps} from '../dist/src/scheduling.js';
import {createPlanningMeetings} from '../dist/src/planning-meetings.js';
import {createEmployeeInsights} from '../dist/src/employee-insights.js';

async function fixture(work){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE employees(id TEXT PRIMARY KEY,deleted_at TEXT);CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE tasks(id TEXT PRIMARY KEY,employee_id TEXT,status TEXT);CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,started_at TEXT,ended_at TEXT);CREATE TABLE events(run_id TEXT,source TEXT,kind TEXT,payload TEXT);INSERT INTO employees VALUES ('a',NULL),('b',NULL);INSERT INTO projects VALUES ('p'),('q');`);
  const store={db,row:(s,...p)=>db.prepare(s).get(...p),rows:(s,...p)=>db.prepare(s).all(...p),now:()=>new Date().toISOString()};
  let denied=false;
  const s=createScheduling(store,{employees:()=>[{id:'a',name:'A',runtime:'pi',enabled:1},{id:'b',name:'B',runtime:'claude',enabled:1}],available:()=>true,denied:()=>denied,waiting:()=>null});
  try{await work(s,store,()=>denied=true);}finally{db.close();}
}
const account=(id='shared',limitMinor=100)=>({id,version:0,alias:id,type:'api',currency:'USD',limitMinor,remainingPercent:90,reservePercent:10,observedAt:new Date().toISOString()});
const profile=(id='shared')=>({version:0,model:'model-v1',tags:['typescript'],tools:['git'],languages:['TypeScript'],projectIds:['p'],accountId:id,contextTokens:32000});
test('capability gates, quota freshness and new model history remain explainable',()=>fixture((s,store,deny)=>{
  s.saveAccount(account());s.saveProfile('a',profile());
  const spec=taskProfile({tags:['typescript'],tools:['git'],contextTokens:2000});
  let candidates=s.candidates('p',spec);assert.equal(candidates[0].employeeId,'a');assert.equal(candidates[0].eligible,true);assert.match(candidates[1].reasons.join(','),/能力标签/);
  assert.throws(()=>s.saveProfile('a',profile()),/已变化/);
  assert.throws(()=>s.saveAccount({...account(),version:1,remainingPercent:90,observedAt:null}),/观测时间/);
  store.db.exec("INSERT INTO tasks VALUES ('t','a','completed');INSERT INTO runs VALUES ('r','t','2026-10-11T00:00:00Z','2026-10-11T00:00:02Z')");s.bind('t',{kind:'testing'},{});s.attempt('r','t','a');
  assert.equal(s.candidates('p',taskProfile({kind:'testing'}))[0].history.samples,0,'exit zero is not accepted');
  store.db.exec("UPDATE tasks SET status='accepted' WHERE id='t';INSERT INTO events VALUES ('r','user','task_reviewed','{\"accepted\":true}')");assert.equal(s.candidates('p',taskProfile({kind:'testing'}))[0].history.accepted,0,'declared model is not an observed model');s.observeModel('r',{model:'model-v1'});assert.equal(s.candidates('p',taskProfile({kind:'testing'}))[0].history.accepted,1);
  store.db.exec("INSERT INTO events VALUES ('r','user','task_reviewed','{\"type\":\"task_reviewed\",\"accepted\":true}')");assert.equal(s.candidates('p',taskProfile({kind:'testing'}))[0].history.accepted,1,'a custom runtime named user cannot forge a human review with native JSON');
  store.db.exec("INSERT INTO runs VALUES ('retry','t','2026-10-11T00:00:03Z','2026-10-11T00:00:05Z');INSERT INTO events VALUES ('retry','user','task_reviewed','{\"accepted\":false}')");s.attempt('retry','t','a');s.observeModel('retry',{model:'model-v1'});assert.equal(s.candidates('p',taskProfile({kind:'testing'}))[0].history.rework,1,'review evidence persists across retries');
  s.saveProfile('a',{...profile(),version:1,model:'model-v2'});assert.equal(s.candidates('p',taskProfile({kind:'testing'}))[0].history.samples,0);
  s.saveAccount({...account(),version:1,observedAt:'2020-01-01T00:00:00Z'});s.savePolicy('p',{version:0,requireFreshQuota:true,quotaMaxAgeMinutes:60});
  assert.equal(s.candidates('p',spec).find(c=>c.employeeId==='a').eligible,false);assert.equal(s.view('p').accounts[0].quotaState,'stale');
  deny();assert.match(s.candidates('p',spec)[0].reasons.join(','),/只读/);
}));
test('shared account reservations prevent overspend across projects and unknown fees remain held',()=>fixture(s=>{
  s.saveAccount(account());s.saveProfile('a',profile());s.saveProfile('b',profile());
  s.reserve('first','p','a',taskProfile({estimateMinor:60}));
  assert.throws(()=>s.reserve('second','q','b',taskProfile({estimateMinor:50})),/超过预算/);
  assert.throws(()=>s.reserve('first','p','a',taskProfile({estimateMinor:1})),/重复/);
  s.settle('first',null);assert.equal(s.view('q').accounts[0].committedMinor,60);assert.equal(s.view('p').ledger[0].state,'unmeasured');
  s.settleReported('p',{id:'first',actualMinor:20,reviewed:true});assert.equal(s.view('q').accounts[0].committedMinor,20);
  assert.throws(()=>s.settleReported('p',{id:'first',actualMinor:0,reviewed:true}),/只能/);
  s.reserve('second','q','b',taskProfile({estimateMinor:50}));s.settle('second',null,true);assert.equal(s.view('q').accounts[0].committedMinor,20);
  assert.throws(()=>s.saveAccount({...account(),version:1,currency:'EUR'}),/币种/);
  assert.throws(()=>taskProfile({estimateMinor:1.5}),/非负整数/);
  assert.throws(()=>s.saveAccount({...account('sub'),type:'subscription'}),/不能换算金额/);
}));
test('parallel file ownership must be disjoint and strict budget requires an explicit cap at launch',()=>fixture(s=>{
  s.saveAccount(account());s.saveProfile('a',profile());s.savePolicy('p',{version:0,requireFreshQuota:false,limitMinor:100,currency:'USD'});
  const steps=[{employeeId:'a',prompt:'one',dependsOn:[],scheduling:taskProfile({writePaths:['src']})},{employeeId:'a',prompt:'two',dependsOn:[],scheduling:taskProfile({writePaths:['src/a.ts']})}];
  assert.throws(()=>s.assign('p',steps,false),/重叠/);steps[1].dependsOn=[0];assert.equal(s.assign('p',steps,false).length,2);
  assert.throws(()=>s.reserve('missing','p','a',taskProfile()),/费用上界/);
  assert.throws(()=>taskProfile({writePaths:['../secrets']}),/相对路径/);
  assert.throws(()=>taskProfile({writePaths:['src/*.ts']}),/通配符/);
  if(process.platform==='win32')assert.equal(overlaps(['src'],['SRC/a.ts']),true);
}));
test('balanced candidates compare declared per-task costs without inventing unknown fees',()=>fixture(s=>{
  s.saveAccount(account());for(const id of ['a','b'])s.saveProfile(id,{...profile(),projectIds:[]});
  const spec=taskProfile({estimates:[{employeeId:'a',estimateMinor:80,minutes:5},{employeeId:'b',estimateMinor:20,minutes:15}]});
  assert.equal(s.candidates('p',spec,'a')[0].employeeId,'b');
  s.reserve('chosen','p','b',spec);assert.equal(s.view('p').committedMinor,20);
  s.reserve('later','p','a',spec);assert.equal(s.view('p').committedMinor,100);
  assert.throws(()=>s.reserve('extra','p','b',taskProfile({estimateMinor:1})),/超过预算/);
}));
test('review steps prefer another eligible employee and explicitly label self-review or unknown independence',()=>fixture(s=>{
  const build={prompt:'build',employeeId:'a',dependsOn:[]};const review={prompt:'review',employeeId:'a',dependsOn:[0],scheduling:taskProfile({kind:'review'})};
  const independent=s.assign('p',[build,review],true);assert.equal(independent[1].employeeId,'b');assert.equal(independent[1].decision.reviewMode,'independent');
  const self=s.assign('p',[build,{...review,scheduling:taskProfile({kind:'review',fixedEmployeeId:'a'})}],true);assert.equal(self[1].decision.reviewMode,'self_review');
  assert.equal(s.assign('p',[{...review,dependsOn:[]}],true)[0].decision.reviewMode,'unverified_independence');
}));
test('manager calls share worker budget and block before inference when quota or fees are unknown',()=>fixture(s=>{
  s.saveAccount(account());s.saveProfile('a',profile());
  s.savePolicy('p',{version:0,requireFreshQuota:false,limitMinor:100,currency:'USD'});
  assert.throws(()=>s.reserveManager('apix:missing','p'),/推理账户/);
  s.savePolicy('p',{version:1,requireFreshQuota:false,limitMinor:100,currency:'USD',managerAccountId:'shared',managerEstimateMinor:30});
  assert.equal(s.reserveManager('apix:first','p'),true);assert.throws(()=>s.reserve('worker','p','a',taskProfile({estimateMinor:80})),/超过预算/);
  s.settle('apix:first',null);assert.equal(s.view('p').committedMinor,30);
}));
test('a quota failure pauses all employees sharing an account until explicit reviewed recovery',()=>fixture(s=>{
  s.saveAccount(account());for(const id of ['a','b'])s.saveProfile(id,profile());
  s.pauseAccount('a','failed-run');assert.throws(()=>s.reserve('other-project','q','b',taskProfile({estimateMinor:10})),/共享账户/);
  assert.throws(()=>s.resumeAccount({id:'shared',version:1}),/确认/);
  s.resumeAccount({id:'shared',version:1,reviewed:true});s.reserve('other-project','q','b',taskProfile({estimateMinor:10}));
}));
test('subscription quota history cannot be charged against a later API money budget',()=>fixture(s=>{
  s.saveAccount({id:'subscription',alias:'sub',type:'subscription',version:0});s.saveProfile('a',profile('subscription'));
  s.reserve('subscription-run','p','a',taskProfile());s.settle('subscription-run',null);
  s.saveAccount(account());s.saveProfile('a',{...profile(),version:1});s.savePolicy('p',{version:0,requireFreshQuota:false,limitMinor:100,currency:'USD',managerAccountId:'shared',managerEstimateMinor:5});
  s.reserve('api-run','p','a',taskProfile({estimateMinor:50}));assert.equal(s.view('p').committedMinor,50);
}));
test('active manager reservations cannot be manually released; restart leftovers require stop confirmation',()=>fixture((s,store)=>{
  store.db.exec("ALTER TABLE runs ADD COLUMN status TEXT DEFAULT 'completed'");
  s.saveAccount(account());s.savePolicy('p',{version:0,requireFreshQuota:false,managerAccountId:'shared',managerEstimateMinor:10});s.reserveManager('apix:active','p');
  assert.throws(()=>s.settleReported('p',{id:'apix:active',reviewed:true,confirmedStopped:true,actualMinor:0}),/活动运行/);
  store.db.prepare('INSERT INTO scheduling_reservations VALUES (?,?,?,?,?,?,?,?)').run('apix:orphan','p','shared',20,'USD','reserved',null,new Date().toISOString());
  assert.throws(()=>s.settleReported('p',{id:'apix:orphan',reviewed:true,actualMinor:5}),/确认原进程/);
  s.settleReported('p',{id:'apix:orphan',reviewed:true,confirmedStopped:true,actualMinor:5});assert.equal(s.view('p').committedMinor,15);
}));
test('meeting failures retain proposals and reservations; a configuration change marks the result stale',()=>fixture(async(s,store)=>{
  store.db.exec("CREATE TABLE coordination_sessions(id TEXT PRIMARY KEY);CREATE TABLE plans(id TEXT PRIMARY KEY);INSERT INTO coordination_sessions VALUES ('session');INSERT INTO plans VALUES ('plan'),('new-plan');");
  s.saveAccount(account());for(const id of ['a','b'])s.saveProfile(id,profile());
  const meeting=createPlanningMeetings(store,s,async id=>{if(id==='b')throw new Error('participant timeout');return JSON.stringify({claims:[{step:0,reason:'can verify',minutes:3}],decline:''});});
  const steps=[{employeeId:'a',prompt:'verify',dependsOn:[]}];
  await assert.rejects(meeting.run('session','plan','p',steps,{participants:[{employeeId:'a'}]},()=>{}),/批准/);
  const result=await meeting.run('session','plan','p',steps,{approved:true,participants:[{employeeId:'a',estimateMinor:20},{employeeId:'b',estimateMinor:20}]},()=>{});
  assert.equal(result[0].status,'partial');assert.equal(result[0].body.proposals[1].status,'failed');assert.equal(s.view('p').committedMinor,40);
  assert.throws(()=>meeting.proposed('session','plan','p',result[0].id,steps),/失败或中断/);
  const stale=createPlanningMeetings(store,s,async()=>{s.saveProfile('a',{...profile(),version:1,model:'different-model'});return JSON.stringify({claims:[],decline:'need input'});});
  const changed=await stale.run('session','new-plan','p',steps,{approved:true,participants:[{employeeId:'a',estimateMinor:20}]},()=>{});
  assert.equal(changed.at(-1).status,'stale');
}));
test('partial native usage never invents a missing output count',()=>fixture((s,store)=>{
  store.db.exec("INSERT INTO tasks VALUES ('t','a','completed');INSERT INTO runs VALUES ('r','t','2026-10-11T00:00:00Z',NULL)");
  const insights=createEmployeeInsights(store);insights.observe('r','codex',{type:'turn.completed',usage:{input_tokens:100}});
  const usage=store.row('SELECT * FROM apix_run_usage WHERE run_id=?','r');assert.equal(usage.input_tokens,100);assert.equal(usage.output_tokens,null);assert.equal(usage.cached_tokens,null);
}));
