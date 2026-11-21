import assert from 'node:assert/strict';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
import {assistantPromptContext} from '../../test/assistant-prompt-fixture.mjs';

// Interactive browser fixture: only local protocol decisions and worker processes.
const outputRoot=resolve(process.env.APIX_REVIEW_OUTPUT??join(tmpdir(),'apix-recovery-browser-review'));
await mkdir(outputRoot,{recursive:true});
const output=await mkdtemp(join(outputRoot,'run-'));
const calls=[];let primary,alternate,parentId,mainCalls=0;
const model=http.createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert.equal(req.headers.authorization,undefined);
  const prompt=body.messages.at(-1).content;let decision,kind;
  if(prompt.startsWith('APIX_ARCHITECTURE_JSON')){kind='architecture';decision={summary:'本地故障恢复演练：核心文件与后续集成',modules:[{id:'core',name:'核心文件',paths:['a.txt'],dependsOn:[],risk:'low',difficulty:1,workload:{inputTokens:1000,outputTokens:500,calls:1},interfaces:[],dataStructures:[],acceptance:['a.txt 内容为 good，运行真实 verify.mjs'],checkIds:['tests']}]};}
  else if(prompt.startsWith('APIX_PLAN_JSON')){kind='planning';decision={steps:[{moduleId:'core',employeeId:primary,prompt:'实现核心文件 a.txt，并提交真实检查证据',dependsOn:[]}]};}
  else if(prompt.startsWith('APIX_QUALITY_JSON')){kind='quality';decision={passed:true,findings:[],summary:'本地协议夹具接受宿主已运行的检查证据；不是独立人工审查'};}
  else{
   kind='main';mainCalls++;const ctx=assistantPromptContext(prompt);
   if(mainCalls===1)decision={action:'tool',tool:'delegate',args:{goal:'模拟首位员工失败，自动修复核心文件，然后继续后续集成',requirements:{scope:'仅修改 a.txt，现有 verify.mjs 为验收依据',constraints:'隔离本地测试项目，不联网，不使用真实模型，不扩大文件范围',deliverable:'核心文件 good、实际检查及后续集成记录',acceptance:'员工失败后自动改派保留部分文件，核心和集成实际检查通过并验收'}},message:'开始本地故障恢复演练：先执行核心任务，再集成。'};
   else if(ctx.context?.child)decision={action:'finish',outcome:'blocked',message:'员工处于执行或恢复阶段，暂时无法给出最终结果。'};
   else decision={action:'finish',outcome:'completed',message:'本地演练结束：失败员工已自动改派，核心任务和后续集成均已通过宿主检查并验收。所有模型回复与员工进程均为本地夹具，付费调用为 0。'};
  }
  calls.push({kind,at:new Date().toISOString(),...(kind==='main'?{action:decision.action,outcome:decision.outcome}: {})});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision)}}]}));
 }catch(error){calls.push({kind:'fixture_error',message:error.message});res.writeHead(500);res.end('{}');}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
