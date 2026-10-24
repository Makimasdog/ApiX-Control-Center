import {fetch} from '../../test/local-fetch.mjs';
// Explicit opt-in: real providers may charge; preserve isolated workspaces as evidence.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {loadEnvironment} from '../../src/infrastructure/environment.mjs';

if(!process.argv.includes('--approve-cost'))throw new Error('真实验收可能产生模型费用；明确批准后传入 --approve-cost');
const testModel='qwen3.8-27b';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
loadEnvironment(join(root,'.env'));
const parent=join(root,'.tmp-real-collaboration');mkdirSync(parent,{recursive:true});
const dir=mkdtempSync(join(parent,'run-'));const project=join(dir,'project');mkdirSync(project);
const port=await new Promise(done=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>done(port));});});
const env={...process.env,APIX_DATA_DIR:join(dir,'data'),PORT:String(port),APIX_LEGACY_API:'0'};
const report={kind:'independent ApiX API manager and real Codex/Claude workers',managerModel:testModel,startedAt:new Date().toISOString(),dir,pass:false,stage:'prepare',checks:[]};
const git=args=>execFileSync('git',args,{cwd:project,stdio:'ignore'});
git(['init']);writeFileSync(join(project,'README.md'),'ApiX real collaboration fixture\n');git(['add','README.md']);git(['-c','user.name=ApiX Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
let server;
async function request(path,body){const response=await fetch(`http://127.0.0.1:${port}${path}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP ${response.status}`);return result;}
async function wait(read,test,timeout=300000){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(test(value))return value;await delay(300);}throw new Error('验收等待超时，保留运行与工作区供检查');}
try{
  server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env,stdio:'ignore',windowsHide:true});
  await wait(async()=>{try{return await request('/api/snapshot');}catch{return null;}},Boolean,30000);
  const catalog=(await request('/api/snapshot')).runtimes;
  if(!['codex','claude'].every(id=>catalog.some(r=>r.id===id&&r.available&&r.managed)))throw new Error('真实 Codex/Claude 运行时不可用，请安装并配置入口');
  if(!env.ali_url || !env.APIX_ALI_API_KEY)throw new Error('验收需配置阿里模型 URL 与环境变量密钥');
  await request('/api/manager/settings',{baseUrl:env.ali_url,model:testModel,apiType:'openai-completions',apiKeyEnv:'APIX_ALI_API_KEY'});
  const projectId=(await request('/api/projects',{name:'真实协作隔离验收',path:project})).id;
  const first=(await request('/api/employees',{name:'真实 Codex',runtime:'codex',role:'实现'})).id;
  const second=(await request('/api/employees',{name:'真实 Claude',runtime:'claude',role:'验证'})).id;
  for(const employeeId of [first,second])await request(`/api/employees/${employeeId}/capabilities`,{version:0,tags:['javascript','nodejs','implementation','testing','review','analysis','git'],tools:['read','write','edit','bash','grep','find','ls','Read','Write','Edit','Bash','Glob','Grep','git','node'],contextTokens:8000,projectIds:[projectId]});
  let session=await request('/api/coordination/sessions',{projectId,goal:'在隔离项目创建 sum.mjs，再由另一员工验证输入、读取指导并写验收报告'});
  for(const [field,value] of Object.entries({scope:'仅隔离项目文件，不访问其他项目，不启动额外 Agent',constraints:'仅创建 sum.mjs、verify.mjs、review.md；不得提交、安装依赖、输出凭据',deliverable:'加法函数、实际验证脚本与验收报告',acceptance:'Codex 写文件，人工冻结后 Claude 接收代码，确认指导，执行验证并写报告'}))session=await request(`/api/coordination/sessions/${session.id}/answers`,{revision:session.revision,field,value});
  report.stage='manager-plan';session=await request(`/api/coordination/sessions/${session.id}/confirm`,{revision:session.revision});
  if(session.agent.mode!=='pi')throw new Error('真实管理者未生成有效计划');
  const guidance='APIX_REAL_GUIDANCE：必须测试 sum(2,3) 为 5，报告必须包含 APIX_REAL_GUIDANCE_OK。';
  const steps=[
    {employeeId:first,dependsOn:[],prompt:'仅在当前工作区创建 sum.mjs，内容 export const sum = (a,b) => a+b; 用 Node 实际验证 sum(2,3) 为 5。不要提交 Git、安装依赖或启动其他 Agent。完成后简短报告。'},
    {employeeId:second,dependsOn:[0],prompt:'先确认当前工作区已收到前置 sum.mjs。使用 Node fetch 从 APIX_MAILBOX_URL + /messages 轮询领取包含 APIX_REAL_GUIDANCE 的用户指导（最多等待 45 秒），Bearer 使用 APIX_AGENT_TOKEN 环境变量，不输出或写入凭据。对该消息 POST /messages/:id/ack 和 /complete（JSON {}）。按指导创建 verify.mjs，使用 node:assert/strict 检查 sum(2,3) 为 5；实际执行 node verify.mjs。创建 review.md，包含 APIX_REAL_GUIDANCE_OK 和实际验证结果。只改上述验证文件，不提交、安装依赖或启动其他 Agent。'}
  ];
  session=await request(`/api/coordination/sessions/${session.id}/plan`,{revision:session.revision,planVersion:session.planVersion,steps});
  report.stage='codex';session=await request(`/api/coordination/sessions/${session.id}/dispatch`,{planVersion:session.planVersion});
  const ids=session.tasks.map(t=>t.id);
  session=await wait(()=>request(`/api/coordination/sessions/${session.id}`),s=>['completed','failed','blocked','unknown','cancelled'].includes(s.tasks[0].status));
  if(session.tasks[0].status!=='completed')throw new Error('真实 Codex 未完成：'+session.tasks[0].status);
  let delivery=await request(`/api/tasks/${ids[0]}/delivery`);
  if(!readFileSync(join(delivery.workspacePath,'sum.mjs'),'utf8').includes('sum'))throw new Error('Codex 未产生真实代码');
  await request(`/api/tasks/${ids[0]}/review`,{accepted:true,fingerprint:delivery.inspection.fingerprint});report.checks.push('Codex real file + frozen acceptance');
  report.stage='claude';session=await wait(()=>request(`/api/coordination/sessions/${session.id}`),s=>['running','failed','blocked','completed'].includes(s.tasks[1].status));
  if(session.tasks[1].status!=='running')throw new Error('Claude 未进入可指导运行：'+session.tasks[1].status);
  await request(`/api/coordination/sessions/${session.id}/instructions`,{revision:session.revision,taskId:ids[1],content:guidance});
  session=await wait(()=>request(`/api/coordination/sessions/${session.id}`),s=>['completed','failed','blocked','unknown','cancelled'].includes(s.tasks[1].status));
  if(session.tasks[1].status!=='completed')throw new Error('真实 Claude 未完成：'+session.tasks[1].status);
  delivery=await request(`/api/tasks/${ids[1]}/delivery`);
  execFileSync(process.execPath,['verify.mjs'],{cwd:delivery.workspacePath,stdio:'ignore',timeout:10000});
  if(!readFileSync(join(delivery.workspacePath,'review.md'),'utf8').includes('APIX_REAL_GUIDANCE_OK'))throw new Error('Claude 报告缺少指导确认');
  if(!session.instructions.some(m=>m.taskId===ids[1]&&m.status==='completed'))throw new Error('用户指导未完成确认');
  await request(`/api/tasks/${ids[1]}/review`,{accepted:true,fingerprint:delivery.inspection.fingerprint});
  session=await request(`/api/coordination/sessions/${session.id}`);
  if(session.derivedStatus!=='completed')throw new Error('目标未全部验收');
  report.checks.push('Claude frozen input + mailbox complete + actual Node verification + final acceptance');report.pass=true;report.stage='complete';
}catch(error){report.error=String(error.message);for(const name of ['APIX_ALI_API_KEY','ali_api_key','ANTHROPIC_API_KEY','OPENAI_API_KEY'])if(env[name])report.error=report.error.replaceAll(env[name],'<redacted>');}
finally{
  if(server?.exitCode===null){try{const snapshot=await request('/api/snapshot');for(const run of snapshot.runs.filter(r=>['running','starting','stopping'].includes(r.status)))await request(`/api/runs/${run.id}/stop`,{});await wait(()=>request('/api/snapshot'),s=>!s.runs.some(r=>['running','starting','stopping'].includes(r.status)),15000);report.workersStopped=true;}catch{report.workersStopped=false;}const exited=new Promise(done=>server.once('exit',done));server.kill();await exited;}
  report.endedAt=new Date().toISOString();writeFileSync(join(dir,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=report.pass?0:1;
}
