import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {startDeliveryFixture} from './delivery-fixture.mjs';
async function until(check){for(let i=0;i<400;i++){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw new Error('native HTTP fixture deadline');}
test('App Server HTTP settings, interaction, guidance idempotency, usage, history and restart use real adapters',{timeout:90000},async()=>{
 const h=await startDeliveryFixture({legacy:true,startupMs:30000,runtimeEntries:{APIX_CODEX_ENTRY:resolve('test/fake-native-runtime.mjs')}});
 try{
 const employee=await h.request('/api/employees',{name:'原生员工',runtime:'codex',role:'只读核查'}),settings='/api/employees/'+employee.id+'/runtime-settings';
 await h.request(settings,{expectedVersion:0,backend:'codex-app-server',acknowledgeExperimental:true});
 await h.request('/api/permissions',{projectId:h.projectId,subject:employee.id,mode:'full_access',version:0});
 const task=await h.request('/api/tasks',{projectId:h.projectId,employeeId:employee.id,prompt:'hold ask 中文核查'});const {runId}=await h.request('/api/approvals/'+task.approvalId,{approved:true});const base='/api/runs/'+runId;
 const question=await until(async()=>{const items=await h.request(base+'/interactions');return items.find(i=>i.state==='pending');});assert.equal((await h.request(base+'/runtime')).phase,'waiting_input');
 await h.request(settings,{expectedVersion:1,backend:'cli'},409);
 const message={requestId:'guidance001',content:'保持原范围',mode:'steer'},first=await h.request(base+'/messages',message);assert.equal(first.delivery,'accepted');assert.deepEqual(await h.request(base+'/messages',message),first);await h.request(base+'/messages',{...message,content:'不同内容'},409);
 const answer={requestId:'answer001',expectedPermissionVersion:question.permissionVersion,answer:{answers:{choice:{answers:['只读']}}}};await h.request(base+'/interactions/'+question.id+'/answer',{...answer,expectedPermissionVersion:'wrong'},409);
 // 错版本会使原请求失效；本次 Run 必须停止，不偷偷批准。
 await h.request(base+'/stop',{});await until(async()=>['cancelled','unknown'].includes((await h.request('/api/tasks/'+task.taskId+'/details')).task.status));
 const next=await h.request('/api/tasks',{projectId:h.projectId,employeeId:employee.id,prompt:'ask 中文核查'});const second=await h.request('/api/approvals/'+next.approvalId,{approved:true});const nextBase='/api/runs/'+second.runId;
 const item=await until(async()=>{const items=await h.request(nextBase+'/interactions');return items.find(i=>i.state==='pending');});const reply={requestId:'answer002',expectedPermissionVersion:item.permissionVersion,answer:{answers:{choice:{answers:['只读']}}}};
 assert.equal((await h.request(nextBase+'/interactions/'+item.id+'/answer',reply)).delivery,'accepted');assert.equal((await h.request(nextBase+'/interactions/'+item.id+'/answer',reply)).delivery,'accepted');
 const complete=await until(async()=>{const d=await h.request('/api/tasks/'+next.taskId+'/details');return d.task.status==='completed'&&d;});assert(complete.task.result.includes('中文公开输出'));assert.equal(complete.runs[0].runtimeInfo.stopEvidence,'quiescent');assert.equal(complete.runs[0].runtime,'codex');
 const info=await h.request('/api/employees/'+employee.id+'/details');assert.equal(info.runs.find(r=>r.id===second.runId).input_tokens,10);const page=await h.request(nextBase+'/runtime-events?limit=2');assert.equal(page.items.length,2);assert(page.hasMore);await h.request(base+'/runtime-events?afterId='+page.items[0].id,undefined,400);
 const runtimeEvents=await h.request(nextBase+'/runtime-events');assert(runtimeEvents.items.some(e=>e.kind==='runtime.stop'&&e.payload.reason==='tree_stopped'&&e.payload.treeStopConfirmed&&e.payload.rootClosed));
 const json=JSON.stringify(runtimeEvents);assert(!json.includes('session-fixture'));assert(!json.includes('native_session_id'));
 await h.restart();assert.equal((await h.request(nextBase+'/runtime')).phase,'completed');assert.equal((await h.request(nextBase+'/interactions')).filter(i=>i.state==='pending').length,0);assert.equal((await h.request('/api/employees/'+employee.id+'/details')).runtimeSettings.backend,'codex-app-server');await h.request(settings,{expectedVersion:1,backend:'cli'});const fallback=await h.request('/api/tasks',{projectId:h.projectId,employeeId:employee.id,prompt:'全新 CLI 核查'});const started=await h.request('/api/approvals/'+fallback.approvalId,{approved:true});await until(async()=>{const details=await h.request('/api/tasks/'+fallback.taskId+'/details');return details.task.status==='completed';});assert.equal((await h.request('/api/runs/'+started.runId+'/runtime')).backend,'cli');assert.equal((await h.request(nextBase+'/runtime')).backend,'codex-app-server');assert.equal(h.calls.length,0);
 }finally{await h.close();}
});

test('reviewed native recovery creates a new Run and original mailbox credentials stay revoked',{timeout:90000},async()=>{
 let employeeId;const h=await startDeliveryFixture({startupMs:30000,requestMs:30000,runtimeEntries:{APIX_CODEX_ENTRY:resolve('test/fake-native-runtime.mjs')},plan:()=>({steps:[{employeeId,prompt:'只读核查 README，给出中文报告',dependsOn:[]}]}),setup:async project=>{
 await writeFile(join(project,'README.md'),'只读来源');for(const args of [['init'],['config','user.name','ApiX Fixture'],['config','user.email','test@example.invalid'],['add','README.md'],['commit','-m','fixture']])execFileSync('git',args,{cwd:project,stdio:'ignore'});
 }});
 try{
 employeeId=(await h.request('/api/employees',{name:'原生员工',runtime:'codex',role:'核查'})).id;await h.request('/api/employees/'+employeeId+'/runtime-settings',{expectedVersion:0,backend:'codex-app-server',acknowledgeExperimental:true});await h.request('/api/permissions',{projectId:h.projectId,subject:employeeId,mode:'full_access',version:0});
 let session=await h.request('/api/coordination/sessions',{projectId:h.projectId,goal:'只读核查 README 并报告其来源与限制'});const base='/api/coordination/sessions/'+session.id;
 for(const [field,value] of Object.entries({scope:'只读取项目 README 文件',constraints:'不得修改现有文件，不访问外部服务',deliverable:'中文事实报告、来源与未验证项',acceptance:'明确区分事实与未知，不宣称执行了测试'}))session=await h.request(base+'/answers',{revision:session.revision,field,value});
 session=await h.request(base+'/confirm',{revision:session.revision});if(session.status==='plan_review')session=await h.request(base+'/dispatch',{planVersion:session.planVersion});assert.equal(session.failures.length,0);const id=session.tasks[0].id;
 let details=await until(async()=>{const d=await h.request('/api/tasks/'+id+'/details');return d.task.status==='completed'&&d;});const original=details.runs[0].id;
 await h.request('/api/tasks/'+id+'/review',{accepted:false});const checked=await h.request('/api/tasks/'+id+'/delivery');assert.equal(checked.nativeRecovery,true);session=await h.request(base);
 const recovered=await h.request('/api/tasks/'+id+'/recovery',{revision:session.revision,runId:original,fingerprint:checked.recoveryFingerprint,reviewed:true,employeeId,continuation:'native',resumeFromRunId:original});assert.equal(recovered.failure,null);
 details=await until(async()=>{const d=await h.request('/api/tasks/'+id+'/details');return d.runs.length===2&&d.task.status==='completed'&&d;});assert.notEqual(details.runs[0].id,original);assert(details.task.result.includes('原生延续'));assert.equal(details.runs[0].runtimeInfo.stopEvidence,'quiescent');assert.equal(details.runs[1].status,'completed');assert.equal(h.calls.filter(c=>c.phase==='planning').length,1);
 }finally{await h.close();}
});
test('Claude SDK HTTP requires explicit provider, isolates native configuration and aggregates turn usage',{timeout:60000},async()=>{
 const h=await startDeliveryFixture({legacy:true,startupMs:30000,runtimeEntries:{APIX_CLAUDE_ENTRY:resolve('test/fake-native-runtime.mjs')}});
 try{
 const employee=(await h.request('/api/employees',{runtime:'claude',name:'SDK 员工',role:'核查'})).id;await h.request('/api/employees/'+employee+'/runtime-settings',{expectedVersion:0,backend:'claude-agent-sdk',acknowledgeExperimental:true});await h.request('/api/permissions',{projectId:h.projectId,subject:employee,mode:'full_access',version:0});
 const saved=await h.request('/api/agent-providers',{name:'本地隔离协议夹具',apiType:'anthropic-messages',baseUrl:'http://127.0.0.1:9/v1',model:'fixture-claude',apiKey:'fixture-key-not-a-real-provider',version:0});const provider=saved;const agent=(await h.request('/api/agent-providers')).agents.find(a=>a.id===employee);await h.request('/api/agent-providers/bind',{agentId:employee,providerId:provider.id,providerVersion:provider.version,version:agent.version});
 const task=await h.request('/api/tasks',{projectId:h.projectId,employeeId:employee,prompt:'中文只读核查'});const {runId}=await h.request('/api/approvals/'+task.approvalId,{approved:true});const d=await until(async()=>{const data=await h.request('/api/tasks/'+task.taskId+'/details');return data.task.status==='completed'&&data;});assert(d.task.result.includes('SDK 中文输出'));const info=await h.request('/api/runs/'+runId+'/runtime');assert.equal(info.sdkVersion,'0.3.314');assert.equal(info.capabilities.steer,false);const employeeDetails=await h.request('/api/employees/'+employee+'/details');assert.equal(employeeDetails.runs[0].input_tokens,12);assert.equal(employeeDetails.runs[0].output_tokens,3);assert.equal(h.calls.length,0);
 }finally{await h.close();}
});