let h;
try{
h=await startDeliveryFixture({name:'员工失败恢复 · 本地浏览器演练',startupMs:30000,requestMs:30000,runtimeEntries:{APIX_SUPERVISION_TICK_MS:'1000'},setup:async project=>{
 await writeFile(join(project,'a.txt'),'initial');
 await writeFile(join(project,'verify.mjs'),"import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync('a.txt','utf8'),'good');console.log('HOST CHECK PASS: a.txt = good');");
 for(const args of [['init'],['config','user.name','Fixture'],['config','user.email','test@example.invalid'],['add','a.txt','verify.mjs'],['commit','-m','local fixture baseline']])execFileSync('git',args,{cwd:project,stdio:'ignore'});
}});
 const worker=join(h.dir,'recovery-worker.mjs');
 await writeFile(worker,`import{writeFileSync,readFileSync,existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';const root=${JSON.stringify(output)};let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',async()=>{const wait=async name=>{while(!existsSync(root+'/'+name))await delay(100);};if(prompt.includes('当前模块：integration')){writeFileSync(root+'/integration-started','true');console.log('后续集成已启动，等待演练继续');await wait('release-integration');console.log('集成完成，交由宿主运行验收');return;}if(process.argv[2]==='primary'&&!existsSync(root+'/failure-injected')){writeFileSync('a.txt','partial work');console.log('首位员工已写入部分成果，等待注入失败');await wait('inject-failure');writeFileSync(root+'/failure-injected','true');process.stderr.write('模拟员工执行失败：预期 good，实际 partial work');process.exitCode=1;return;}writeFileSync(root+'/repair-started',existsSync('a.txt')?readFileSync('a.txt','utf8'):'missing');console.log('替代员工已接手，保留已有内容：'+(existsSync('a.txt')?readFileSync('a.txt','utf8'):'missing'));await wait('release-repair');writeFileSync('a.txt','good');console.log('已修复 a.txt = good，交由宿主运行真实检查');});`);
 for(const[id,mode]of[['browser-primary','primary'],['browser-replacement','replacement']])await h.request('/api/adapters',{id,name:id,executable:process.execPath,args:[worker,mode],format:'plain'});
 primary=(await h.request('/api/employees',{name:'首位员工（故障注入）',runtime:'browser-primary',role:'核心实现'})).id;
 alternate=(await h.request('/api/employees',{name:'替代员工（本地夹具）',runtime:'browser-replacement',role:'修复与集成'})).id;
 for(const id of [primary,alternate])await h.request('/api/employees/'+id+'/capabilities',{version:0,model:'',reasoningLevel:3,contextTokens:32000,tags:[],tools:[],languages:[],projectIds:[]});
 const workflow=await h.request('/api/projects/'+h.projectId+'/workflow');await h.request('/api/projects/'+h.projectId+'/workflow',{version:workflow.version,enabled:true,approved:true,managerVersion:workflow.manager.version,employees:[primary,alternate].map(id=>({id,version:0}))});
 await h.request('/api/projects/'+h.projectId+'/autonomy',{version:0,enabled:true,approved:true,maxRepairs:2,maxMinutes:20,maxRunMinutes:15,checkpointMinutes:10,autoReassign:true,taskCapMinor:null,checks:[{id:'tests',args:['verify.mjs'],timeoutMs:5000}]});
 await h.request('/api/manager/settings',{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'local-recovery-protocol-fixture',apiType:'openai-completions',apiKeyEnv:''});
 const parent=await h.request('/api/assistant/sessions',{projectId:h.projectId});parentId=parent.id;
 const ownerFile=join(h.dir,'browser-owner.json');await writeFile(ownerFile,JSON.stringify({token:process.env.APIX_OWNER_TOKEN}));
 const manifest={origin:h.origin,projectId:h.projectId,parentId,primary,alternate,ownerFile,output};
 await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
 let finish;const done=new Promise(resolve=>{finish=resolve;process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
 let reading=false;const timer=setInterval(async()=>{if(reading)return;if(existsSync(join(output,'stop-fixture'))){finish();return;}reading=true;try{
  const parent=await h.request('/api/assistant/sessions/'+parentId),childId=parent.child_session_id??parent.events.filter(e=>e.kind==='delegation_result').at(-1)?.body.id;
  const child=childId?await h.request('/api/coordination/sessions/'+childId):null;
  const runs=[];if(child)for(const task of child.tasks){const details=await h.request('/api/tasks/'+task.id+'/details');runs.push({taskId:task.id,runs:details.runs.map(r=>({id:r.id,status:r.status})),result:task.result});}
  await writeFile(join(output,'state.json'),JSON.stringify({parent,child,runs,calls,paidModelCalls:0},null,2));
 }catch(error){console.error(error.message);}finally{reading=false;}},1000);
 await done;clearInterval(timer);
}finally{try{if(h)await h.close();}finally{model.closeAllConnections();await new Promise(r=>model.close(r));}}
