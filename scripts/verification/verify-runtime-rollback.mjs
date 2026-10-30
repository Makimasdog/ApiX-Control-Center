import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {DatabaseSync,backup} from 'node:sqlite';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
import {fetch} from '../../test/local-fetch.mjs';
import {serviceDiagnostics,waitServiceReady,stopService} from '../../test/service-diagnostics.mjs';
const base='8b754efeffd363535da60beca36b5eb2685f133c',output=await mkdtemp(join(tmpdir(),'apix-runtime-rollback-')),oldRoot=join(output,'previous');await mkdir(oldRoot);
const h=await startDeliveryFixture({legacy:true,startupMs:30000,runtimeEntries:{APIX_CODEX_ENTRY:resolve('test/fake-native-runtime.mjs')}});let old;
async function done(request,id){for(let i=0;i<300;i++){const d=await request('/api/tasks/'+id+'/details');if(d.task.status==='completed')return d;await new Promise(r=>setTimeout(r,30));}throw new Error('回退夹具未结束');}
try{
 const employee=await h.request('/api/employees',{runtime:'codex',name:'rollback',role:'只读'});await h.request('/api/employees/'+employee.id+'/runtime-settings',{expectedVersion:0,backend:'codex-app-server',acknowledgeExperimental:true});await h.request('/api/permissions',{projectId:h.projectId,subject:employee.id,mode:'full_access',version:0});const task=await h.request('/api/tasks',{projectId:h.projectId,employeeId:employee.id,prompt:'只读原生核查'});const run=await h.request('/api/approvals/'+task.approvalId,{approved:true});await done(h.request,task.taskId);await h.request('/api/employees/'+employee.id+'/runtime-settings',{expectedVersion:1,backend:'cli'});
 execFileSync('git',['archive',base,'--format=tar','-o',join(output,'previous.tar'),'--','src','web','test','server.mjs','control-plane.mjs','agent-discovery.mjs','package.json','tsconfig.json']);execFileSync('tar',['-xf',join(output,'previous.tar'),'-C',oldRoot]);await symlink(resolve('node_modules'),join(oldRoot,'node_modules'),'junction');execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--project',join(oldRoot,'tsconfig.json')],{cwd:oldRoot,windowsHide:true,stdio:'pipe'});
 const data=join(output,'old-data');await mkdir(data);const db=new DatabaseSync(join(h.dir,'data','apix.sqlite'));try{await backup(db,join(data,'apix.sqlite'));}finally{db.close();}
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
 const env={...process.env,PORT:String(port),APIX_DATA_DIR:data,APIX_LEGACY_API:'1',APIX_CODEX_ENTRY:resolve('test/fake-native-runtime.mjs')};old=spawn(process.execPath,['server.mjs'],{cwd:oldRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});await waitServiceReady(serviceDiagnostics(old,env),origin+'/api/manager/providers',{timeoutMs:30000});
 async function request(path,body){const r=await fetch(origin+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
 assert.equal((await request('/api/tasks/'+task.taskId+'/details')).task.status,'completed');const fallback=await request('/api/tasks',{projectId:h.projectId,employeeId:employee.id,prompt:'全新 CLI 回退核查'});await request('/api/approvals/'+fallback.approvalId,{approved:true});assert((await done(request,fallback.taskId)).task.result.includes('CLI 回退完成'));
 const check=new DatabaseSync(join(data,'apix.sqlite'));try{assert.equal(check.prepare('SELECT backend FROM agent_run_bindings WHERE run_id=?').get(run.runId).backend,'codex-app-server');assert.equal(check.prepare('SELECT COUNT(*) n FROM agent_run_bindings').get().n,1);}finally{check.close();}
 const report={base,passed:['new-native-run','explicit-cli-fallback','consistent-sqlite-copy','previous-binary-read','previous-binary-cli-run','new-tables-retained'],paidModelCalls:0,output};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await stopService(old);await h.close();}
