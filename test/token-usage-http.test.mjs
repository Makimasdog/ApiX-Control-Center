import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startDeliveryFixture} from './delivery-fixture.mjs';

test('production usage ledger, saving discovery and task boundaries through HTTP',{timeout:90000},async()=>{
 const h=await startDeliveryFixture({startupMs:30000,usage:{prompt_tokens:1000,completion_tokens:50,prompt_tokens_details:{cached_tokens:100}},decide:(ctx,state)=>{
  const tools=ctx.history.filter(e=>e.kind==='tool_result');
  if(!state.discovered){state.discovered=true;return {action:'tool',tool:'search_tools',args:{query:'read_memory',limit:1},message:'按需发现记忆工具'};}
  assert(tools.some(e=>e.body.tool==='search_tools'&&e.body.result.tools.some(t=>t.name==='read_memory'&&t.inputSchema)));
  return {action:'finish',outcome:'completed',message:'只读任务已完成'};
 }});
 try{
  let session=await h.request('/api/assistant/sessions',{projectId:h.projectId});const base='/api/assistant/sessions/'+session.id;
  session=await h.request(base+'/optimization',{version:session.version,mode:'saving'});
  await h.request(base+'/optimization',{version:session.version-1,mode:'standard'},400);
  await h.request(base+'/optimization',{version:session.version,mode:'invalid'},400);
  await h.request(base+'/messages',{content:'检查项目现有记忆，无需修改'});session=await h.idle(session.id);assert.equal(session.status,'completed');
  let info=await h.request(base+'/context');assert.equal(info.error,undefined);assert.equal(info.optimization.mode,'saving');assert(info.optimization.estimatedReductionTokens>0);assert.equal(info.usage.task.calls,2);assert.equal(info.usage.task.inputTokens,2000);assert.equal(info.usage.task.outputTokens,100);assert.equal(info.usage.task.coverage.cacheWriteTokens,0);assert.equal(info.usage.task.coverage.cachedInputTokens,2);assert(info.usage.recent.every(r=>r.purpose==='assistant_loop'));
  const firstTask=info.usage.taskId;session=await h.request(base+'/compact',{version:session.version,focus:'保留用户约束与工具引用'});info=await h.request(base+'/context');assert.equal(info.usage.task.calls,3);assert.equal(info.usage.recent[0].purpose,'compaction');assert.equal(info.usage.task.inputTokens,3000);
  session=await h.request(base+'/tasks',{version:session.version,description:'下一任务：只读检查'});info=await h.request(base+'/context');assert.notEqual(info.usage.taskId,firstTask);assert.equal(info.usage.task.calls,0);assert.equal(info.usage.task.inputTokens,null);assert.equal(info.usage.session.calls,3);assert.equal(info.optimization.mode,'saving');
  const other=await h.request('/api/assistant/sessions',{projectId:h.projectId});const isolated=await h.request('/api/assistant/sessions/'+other.id+'/context');assert.equal(isolated.usage.session.calls,0);assert.equal(isolated.usage.project.calls,3);assert.equal(isolated.optimization.mode,'standard');
  await h.request('/api/assistant/sessions/missing/optimization',{version:1,mode:'saving'},400);
 }finally{await h.close();}
});

test('format correction uses a separate ledger purpose and still counts against task usage',{timeout:60000},async()=>{
 const h=await startDeliveryFixture({startupMs:30000,usage:{prompt_tokens:100,completion_tokens:10},decide:(_ctx,state)=>{
  if(!state.invalid){state.invalid=true;return {invalid:'missing action'};}
  return {action:'finish',outcome:'completed',message:'格式已纠正'};
 }});
 try{const session=await h.request('/api/assistant/sessions',{projectId:h.projectId}),base='/api/assistant/sessions/'+session.id;await h.request(base+'/messages',{content:'只读检查'});assert.equal((await h.idle(session.id)).status,'completed');const info=await h.request(base+'/context');assert.equal(info.usage.task.calls,2);assert.equal(info.usage.task.inputTokens,200);assert.deepEqual(info.usage.recent.map(r=>r.purpose),['format_repair','assistant_loop']);}finally{await h.close();}
});

test('legacy Director contributes API usage to its project without starting a task or changing its lifecycle',{timeout:60000},async()=>{
 const h=await startDeliveryFixture({startupMs:30000,legacy:true,usage:{prompt_tokens:100,completion_tokens:10}});
 try{const result=await h.request('/api/director/messages',{projectId:h.projectId,content:'只读说明，不创建计划'});assert.equal(result.mode,'pi');assert.equal(result.proposalId,null);assert.equal(h.calls[0].phase,'legacy_director');
 const session=await h.request('/api/assistant/sessions',{projectId:h.projectId}),info=await h.request('/api/assistant/sessions/'+session.id+'/context');assert.equal(info.usage.project.calls,1);assert.equal(info.usage.project.inputTokens,100);assert.equal(info.usage.project.outputTokens,10);assert.equal(info.usage.session.calls,0);assert.equal(info.usage.task.calls,0);assert.equal((await h.request('/api/snapshot')).runs.length,0);
 }finally{await h.close();}
});
