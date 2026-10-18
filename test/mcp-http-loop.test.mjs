import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer as netServer} from 'node:net';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createMcpManager} from '../dist/src/mcp-manager.js';
import {startModelFixture} from './fake-model-http.mjs';
const store=db=>({db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()});
const port=()=>new Promise(r=>{const s=netServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
async function wait(check,limit=200){for(let i=0;i<limit;i++){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out');}
test('actual Streamable HTTP MCP respects header environment, supports JSON results and never retries a failed service',async()=>{
  const sdk=new Server({name:'http-fixture',version:'1'},{capabilities:{tools:{}}});
  sdk.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'echo-http',description:'回显',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}));
  let calls=0; sdk.setRequestHandler(CallToolRequestSchema,request=>{calls++;return {content:[{type:'text',text:String(request.params.arguments.text)}]};});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),enableJsonResponse:true});await sdk.connect(transport);
  const http=createServer((req,res)=>{if(req.headers.authorization!=='fixture-http-secret'){res.writeHead(401);res.end();return;}void transport.handleRequest(req,res);});await new Promise(r=>http.listen(0,'127.0.0.1',r));
  const db=new DatabaseSync(':memory:');const m=createMcpManager(store(db),{project:()=>({path:process.cwd()}),environment:()=>({HTTP_TEST_TOKEN:'fixture-http-secret'})});
  try{await m.save('p',{id:'http',name:'HTTP',version:0,transport:'http',url:`http://127.0.0.1:${http.address().port}/mcp`,enabled:true,approved:true,headerEnv:{Authorization:'HTTP_TEST_TOKEN'}});const list=await m.discover('p');assert.equal(list.errors.length,0);const d=list.tools[0];assert.equal((await m.call('p',d.name,{text:'HTTP 中文'},d.version,new AbortController().signal)).content[0].text,'HTTP 中文');assert.equal(calls,1);
    await m.save('p',{id:'bad',name:'坏服务',version:0,transport:'stdio',command:process.execPath,args:['-e','process.exit(1)'],enabled:true,approved:true});const partial=await m.discover('p');assert.equal(partial.tools.length,1);assert.equal(partial.errors.length,1);
    let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    sdk.setRequestHandler(ListToolsRequestSchema,async()=>{entered();await gate;return {tools:[]};});
    const outdated=m.discover('p');await started;
    const replacing=m.save('p',{id:'http',name:'新服务',version:1,transport:'stdio',command:process.execPath,args:[resolve('test/fake-mcp.mjs')],enabled:true,approved:true});
    const fresh=m.discover('p');await replacing;await fresh;release();await outdated;
    const latest=m.catalog('p');assert.equal(latest.length,3,'old discovery cleanup must preserve the replacement catalog');
    const echo=latest.find(t=>t.description.includes('/ echo:'));assert.equal((await m.call('p',echo.name,{text:'替换后仍可调用'},echo.version,new AbortController().signal)).content[0].text,'替换后仍可调用');
  }finally{await m.close();await sdk.close();http.closeAllConnections();await new Promise(r=>http.close(r));db.close();}
});
test('HTTP assistant discovers and executes a real MCP tool through explicit approvals and actual verification',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'apix-mcp-http-loop-'));const project=join(dir,'project');await mkdir(project);const p=await port(),base=`http://127.0.0.1:${p}`;const model=await startModelFixture();let server,errors='';
  const get=async path=>{const r=await fetch(base+path);return r.json();};
  const post=async(path,body,status=200)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};
  try{server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(p),APIX_DATA_DIR:join(dir,'db'),MCP_TEST_LOG:join(project,'mcp-calls.jsonl')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',c=>errors+=c);await wait(async()=>{try{return (await fetch(base+'/api/snapshot')).ok;}catch{return false;}});
    const projectId=(await post('/api/projects',{name:'MCP 集成验证',path:project})).id;
    await post('/api/manager/settings',{baseUrl:model.baseUrl,model:'qwen3.8-27b',apiType:'openai-completions',apiKeyEnv:''});
    const config={id:'fixture',name:'回显服务',transport:'stdio',command:process.execPath,args:[resolve('test/fake-mcp.mjs')],env:['MCP_TEST_LOG'],enabled:true,version:0};
    await post(`/api/projects/${projectId}/mcp`,config,400);await post(`/api/projects/${projectId}/mcp`,{...config,approved:true});
    const s=await post('/api/assistant/sessions',{projectId});await post(`/api/assistant/sessions/${s.id}/messages`,{content:'fixture-loop-mcp 调用回显工具并核对证据'});
    let detail=await wait(async()=>{const d=await get(`/api/assistant/sessions/${s.id}`);return d.status==='waiting_user'?d:null;});assert(detail.pending.tool.startsWith('mcp_'));assert(detail.pending.toolVersion);
    await post(`/api/assistant/sessions/${s.id}/reply`,{version:detail.version,requestId:detail.pending.id,approved:true});
    detail=await wait(async()=>{const d=await get(`/api/assistant/sessions/${s.id}`);return d.status==='waiting_user'?d:null;});assert.equal(detail.pending.tool,'verify');
    await post(`/api/assistant/sessions/${s.id}/reply`,{version:detail.version,requestId:detail.pending.id,approved:true});detail=await wait(async()=>{const d=await get(`/api/assistant/sessions/${s.id}`);return d.status==='attention'?d:null;});assert.equal(detail.verification,null);assert.equal(detail.verificationStatus,'needs_review');assert(detail.events.some(e=>e.kind==='tool_result'&&e.body.tool.startsWith('mcp_')&&e.body.result.content[0].text==='工具回显验收'));
    assert.equal((await readFile(join(project,'mcp-calls.jsonl'),'utf8')).trim().split('\n').length,1);assert(model.calls.every(c=>c.body.model==='qwen3.8-27b'));
    const denied=await fetch(base+`/api/projects/${projectId}/mcp`,{headers:{Origin:'https://attacker.invalid'}});assert.equal(denied.status,403);
    await post(`/api/projects/${projectId}/mcp`,{...config,version:1,enabled:false});
    const data=new DatabaseSync(join(dir,'db','apix.sqlite'));try{data.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'tool','tool_result',?,?)").run(s.id,JSON.stringify({tool:'read_file',ok:true,result:{content:'完整上下文证据'.repeat(6000)}}),new Date().toISOString());}finally{data.close();}
    detail=await get(`/api/assistant/sessions/${s.id}`);const reference=detail.events.at(-1).body.result;assert(reference.outputRef);assert(reference.preview.length<2000);const full=await get(`/api/assistant/sessions/${s.id}/outputs/${reference.outputRef}`);assert(full.text.includes('完整上下文证据'));assert(full.nextOffset>0);
    const other=await post('/api/assistant/sessions',{projectId});const blockedOutput=await fetch(base+`/api/assistant/sessions/${other.id}/outputs/${reference.outputRef}`);assert.equal(blockedOutput.status,400);
  }catch(error){throw new Error(error.message+'\n'+errors,{cause:error});}finally{if(server){server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));}await model.close();await rm(dir,{recursive:true,force:true});}
});
