import {test} from 'node:test';import assert from 'node:assert/strict';import {startDeliveryFixture} from './delivery-fixture.mjs';
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
test('project attention follows the current request and frozen delivery',{timeout:120000,skip:process.platform!=='win32'},async()=>{
 const h=await startDeliveryFixture({startupMs:30000});
 try{
  const s=await h.request('/api/assistant/sessions',{projectId:h.projectId});
  const base='/api/assistant/sessions/'+s.id;
  const list='/api/assistant/sessions?projectId='+h.projectId;
  const attention=list+'&view=attention';
  const item=action=>[{id:s.id,title:d.title,action}];
  let d=s;
  assert.deepEqual(await h.request(attention),[]);
  assert.equal((await h.request(list))[0].status,'idle');
  await h.request(base+'/messages',{content:'修复加法并交付'});
  d=await h.idle(s.id);
  assert.deepEqual(await h.request(attention),item('approve'));
  assert.deepEqual(await h.request('/api/assistant/sessions?projectId=other&view=attention'),[]);
  await h.request(base+'/reply',{version:d.version,requestId:d.pending.id,approved:true});
  d=await h.idle(s.id);
  assert.equal(d.review.latestDelivery.status,'awaiting_review');
  assert.deepEqual(await h.request(attention),item('review'));
  await h.restart();
  assert.deepEqual(await h.request(attention),item('review'));
  const review=async(action,requestId,comment)=>h.request(base+'/delivery-review',{
   version:d.version,deliveryId:d.review.latestDelivery.id,deliveryVersion:d.review.latestDelivery.version,action,requestId,comment,
  });
  d=await review('request_changes','attention-feedback','补充注释');
  assert.deepEqual(await h.request(attention),[]);
  await h.request(base+'/messages',{content:'按已保存意见继续'});
  d=await h.idle(s.id);
  assert.equal(d.review.latestDelivery.version,2);
  assert.deepEqual(await h.request(attention),item('review'));
  const history='/api/chat-history/assistant/'+s.id;
  await h.request(history,{version:d.version,action:'archive'});
  assert.deepEqual(await h.request(attention),[]);
  const archived=await h.request('/api/chat-history?projectId='+h.projectId+'&view=archived');
  await h.request(history,{version:archived[0].version,action:'delete'});
  assert.deepEqual(await h.request(attention),[]);
  const deleted=await h.request('/api/chat-history?projectId='+h.projectId+'&view=deleted');
  await h.request(history,{version:deleted[0].version,action:'restore'});
  d=await h.request(base);
  assert.deepEqual(await h.request(attention),item('review'));
  await review('accept','attention-accept');
  assert.deepEqual(await h.request(attention),[]);
 }finally{await h.close();}
});
test('automatic execution reuses the approved project check across sessions and restart',{timeout:120000,skip:process.platform!=='win32'},async()=>{
 const h=await startDeliveryFixture({startupMs:30000,decide:(_ctx,state)=>{
  if(!state.proposed){
   state.proposed=true;
   return {action:'tool',tool:'configure_verification',args:{checks:[{id:'unit',args:['check.cjs'],timeoutMs:5000}],writablePaths:['src']},message:'核对现有检查命令。'};
  }
  return {action:'finish',outcome:'completed',message:'已核对项目验收契约。'};
 }});
 try{
  const start=async()=>{
   const {id}=await h.request('/api/assistant/sessions',{projectId:h.projectId});
   await h.request('/api/assistant/sessions/'+id+'/messages',{content:'核对项目验收契约'});
   return h.idle(id);
  };
  let first=await start();
  assert.equal(first.pending?.tool,'configure_verification');
  await h.request('/api/assistant/sessions/'+first.id+'/reply',{version:first.version,requestId:first.pending.id,approved:true});
  first=await h.idle(first.id);
  assert.equal(first.status,'completed');
  await h.restart();
  const next=await start();
  assert.equal(next.status,'completed');
  assert.equal(next.pending,null);
  const reuse=next.events.find(e=>e.kind==='tool_result'&&e.body.tool==='configure_verification');
  assert.equal(reuse?.body.reused,true);
  assert.equal(reuse.body.result.version,first.events.find(e=>e.kind==='verification_contract')?.body.version);
  assert(!next.events.some(e=>e.kind==='verification_contract'));

  await appendFile(join(h.project,'check.cjs'),'\n// changed after approval\n');
  const changed=await start();
  assert.equal(changed.pending?.tool,'configure_verification');
 }finally{await h.close();}
});
test('production HTTP review, revision, acceptance, duplicate requests and second task use frozen task versions',{timeout:60000,skip:process.platform!=='win32'},async()=>{
 const h=await startDeliveryFixture();try{const s=await h.request('/api/assistant/sessions',{projectId:h.projectId}),base='/api/assistant/sessions/'+s.id;await h.request(base+'/messages',{content:'修复加法并交付'});let d=await h.idle(s.id);assert.equal(d.pending.tool,'configure_verification');await h.request(base+'/reply',{version:d.version,requestId:d.pending.id,approved:true});d=await h.idle(s.id);assert.equal(d.verificationStatus,'verified');let first=d.review.latestDelivery;
 const frozen=await h.request(base+'/deliveries/'+first.id+'/files?version=1&path=src%2Fadd.cjs&side=after');assert(frozen.text.includes('a+b'));d=await h.request(base+'/delivery-review',{version:d.version,deliveryId:first.id,deliveryVersion:1,action:'request_changes',requestId:'feedback',comment:'补充注释'});assert.equal(d.review.latestDelivery.status,'changes_requested');await h.request(base+'/messages',{content:'按已保存意见继续'});d=await h.idle(s.id);assert.equal(d.review.latestDelivery.version,2);assert.equal(d.review.task.id,first.taskId);const second=d.review.latestDelivery,accept={version:d.version,deliveryId:second.id,deliveryVersion:2,action:'accept',requestId:'accept'};d=await h.request(base+'/delivery-review',accept);assert.equal(d.acceptanceStatus,'accepted');await h.request(base+'/delivery-review',accept);assert.equal((await h.request(base)).acceptanceStatus,'accepted');assert.equal((await h.request(base+'/deliveries/'+first.id)).status,'stale');
 d=await h.request(base+'/tasks',{version:d.version,description:'下一任务：仅新增说明'});await h.request(base+'/messages',{content:'下一任务：仅新增说明'});d=await h.idle(s.id);assert.deepEqual(d.review.latestDelivery.netChanges.map(f=>f.path),['src/note.md']);await h.request(base+'/delivery-review',{...accept,version:d.version,requestId:'old-task'},400);const other=await h.request('/api/assistant/sessions',{projectId:h.projectId});await h.request('/api/assistant/sessions/'+other.id+'/deliveries/'+second.id,undefined,400);
 }finally{await h.close();}
});
