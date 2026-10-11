import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationParser, readConversation } from '../dist/web/conversation-stream.js';
import { saveBrief } from '../dist/web/requirements-form.js';

const encoder=new TextEncoder();
const frame=(type,data)=>`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const complete={id:'s1',revision:3,turns:[{role:'user',content:'问题'},{role:'apix',content:'正式回复'}]};
function response(chunks) {return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(encoder.encode(chunk));controller.close();}}));}
test('actual parser retains bytes and frames across every UTF-8 boundary',()=>{
  const parser=new ConversationParser();const bytes=encoder.encode(frame('delta',{text:'中文😀"\n'}));const events=[];
  for(const byte of bytes)events.push(...parser.push(Uint8Array.of(byte)));
  events.push(...parser.push(new Uint8Array(),true));
  assert.deepEqual(events,[{type:'delta',data:{text:'中文😀"\n'}}]);
});
test('actual parser accepts CRLF, comments, no optional space and multiline JSON',()=>{
  const parser=new ConversationParser();
  const raw=': comment\r\nevent:delta\r\ndata:{\r\ndata: "text": "中文"\r\ndata:}\r\n\r\n';
  const events=[];for(const byte of encoder.encode(raw))events.push(...parser.push(Uint8Array.of(byte)));
  assert.deepEqual(events,[{type:'delta',data:{text:'中文'}}]);
});
test('complete uses apix formal session and ignores duplicate/invalid later events',async()=>{
  const seen=[];
  await readConversation(response([frame('start',{sessionId:'s1'}),frame('delta',{text:'预览'}),frame('complete',complete)+'event: delta\ndata: invalid\n\n']), 's1', {delta:text=>seen.push(text),complete:s=>seen.push(s)});
  assert.deepEqual(seen,['预览',complete]);
});
test('error and EOF retain received deltas and preserve the original error',async()=>{
  for(const end of [frame('error',{error:'服务失败'}),'']){
    let partial='';let finalized=false;
    await assert.rejects(readConversation(response([frame('delta',{text:'已有片段'}),end]),'s1',{delta:t=>partial+=t,complete:()=>finalized=true}),end?/服务失败/:/连接中断/);
    assert.equal(partial,'已有片段');assert.equal(finalized,false);
  }
});
test('wrong target and invalid formal role are rejected',async()=>{
  const callbacks={delta(){assert.fail('unexpected delta');},complete(){assert.fail('unexpected complete');}};
  await assert.rejects(readConversation(response([frame('start',{sessionId:'other'})]),'s1',callbacks),/目标不匹配/);
  await assert.rejects(readConversation(response([frame('complete',{...complete,turns:[{role:'assistant',content:'wrong'}]})]),'s1',callbacks),/正式对话/);
});
test('complete without deltas and consecutive requests each finalize once',async()=>{
  const seen=[];const callbacks={delta(){},complete:s=>seen.push(s.revision)};
  await readConversation(response([frame('complete',complete)]),'s1',callbacks);
  await readConversation(response([frame('complete',{...complete,revision:4})]),'s1',callbacks);
  assert.deepEqual(seen,[3,4]);
});
test('HTTP errors do not become secondary parser errors',async()=>{
  await assert.rejects(readConversation(new Response('{"error":"拒绝"}',{status:400}),'s1',{delta(){},complete(){}}),/拒绝/);
});

test('brief saves retain the original target and chained revision across navigation',async()=>{
  const original={id:'old-target',revision:3,requirements:{goal:'old',scope:'old'}};
  const entries=[['goal','new goal'],['scope','new scope']];const calls=[];
  let visible=original;
  const result=await saveBrief(original,entries,async(id,revision,field,value)=>{
    calls.push({id,revision,field,value});
    visible={id:'new-target',revision:99,requirements:{goal:'unrelated'}};
    entries[1][1]='changed after navigation';
    return {...original,revision:revision+1};
  });
  assert.deepEqual(calls,[{id:'old-target',revision:3,field:'goal',value:'new goal'},{id:'old-target',revision:4,field:'scope',value:'new scope'}]);
  assert.equal(result.revision,5);assert.equal(visible.id,'new-target');
});
test('unchanged brief makes no requests and failures stop later writes',async()=>{
  const s={id:'s1',revision:1,requirements:{goal:'same'}};
  assert.equal(await saveBrief(s,[['goal','same']],()=>assert.fail('unexpected write')),s);
  let calls=0;await assert.rejects(saveBrief(s,[['goal','changed'],['scope','new']],async()=>{calls++;throw new Error('stale');}),/stale/);
  assert.equal(calls,1);
});
