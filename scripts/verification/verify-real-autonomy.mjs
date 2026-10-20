// Opt-in acceptance only. Model responses are real; fixtures and faults are deterministic.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {loadEnvironment} from '../../src/infrastructure/environment.mjs';

const selfCheck=process.argv.includes('--self-check');
const testModel='qwen3.8-27b';
if(!selfCheck&&!process.argv.includes('--approve-cost'))throw new Error('真实模型测试可能产生费用；获准后传入 --approve-cost');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');loadEnvironment(join(root,'.env'));
const parent=join(root,'.tmp-real-autonomy');mkdirSync(parent,{recursive:true});
const dir=mkdtempSync(join(parent,'run-'));const end=Date.now()+20*60000;
const env={...process.env,APIX_DATA_DIR:join(dir,'data'),APIX_LEGACY_API:'0',APIX_SUPERVISION_TICK_MS:'1000'};
// Never silently run this test using a fake entry inherited from another fixture.
for(const name of ['APIX_PI_ENTRY','APIX_MANAGER_PI_ENTRY','APIX_CODEX_ENTRY','APIX_CLAUDE_ENTRY'])if(env[name]&&/fake-|autonomy-ui/i.test(env[name]))throw new Error('真实验收拒绝测试替身入口');
const report={kind:'real autonomous acceptance',managerModel:testModel,startedAt:new Date().toISOString(),dir,cases:[],pass:false,actualCost:'unknown',humanPlanEdits:0};
const redact=value=>{let output=String(value);for(const [name,secret] of Object.entries(env))if(/KEY|TOKEN|SECRET|PASSWORD/i.test(name)&&secret&&secret.length>=6)output=output.replaceAll(secret,'<redacted>');return output;};
const port=await new Promise(done=>{const listener=createServer();listener.listen(0,'127.0.0.1',()=>{const port=listener.address().port;listener.close(()=>done(port));});});env.PORT=String(port);
let server;let cleaning=false;
async function api(path,body){const response=await fetch(`http://127.0.0.1:${port}${path}`,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(cleaning?15000:Math.max(1,Math.min(200000,end-Date.now())))});const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP ${response.status}`);return result;}
async function wait(read,test,deadline=end){while(Date.now()<Math.min(end,deadline)){const value=await read();if(test(value))return value;await delay(300);}throw new Error('达到真实验收时间上限');}
const coreCheck=`import assert from 'node:assert/strict';import {total} from './domain.mjs';
assert.equal(total([{price:120,quantity:2},{price:5,quantity:1}]),245);assert.equal(total([]),0);
for(const value of [[{price:1,quantity:-1}],[{price:1.5,quantity:1}],[{price:1,quantity:'2'}],null])assert.throws(()=>total(value));console.log('CORE_REAL_CHECK_OK');`;
const apiCheck=`import assert from 'node:assert/strict';import {createServer} from 'node:http';import {handler} from './api.mjs';
const server=createServer(handler);await new Promise(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+server.address().port+'/total';
try{for(const [payload,status,expected] of [[{items:[{price:120,quantity:2}]},200,240],[{items:[{price:1,quantity:-1}]},400,null],[{},400,null]]){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(response.status,status);const data=await response.json();if(status===200)assert.equal(data.total,expected);else assert.equal(typeof data.error,'string');}console.log('HTTP_REAL_CHECK_OK');}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}`;
const repairCheck=`import assert from 'node:assert/strict';import {existsSync,writeFileSync} from 'node:fs';import {total} from './domain.mjs';
assert.equal(total([{price:7,quantity:3}]),21);assert.throws(()=>total([{price:7,quantity:-1}]));
if(!process.env.APIX_RUN_ID&&!existsSync('.qa-fault-consumed')){writeFileSync('.qa-fault-consumed','one host fault');throw new Error('APIX_TRANSIENT_FAULT_ONCE: first host check intentionally fails; retain correct code and rerun');}console.log('REPAIR_REAL_CHECK_OK');`;
const git=(project,args)=>execFileSync('git',args,{cwd:project,stdio:'ignore'});
if(selfCheck){
  const project=join(dir,'harness-self-check');mkdirSync(project);
  writeFileSync(join(project,'domain.mjs'),`export function total(items){if(!Array.isArray(items))throw Error('items');return items.reduce((n,i)=>{if(!i||!Number.isSafeInteger(i.price)||!Number.isSafeInteger(i.quantity)||i.price<0||i.quantity<0)throw Error('invalid');return n+i.price*i.quantity;},0);}`);
  writeFileSync(join(project,'api.mjs'),`import {total} from './domain.mjs';export async function handler(req,res){try{let body='';for await(const c of req)body+=c;const value=total(JSON.parse(body).items);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({total:value}));}catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'invalid'}));}}`);
  for(const [name,body] of Object.entries({'verify-core.mjs':coreCheck,'verify-http.mjs':apiCheck,'verify-repair.mjs':repairCheck}))writeFileSync(join(project,name),body);
  for(const script of ['verify-core.mjs','verify-http.mjs'])execFileSync(process.execPath,[script],{cwd:project,stdio:'ignore',timeout:10000});
  assert.throws(()=>execFileSync(process.execPath,['verify-repair.mjs'],{cwd:project,stdio:'pipe',timeout:10000,env:{...process.env,APIX_RUN_ID:''}}),error=>error.status===1&&String(error.stderr).includes('APIX_TRANSIENT_FAULT_ONCE'));
  execFileSync(process.execPath,['verify-repair.mjs'],{cwd:project,stdio:'ignore',timeout:10000});console.log(JSON.stringify({kind:'test harness self-check, no models',managerModel:testModel,pass:true,dir}));process.exit(0);
}
async function scenario(id,goal,files,checks,acceptance,seed={}){
  const result={id,startedAt:new Date().toISOString(),pass:false,stage:'prepare'};report.cases.push(result);
  const project=join(dir,id);mkdirSync(project);writeFileSync(join(project,'README.md'),'isolated real ApiX acceptance\n');writeFileSync(join(project,'.gitignore'),'.qa-fault-consumed\n');
  for(const [name,body] of Object.entries({...files,...seed}))writeFileSync(join(project,name),body);
  git(project,['init']);git(project,['add','--','README.md','.gitignore',...Object.keys({...files,...seed})]);git(project,['-c','user.name=ApiX Test','-c','user.email=test@example.invalid','commit','-m','authorized test fixture']);
  const projectId=(await api('/api/projects',{name:id+' real acceptance',path:project})).id;
  const workers=[];for(const role of id==='T01'?['domain 纯函数实现','HTTP 接口实现']:['局部修复'])workers.push((await api('/api/employees',{name:id+' real Codex '+role,runtime:'codex',role})).id);
  // Test-only capability assumptions, not a measured ability score or tariff.
  for(const worker of workers)await api(`/api/employees/${worker}/capabilities`,{version:0,reasoningLevel:5,contextTokens:200000,model:'',tags:['javascript','nodejs','implementation','testing','review','analysis','git'],tools:['read','write','edit','bash','grep','find','ls','git','node'],projectIds:[projectId]});
  await api(`/api/projects/${projectId}/workflow`,{version:0,enabled:true,approved:true,managerVersion:0,employees:workers.map(id=>({id,version:0}))});
  await api(`/api/projects/${projectId}/autonomy`,{version:0,enabled:true,approved:true,maxRepairs:2,maxMinutes:8,maxRunMinutes:4,checkpointMinutes:1,autoReassign:true,taskCapMinor:null,checks});
  let session=await api('/api/coordination/sessions',{projectId,goal});result.sessionId=session.id;
  for(const [field,value] of Object.entries({scope:id==='T01'?'恰好两个模块：domain.mjs 纯函数模块、api.mjs HTTP 模块，HTTP 依赖纯函数模块。分别交给两个已注册员工，各自承担对应实现角色。仅修改这两个文件。':'一个模块，仅修改 domain.mjs，保留 README、.gitignore 和授权检查脚本。',constraints:'仅使用 Node 内置模块，不安装依赖、不访问项目外文件、不提交或发布、不启动其他 Agent；所有检查脚本只读不可修改。按冻结契约工作，通过 mailbox 确认检查点。',deliverable:id==='T01'?'domain.mjs 导出 total(items)，api.mjs 导出 handler(req,res)。每项 price/quantity 为非负安全整数，非法输入抛错；POST /total 接收 {items:[{price,quantity}]}，返回 200 JSON {total:整数}，非法输入返回 400 JSON {error:字符串}。':'domain.mjs 导出 total(items)，计算 price*quantity 的总和；price/quantity 为非负安全整数，非法输入抛错。验收脚本有一次宿主故障注入，不修改脚本，保持正确实现后按修复要求再次提交。',acceptance}))session=await api(`/api/coordination/sessions/${session.id}/answers`,{revision:session.revision,field,value});
  result.stage='architecture-and-plan';session=await api(`/api/coordination/sessions/${session.id}/confirm`,{revision:session.revision});
  assert(session.autonomy,'must produce frozen autonomous contract');if(id==='T01'){assert.equal(session.autonomy.architecture.modules.length,2,'T01 requires two modules, no manual plan edits');assert.equal(new Set(session.tasks.slice(0,-1).map(t=>t.employee_id)).size,2,'T01 requires two real workers');}
  result.stage='autonomous-execution';session=await wait(()=>api(`/api/coordination/sessions/${session.id}`),value=>['completed','attention'].includes(value.autonomy?.state),Date.now()+8*60000);
  writeFileSync(join(dir,id+'-session.json'),redact(JSON.stringify(session,null,2)));result.finalState=session.autonomy.state;result.reason=session.autonomy.reason;const snapshot=await api('/api/snapshot');result.runs=snapshot.runs.filter(r=>session.tasks.some(t=>t.id===r.task_id)).map(r=>({id:r.id,taskId:r.task_id,status:r.status,startedAt:r.started_at,endedAt:r.ended_at}));assert.equal(session.autonomy.state,'completed',session.autonomy.reason??'not delivered');assert(session.tasks.every(t=>t.status==='accepted'));
  result.checks=session.autonomy.checks.map(c=>({status:c.status,tests:c.body.tests?.map(t=>({id:t.id,exitCode:t.exitCode,timedOut:t.timedOut,output:t.output})),review:c.body.review?.reviewMode}));result.repairs=session.autonomy.repairs.length;
  result.modules=session.autonomy.architecture.modules.map(m=>({id:m.id,paths:m.paths}));assert.equal(session.turns.filter(t=>t.kind==='delivery_completed').length,1);
  if(id==='T02'){assert(session.autonomy.checks.some(c=>c.status==='failed'&&c.body.tests.some(t=>t.output.includes('APIX_TRANSIENT_FAULT_ONCE'))));assert.equal(result.repairs,1);}
  result.stage='external-recheck';const final=await api(`/api/tasks/${session.tasks.at(-1).id}/delivery`);for(const check of checks)execFileSync(process.execPath,check.args,{cwd:final.workspacePath,timeout:10000,stdio:'ignore'});
  for(const [name,body] of Object.entries(files))assert.equal(readFileSync(join(final.workspacePath,name),'utf8'),body,'authorized script unchanged');
  result.workspace=final.workspacePath;result.pass=true;result.stage='complete';result.endedAt=new Date().toISOString();
}
try{
  if(!env.ali_url||!env.APIX_ALI_API_KEY)throw new Error('现有阿里管理者配置未就绪');
  server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env,stdio:'ignore',windowsHide:true});await wait(async()=>{try{return await api('/api/snapshot');}catch{return null;}},Boolean,Date.now()+30000);
  const catalog=(await api('/api/snapshot')).runtimes;assert(catalog.some(r=>r.id==='codex'&&r.available&&r.managed),'real Codex unavailable');
  await api('/api/manager/settings',{baseUrl:env.ali_url,model:testModel,apiType:'openai-completions',apiKeyEnv:'APIX_ALI_API_KEY'});
  await scenario('T01','开发两个模块的订单金额计算 HTTP 系统',{'verify-core.mjs':coreCheck,'verify-http.mjs':apiCheck},[{id:'core',args:['verify-core.mjs'],timeoutMs:10000},{id:'http',args:['verify-http.mjs'],timeoutMs:10000}],'纯函数模块引用 core 检查，HTTP 模块引用 http 检查；不得在纯函数阶段引用尚未存在的 HTTP 检查。所有模块及最终集成均实测和自审通过，最终接口符合约定。');
  await scenario('T02','修复 domain.mjs 对非法数量的校验并完成自动返工',{'verify-repair.mjs':repairCheck},[{id:'repair',args:['verify-repair.mjs'],timeoutMs:10000}],'检查正常计算与非法输入；第一次宿主检查会注入一次临时故障，自动生成修复指令，不修改脚本，重验和集成通过。',{ 'domain.mjs':'export const total=items=>items.reduce((n,item)=>n+item.price*item.quantity,0);\n'});
  report.pass=true;
}catch(error){report.error=redact(error.message);}
finally{
  cleaning=true;
  if(server?.exitCode===null){try{const snapshot=await api('/api/snapshot');for(const run of snapshot.runs.filter(r=>['running','starting','stopping'].includes(r.status)))await api(`/api/runs/${run.id}/stop`,{});const until=Date.now()+15000;while(Date.now()<until){const snapshot=await api('/api/snapshot');if(!snapshot.runs.some(r=>['running','starting','stopping','unknown'].includes(r.status))){report.workersStopped=true;break;}await delay(300);}}catch{report.workersStopped=false;}const exited=new Promise(done=>server.once('exit',done));if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});}catch{server.kill();}}else server.kill();await exited;}
  report.endedAt=new Date().toISOString();writeFileSync(join(dir,'result.json'),redact(JSON.stringify(report,null,2)));console.log(redact(JSON.stringify(report)));process.exitCode=report.pass?0:1;
}
