import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fetch} from '../../test/local-fetch.mjs';

const executable=resolve(process.argv[2]??'.tmp-desktop/release-20261108-notifications/win-unpacked/ApiX Control Center.exe');
const output=await mkdtemp(join(tmpdir(),'apix-native-notifications-'));
const data=join(output,'data'),project=join(output,'project');
await mkdir(data);await mkdir(project);
await writeFile(join(project,'README.md'),'Notification verification fixture\n');
for(const args of [['init'],['config','user.name','ApiX Fixture'],['config','user.email','test@example.invalid'],['add','README.md'],['commit','-m','fixture']])
  execFileSync('git',args,{cwd:project,windowsHide:true,stdio:'ignore'});
const employees=[];
let planningCalls=0;
const model=createServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    assert(body.messages.at(-1).content.startsWith('APIX_PLAN_JSON'));
    planningCalls++;
    const steps=employees.map((employeeId,index)=>({employeeId,prompt:(index===1?'approval':'ask')+' 只读通知验收 '+index,dependsOn:[]}));
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({steps})}}]}));
  }catch{res.writeHead(500);res.end('{}');}
});
await new Promise(done=>model.listen(0,'127.0.0.1',done));
const env={...process.env,APIX_DESKTOP_DATA_DIR:data,APIX_CODEX_ENTRY:resolve('test/fake-native-runtime.mjs')};
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,[],{env,windowsHide:false,stdio:'ignore'});
let closed=false;child.once('close',()=>{closed=true;});
let origin;
const state={output,data,executable,appId:'local.apix.controlcenter',phase:'starting'};
const save=()=>writeFile(join(output,'state.json'),JSON.stringify({...state,planningCalls},null,2));
console.log(JSON.stringify({output,data}));
async function request(path,body,status=200){
  const response=await fetch(origin+path,{signal:AbortSignal.timeout(15000),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
}
try{
  let ready=false;
  for(let i=0;i<150;i++){
    if(closed)throw new Error('Desktop exited before fixture startup');
    try{
      origin='http://127.0.0.1:'+JSON.parse(await readFile(join(data,'desktop-port.json'),'utf8'));
      await request('/api/snapshot');ready=true;break;
    }catch{await delay(400);}
  }
  assert(ready,'Desktop did not become ready within the fixture startup window');
  await request('/api/manager/settings',{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'local-notification-fixture',apiType:'openai-completions',apiKeyEnv:''});
  const p=await request('/api/projects',{name:'Windows 通知验收',path:project});
  await request('/api/permissions',{projectId:p.id,subject:'apix',mode:'full_access',version:0});
  for(const name of ['点击核查员','审批核查员','失效核查员']){
    const e=await request('/api/employees',{name,runtime:'codex',role:'本地通知验收'});
    employees.push(e.id);
    await request('/api/employees/'+e.id+'/runtime-settings',{expectedVersion:0,backend:'codex-app-server',acknowledgeExperimental:true});
    await request('/api/permissions',{projectId:p.id,subject:e.id,mode:'full_access',version:0});
  }
  let coordination=await request('/api/coordination/sessions',{projectId:p.id,goal:'只读核验三个员工的 Windows 通知'});
  const base='/api/coordination/sessions/'+coordination.id;
  for(const [field,value] of Object.entries({scope:'只读 README',constraints:'不修改文件，不访问外部服务',deliverable:'本地通知验收',acceptance:'分别处理三个请求'}))
    coordination=await request(base+'/answers',{revision:coordination.revision,field,value});
  const parent=await request('/api/assistant/sessions',{projectId:p.id});
  const db=new DatabaseSync(join(data,'apix.sqlite'));
  db.prepare('UPDATE assistant_sessions SET child_session_id=? WHERE id=?').run(coordination.id,parent.id);
  db.close();
  Object.assign(state,{phase:'ready',origin,projectId:p.id,sessionId:parent.id,coordinationId:coordination.id,employees});
  await save();
  let lastCommand='';
  while(!closed){
    let command;
    try{command=JSON.parse((await readFile(join(output,'control.json'),'utf8')).replace(/^\uFEFF/,''));}catch{}
    if(command&&command.id!==lastCommand){
      assert(typeof command.id==='string'&&/^[a-z0-9_-]{1,80}$/i.test(command.id),'Invalid fixture command ID');
      assert(['dispatch','invalidate','history'].includes(command.action),'Invalid fixture command action');
      lastCommand=command.id;
      if(command.action==='dispatch'){
        coordination=await request(base+'/confirm',{revision:coordination.revision});
        if(coordination.status==='plan_review')coordination=await request(base+'/dispatch',{planVersion:coordination.planVersion});
        assert.equal(coordination.failures.length,0);
        state.phase='dispatched';
      }else if(command.action==='invalidate'){
        const current=await request('/api/assistant/sessions/'+parent.id);
        const item=current.workerInteractions.find(i=>i.employee==='失效核查员');
        assert(item);
        await request('/api/runs/'+item.runId+'/interactions/'+item.id+'/answer',{requestId:'invalid-version-fixture',expectedPermissionVersion:'wrong',answer:{answers:{choice:{answers:['只读']}}}},409);
        state.phase='invalidated';
      }else if(command.action==='history'){
        const powershell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
        const observed=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',
          '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; $history=[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory("local.apix.controlcenter"); ConvertTo-Json -Compress -InputObject @($history | ForEach-Object { [ordered]@{tag=$_.Tag;group=$_.Group;xml=$_.Content.GetXml()} })',
        ],{windowsHide:true,encoding:'utf8'});
        state.history=JSON.parse(observed);
        await writeFile(join(output,command.id+'.json'),JSON.stringify(state.history,null,2));
      }
    }
    try{state.pending=await request('/api/assistant/worker-notifications');}
    catch(error){if(closed)break;throw error;}
    await save();await delay(500);
  }
}finally{
  model.closeAllConnections();await new Promise(done=>model.close(done));
  if(!closed)child.kill();
}
