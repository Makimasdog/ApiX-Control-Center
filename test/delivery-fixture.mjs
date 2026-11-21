import {authorizePage} from './local-fetch.mjs';
import {assistantPromptContext} from './assistant-prompt-fixture.mjs';
import {fetch} from './local-fetch.mjs';
import {randomInt} from 'node:crypto';
import assert from 'node:assert/strict';import http from 'node:http';import {spawn} from 'node:child_process';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {join,resolve,sep} from 'node:path';import {tmpdir} from 'node:os';
import {serviceDiagnostics,waitServiceReady,stopService} from './service-diagnostics.mjs';import {fixtureDecision,selectTasks} from '../scripts/evaluation/coding-evaluation-tasks.mjs';
async function listenFixtureHttp(server){
 for(let attempt=0;attempt<10;attempt++){
  // Windows can assign a port that Fetch and Chromium refuse to use.
  const port=randomInt(49152,65536);
  try{
   await new Promise((done,reject)=>{
    const failed=error=>{server.off('listening',ready);reject(error);};
    const ready=()=>{server.off('error',failed);done();};
    server.once('error',failed).once('listening',ready).listen(port,'127.0.0.1');
   });
   return port;
  }catch(error){if(error.code!=='EADDRINUSE'&&error.code!=='EACCES')throw error;}
 }
 throw new Error('无法为 HTTP 验收夹具分配本机端口');
}
export async function startDeliveryFixture({setup,decide,channelReply,summarize,usage,plan,requestMs=10000,runtimeEntries={},serverArgs=[],serverEnv={},nodeArgs=[],legacy=false,name="P11 交付审阅演示",idleMs=25000,startupMs=9000}={}){
 const dir=await mkdtemp(join(tmpdir(),'apix-delivery-fixture-')),project=join(dir,'project'),calls=[],states=new Map();let child,failure;await mkdir(join(project,'src'),{recursive:true});const task=selectTasks('logic')[0];if(setup)await setup(project);else for(const [path,content] of Object.entries({...task.files,'check.cjs':task.runtimeCheck}))await writeFile(join(project,path),content);
 const model=http.createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;assert.equal(req.headers.authorization,undefined);const body=JSON.parse(raw),prompt=body.messages.at(-1).content;if(prompt.startsWith('APIX_PLAN_JSON')&&plan){calls.push({phase:'planning'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(await plan())}}]}));return;}if(prompt.startsWith('APIX_DIRECTOR_JSON')){calls.push({model:body.model,phase:'legacy_director'});res.end(JSON.stringify({usage,choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'本地遗留规划夹具',goal:'只读说明',steps:[],memoryCandidates:[]})}}]}));return;}if(prompt.startsWith('APIX_COMPACT_JSON')){calls.push({model:body.model,phase:'compact'});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage,choices:[{finish_reason:'stop',message:{content:JSON.stringify(summarize?await summarize(prompt):{summary:'本地协议夹具整理了旧历史；任务范围、批准、指纹和检查结果以宿主当前状态为准。用户要求保留原有内容，不授予额外权限。'})}}]}));return;}if(channelReply&&prompt.startsWith('你是 ApiX 个人助手。根据同一渠道会话的消息')){const content=await channelReply(prompt);calls.push({model:body.model,phase:'channel'});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage,choices:[{finish_reason:'stop',message:{content}}]}));return;}if(!prompt.includes('当前上下文：')&&!prompt.includes('APIX_PROMPT_LAYOUT stable-prefix-v1\n'))throw new Error('Unexpected fixture protocol phase: '+prompt.slice(0,80));const ctx=assistantPromptContext(prompt);calls.push({model:body.model,taskId:ctx.currentTask?.id});const id=ctx.currentTask.id,state=states.get(id)??{};states.set(id,state);const action=(tool,args={})=>({action:'tool',tool,args,message:'local protocol fixture '+tool}),finish={action:'finish',outcome:'completed',message:'本地协议夹具已完成，等待用户审阅。'};let decision;
 if(decide)decision=JSON.stringify(await decide(ctx,state));
 else if(ctx.currentTask.description.includes('下一任务')||ctx.currentTask.description.includes('新增说明')){const steps=[()=>action('write_file',{path:'src/note.md',content:'Task B only\n'}),()=>action('get_diff'),()=>action('run_check',{checkId:'unit'}),()=>finish];decision=JSON.stringify(steps[state.step??0]());state.step=(state.step??0)+1;}
 else if(ctx.taskFeedback?.some(f=>f.taskId===id)){const result=t=>ctx.history.filter(e=>e.kind==='tool_result'&&e.body.tool===t).at(-1)?.body.result;const steps=[()=>action('read_file',{path:'src/add.cjs'}),()=>action('edit_file',{path:'src/add.cjs',expectedSha256:result('read_file').sha256,edits:[{oldText:'// BUG:add',newText:'// fixed addition; requested documentation'}]}),()=>action('get_diff'),()=>action('run_check',{checkId:'unit'}),()=>finish];decision=JSON.stringify(steps[state.revisionStep??0]());state.revisionStep=(state.revisionStep??0)+1;}
 else decision=fixtureDecision(task,prompt,state);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage,choices:[{finish_reason:'stop',message:{content:decision}}]}));
 }catch(e){failure=e;res.writeHead(500);res.end('{}');}});
 let origin;
 const request=async(path,body,status=200)=>{const response=await fetch(origin+path,{signal:AbortSignal.timeout(requestMs),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;};
 const close=async(keep=false)=>{try{await stopService(child);}finally{model.closeAllConnections();await new Promise(r=>model.close(r));if(!keep){assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}};
 try{const modelPort=await listenFixtureHttp(model),probe=http.createServer(),port=await listenFixtureHttp(probe);await new Promise(r=>probe.close(r));origin='http://127.0.0.1:'+port;
 const env={...process.env,PORT:String(port),APIX_DATA_DIR:join(dir,'data'),APIX_LEGACY_API:legacy?'1':'0',APIX_PI_ENTRY:join(resolve('.'),'test/fake-pi.mjs'),APIX_CODEX_ENTRY:join(resolve('.'),'test/fake-codex.mjs'),APIX_CLAUDE_ENTRY:join(resolve('.'),'test/fake-claude.mjs'),...serverEnv,...runtimeEntries};const start=async()=>{const launchEnv={...env,...serverEnv};child=spawn(process.execPath,[...nodeArgs,'server.mjs',...serverArgs],{cwd:resolve('.'),env:launchEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});await waitServiceReady(serviceDiagnostics(child,launchEnv),origin+'/api/manager/providers',{timeoutMs:startupMs});};await start();await request('/api/manager/settings',{baseUrl:`http://127.0.0.1:${modelPort}/v1`,model:'delivery-local-protocol',apiType:'openai-completions',apiKeyEnv:''});const projectId=(await request('/api/projects',{name,path:project})).id;await request('/api/permissions',{projectId,subject:'apix',mode:'full_access',version:0});
 return {origin,dir,project,projectId,request,calls,close,restart:async(beforeStart=()=>{})=>{await stopService(child);await beforeStart();await start();},authorize:page=>authorizePage(page,origin),async idle(id){const end=Date.now()+idleMs;while(Date.now()<end){if(failure)throw failure;const s=await request('/api/assistant/sessions/'+id);if(!s.busy&&s.status!=='running')return s;await new Promise(r=>setTimeout(r,10));}throw new Error('delivery fixture deadline fired');}};
 }catch(e){await close();throw e;}
}
