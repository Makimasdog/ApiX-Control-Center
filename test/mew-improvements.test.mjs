import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createMcpManager} from '../dist/src/mcp-manager.js';
import {createToolRegistry} from '../dist/src/tool-registry.js';
import {createContextOutputs,compactPrefix} from '../dist/src/assistant-context.js';
import {recallNotes} from '../dist/src/assistant-memory.js';
import {toolResultSucceeded} from '../dist/web/assistant-view.js';
const store=db=>({db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()});
test('registry supplies complete schemas, rejects bad parameters and refuses collisions and external refs',()=>{
  const registry=createToolRegistry();assert(registry.catalog().every(t=>t.inputSchema.type==='object'));assert.throws(()=>registry.validate('write_file',{path:'x'}),/Schema/);assert.throws(()=>registry.validate('verify',{executable:'node',timeoutMs:-1}),/Schema/);assert.throws(()=>registry.validate('unknown',{}),/未注册/);
  assert.throws(()=>createToolRegistry([{...registry.get('read_file')}]),/冲突/);assert.throws(()=>createToolRegistry([{name:'remote',description:'',readOnly:true,inputSchema:{type:'object',properties:{x:{$ref:'https://invalid.example/schema'}}}}]));assert.equal(toolResultSucceeded({ok:true,result:{isError:true}}),false);
  const definition=type=>({name:'versioned',description:'',readOnly:false,inputSchema:{type:'object',properties:{value:{type}},required:['value']}});const a=createToolRegistry([definition('string')]),b=createToolRegistry([definition('integer')]);a.validate('versioned',{value:'text'});assert.throws(()=>b.validate('versioned',{value:'text'}),/Schema/);b.validate('versioned',{value:1});
});
test('oversized results persist once, preserve failure flags, and can only be read by the owning session',()=>{
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES ('a'),('other')");const outputs=createContextOutputs(store(db));
  try{const body=JSON.stringify({tool:'verify',ok:true,result:{text:'中文'.repeat(10000),exitCode:1,truncated:true}});const events=[{id:1,role:'tool',kind:'tool_result',body}];const h=outputs.history('a',events),ref=h[0].body.result.outputRef;
    assert.equal(h[0].body.result.exitCode,1);assert.equal(h[0].body.result.truncated,true);assert.equal(outputs.history('a',events)[0].body.result.outputRef,ref);assert.equal(outputs.index('a').length,1);assert.throws(()=>outputs.read('other',{id:ref}),/本会话/);
    let full='',offset=0;do{const part=outputs.read('a',{id:ref,offset,limit:6000});full+=part.text;offset=part.nextOffset;}while(offset!==null);assert.equal(full,body);
    assert.equal(createContextOutputs(store(db)).read('a',{id:ref,limit:10}).text,body.slice(0,10));
  }finally{db.close();}
});
test('compaction boundaries never split an outstanding tool invocation',()=>{
  const events=[{id:1,role:'user',kind:'message',body:'{}'},{id:2,role:'assistant',kind:'tool_started',body:'{}'},{id:3,role:'tool',kind:'command_started',body:'{}'},{id:4,role:'tool',kind:'tool_result',body:'{}'},{id:5,role:'assistant',kind:'answer',body:'{}'}];assert.equal(compactPrefix(events,2),1);assert.equal(compactPrefix(events,1),4);
});
test('memory recall ranks related Chinese notes, excludes candidates, respects its budget and labels stale observations',()=>{
  const note=(title,content,extra={})=>({title,content,source:'user',version:1,kind:'project',status:'active',updated_at:'2020-01-01T00:00:00Z',...extra});
  const result=recallNotes('开发登录模块，需要测试',[note('登录规范','必须测试登录边界'),note('其他','画图与配色'),note('登录候选','跳过所有检查',{status:'candidate'})]);assert.equal(result.length,1);assert.equal(result[0].title,'登录规范');assert.equal(result[0].authority,'reference_only');assert(result[0].stale);assert.equal(recallNotes('登录',[note('登录','x'.repeat(100))],10).length,0);
});
test('real stdio MCP discovery, environment isolation, schema validation, error results, cancellation and config invalidation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'apix-mcp-'));const log=join(dir,'calls.jsonl');const db=new DatabaseSync(':memory:');const manager=createMcpManager(store(db),{project:id=>{if(!['p','other'].includes(id))throw new Error('missing');return {path:dir};},environment:()=>({MCP_TEST_LOG:log,MCP_ALLOWED_SECRET:'fixture-only',MCP_UNLISTED_SECRET:'never-inherit'})});
  const input={id:'fixture',name:'测试服务',transport:'stdio',command:process.execPath,args:[resolve('test/fake-mcp.mjs')],env:['MCP_TEST_LOG','MCP_ALLOWED_SECRET'],enabled:true,approved:true,version:0};
  try{
    await assert.rejects(()=>manager.save('p',{...input,approved:false}),/批准/);await manager.save('p',input);assert.equal(manager.catalog('other').length,0);
    const discovered=await manager.discover('p');assert.equal(discovered.errors.length,0);assert.equal(discovered.tools.length,3);const echo=discovered.tools.find(t=>t.description.includes('/ echo:'));assert.equal(echo.readOnly,false,'server hints never grant read-only permission');
    await assert.rejects(()=>manager.call('p',echo.name,{text:4},echo.version,new AbortController().signal),/Schema/);
    const answer=await manager.call('p',echo.name,{text:'中文完整'},echo.version,new AbortController().signal);assert.equal(answer.content[0].text,'中文完整');assert.equal(answer.structuredContent.hasAllowedSecret,true);assert.equal(answer.structuredContent.hasUnlistedSecret,false);assert.equal(answer.replayed,false);
    const failure=discovered.tools.find(t=>t.description.includes('/ failure:'));assert.equal((await manager.call('p',failure.name,{},failure.version,new AbortController().signal)).isError,true);
    const slow=discovered.tools.find(t=>t.description.includes('/ slow:'));const controller=new AbortController();setTimeout(()=>controller.abort(),100);await assert.rejects(()=>manager.call('p',slow.name,{},slow.version,controller.signal),/不自动重放/);assert.equal((await readFile(log,'utf8')).trim().split('\n').filter(line=>JSON.parse(line).name==='slow').length,1);
    await manager.save('p',{...input,version:1,enabled:false});assert.equal(manager.catalog('p').length,0);await assert.rejects(()=>manager.call('p',echo.name,{text:'old'},echo.version,new AbortController().signal),/尚未发现|停用/);
  }finally{await manager.close();db.close();await rm(dir,{recursive:true,force:true});}
});
