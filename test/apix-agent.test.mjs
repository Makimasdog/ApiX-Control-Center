import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApiXAgent} from '../dist/src/apix-agent.js';
import {emptyRequirements} from '../dist/src/requirement-engine.js';

test('ApiX streams only the top-level reply across escapes and Unicode splits', async()=>{
  const reply = '中文\n引号"与反斜杠\\，火箭🚀';
  const raw = JSON.stringify({kind:'clarification',updates:[{question:'不应展示'}],question:reply,conflicts:[]}).replace('🚀','\\uD83D\\uDE80');
  const deltas=[];
  const agent=createApiXAgent({infer:async(_prompt,onDelta)=>{for(const char of raw)onDelta(char);return raw;}});
  const result=await agent.discuss(emptyRequirements(),'讨论需求',[],[],'conversational',delta=>deltas.push(delta));
  assert.equal(result.mode,'pi');
  assert.equal(result.question,reply);
  assert.equal(deltas.join(''),reply);
  assert(deltas.length>1);
  assert(!deltas.some(delta=>/[\uD800-\uDBFF]$/.test(delta)));
});

test('ApiX keeps a long reply, history and fact-based progress in the prompt',async()=>{
  const question='自然回复。'.repeat(300);
  let prompt;
  const agent=createApiXAgent({infer:async input=>{prompt=input;return JSON.stringify({kind:'progress',question,updates:[],conflicts:[]});}});
  const result=await agent.discuss(emptyRequirements(),'继续讨论',[{role:'user',content:'前文目标'}],[{status:'running'}]);
  assert.equal(result.question,question);
  assert.equal(result.mode,'pi');
  assert.match(prompt,/前文目标/);
  assert.match(prompt,/running/);
});

test('malformed and over-limit model replies fall back without applying unvalidated updates',async()=>{
  for(const raw of ['{"question":"半截', JSON.stringify({kind:'clarification',question:'x'.repeat(10001),updates:[],conflicts:[]})]) {
    const agent=createApiXAgent({infer:async()=>raw});
    const result=await agent.discuss(emptyRequirements(),'补充需求',[],[]);
    assert.equal(result.mode,'rules');
    assert(result.error);
    assert.deepEqual(result.updates,{});
  }
});

test('manager receives trusted project context and requests host scheduling even without tool authorization',async()=>{
  let received;let prompt;
  const context={projectId:'project-1',purpose:'discussion'};
  const agent=createApiXAgent({infer:async(p,_delta,c)=>{prompt=p;received=c;return JSON.stringify({kind:'work',question:'将生成待审计划',updates:[],conflicts:[]});}});
  const result=await agent.discuss(emptyRequirements(),'请分发任务',[],{automaticWork:false},'conversational',undefined,context);
  assert.equal(result.kind,'work');assert.equal(received,context);
  assert.match(prompt,/无论 automaticWork 是否开启/);assert.match(prompt,/不依赖文件写入/);
});
