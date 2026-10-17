import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApiXAgent} from '../dist/src/apix-agent.js';
import {emptyRequirements} from '../dist/src/requirement-engine.js';

test('planning distinguishes inference failure from invalid dependencies and accepts whitespace around JSON fences',async()=>{
  const requirements={goal:'实现',scope:'现有模块',constraints:'保留功能',deliverable:'代码',acceptance:'测试通过'},employees=[{id:'one'}];
  const failed=await createApiXAgent({infer:async()=>{throw new Error('connection timeout');}}).plan(requirements,employees);
  assert.equal(failed.failureKind,'inference');assert.equal(failed.mode,'rules');
  const invalid=await createApiXAgent({infer:async()=>JSON.stringify({steps:[{prompt:'implement',employeeId:'one',dependsOn:[0]}]})}).plan(requirements,employees);
  assert.equal(invalid.failureKind,'response');assert.match(invalid.error,/计划依赖无效/);assert.equal(invalid.mode,'rules');
  const valid=await createApiXAgent({infer:async()=> ' \n```json\n'+JSON.stringify({steps:[{prompt:'implement',employeeId:'one',dependsOn:[]}]})+'\n```\n '}).plan(requirements,employees);
  assert.equal(valid.mode,'api');
});

test('ApiX streams only the top-level reply across escapes and Unicode splits', async()=>{
  const reply = '中文\n引号"与反斜杠\\，火箭🚀';
  const raw = JSON.stringify({kind:'clarification',updates:[{question:'不应展示'}],question:reply,conflicts:[]}).replace('🚀','\\uD83D\\uDE80');
  const deltas=[];
  const agent=createApiXAgent({infer:async(_prompt,onDelta)=>{for(const char of raw)onDelta(char);return raw;}});
  const result=await agent.discuss(emptyRequirements(),'讨论需求',[],[],'conversational',delta=>deltas.push(delta));
  assert.equal(result.mode,'api');
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
  assert.equal(result.mode,'api');
  assert.match(prompt,/前文目标/);
  assert.match(prompt,/running/);
});

test('malformed and over-limit model replies fall back without applying unvalidated updates',async()=>{
  for(const raw of ['{"question":"半截','<｜DSML｜tool_calls><invoke name="quota" /></｜DSML｜tool_calls>', JSON.stringify({kind:'clarification',question:'x'.repeat(10001),updates:[],conflicts:[]})]) {
    const agent=createApiXAgent({infer:async()=>raw});
    const result=await agent.discuss(emptyRequirements(),'补充需求',[],[]);
    assert.equal(result.mode,'rules');
    assert(result.error);
    assert(!result.error.includes('Unexpected token'));
    assert.deepEqual(result.updates,{});
  }
});

test('optional context keeps complete recent records and valid JSON without dropping confirmed requirements',async()=>{
  let prompt='';
  const agent=createApiXAgent({infer:async input=>{prompt=input;return JSON.stringify({kind:'progress',question:'已收到',updates:[],conflicts:[]});}});
  const requirements={goal:'g'.repeat(4000),scope:'s'.repeat(4000),constraints:'完整约束必须保留',deliverable:'deliver',acceptance:'accept'};
  await agent.discuss(requirements,'最新问题',Array.from({length:30},(_,i)=>({role:'user',content:`历史 ${i} ${'x'.repeat(4000)}`})),{events:'y'.repeat(30000)});
  const history=JSON.parse(prompt.split('\n历史：')[1].split('\n真实进度：')[0]);
  assert(history.omitted>0);assert(history.items.length>0);assert.match(history.items.at(-1).content,/历史 29/);
  assert.equal(JSON.parse(prompt.split('\n真实进度：')[1].split('\n用户最新消息：')[0]).omitted,true);
  assert(prompt.includes(JSON.stringify(requirements)));assert(prompt.endsWith('最新问题'));assert(prompt.length<55000);
});

test('quality review preserves the middle of complete evidence and refuses over-budget evidence before inference',async()=>{
  let prompt='';let calls=0;
  const agent=createApiXAgent({infer:async input=>{prompt=input;calls++;return JSON.stringify({passed:true,findings:[]});}});
  const requirements={goal:'实现',scope:'core',constraints:'安全',deliverable:'代码',acceptance:'完整审查'};
  const architecture={version:1,summary:'frozen',modules:[],digest:'fixture'};
  const evidence={currentCode:{files:[{path:'a.txt',content:'a'.repeat(25000)+'MIDDLE_DEFECT_MUST_BE_REVIEWED'+'b'.repeat(25000)}],truncated:false},tests:[{exitCode:0}]};
  await agent.review(requirements,architecture,'core',evidence,{projectId:'p',purpose:'quality'});
  assert(prompt.includes(JSON.stringify(evidence)));assert(prompt.includes('MIDDLE_DEFECT_MUST_BE_REVIEWED'));
  evidence.currentCode.files[0].content='x'.repeat(100001);
  await assert.rejects(()=>agent.review(requirements,architecture,'core',evidence,{projectId:'p',purpose:'quality'}),/验收证据超出完整上下文预算/);
  await assert.rejects(()=>agent.review(requirements,{...architecture,summary:'x'.repeat(24001)},'core',{}, {projectId:'p',purpose:'quality'}),/冻结契约超出完整上下文预算/);
  assert.equal(calls,1);
});

test('oversized employee context blocks planning instead of being labeled as unavailable inference or creating a partial plan',async()=>{
  let calls=0;const agent=createApiXAgent({infer:async()=>{calls++;return '{}';}});
  await assert.rejects(()=>agent.plan({goal:'实现',scope:'项目',constraints:'安全',deliverable:'代码',acceptance:'测试'},[{id:'one',name:'x'.repeat(16001)}]),/员工列表超出完整上下文预算/);
  assert.equal(calls,0);
});

test('manager receives trusted project context and requests host scheduling even without tool authorization',async()=>{
  let received;let prompt;
  const context={projectId:'project-1',purpose:'discussion'};
  const agent=createApiXAgent({infer:async(p,_delta,c)=>{prompt=p;received=c;return JSON.stringify({kind:'work',question:'将生成待审计划',updates:[],conflicts:[]});}});
  const result=await agent.discuss(emptyRequirements(),'请分发任务',[],{automaticWork:false},'conversational',undefined,context);
  assert.equal(result.kind,'work');assert.equal(received,context);
  assert.match(prompt,/无论 automaticWork 是否开启/);assert.match(prompt,/不依赖文件写入/);
});
test('model-proposed fees are discarded before profile validation without granting a budget',async()=>{
  const agent=createApiXAgent({infer:async()=>JSON.stringify({steps:[{prompt:'创建并验证文件',employeeId:'worker',dependsOn:[],scheduling:{estimateMinor:0.02,fixedEmployeeId:'invented',estimates:'unapproved',writePaths:['sum.mjs']}}]})});
  const result=await agent.plan({goal:'测试',scope:'当前项目',constraints:'不批准费用',deliverable:'文件',acceptance:'验证'},[{id:'worker',name:'worker',runtime:'codex',enabled:1}]);
  assert.equal(result.mode,'api');assert.equal(result.steps[0].scheduling.estimateMinor,null);assert.equal(result.steps[0].scheduling.fixedEmployeeId,null);assert.deepEqual(result.steps[0].scheduling.estimates,[]);assert.deepEqual(result.steps[0].scheduling.writePaths,['sum.mjs']);
});
test('A03 malformed architecture and contradictory quality replies cannot approve delivery',async()=>{
  const requirements={goal:'测试已确认目标',scope:'隔离项目',constraints:'不扩大范围',deliverable:'实现',acceptance:'实际检查'};
  for(const raw of ['{"modules":',JSON.stringify({summary:'missing modules',modules:[]})]){
    const agent=createApiXAgent({infer:async()=>raw});await assert.rejects(()=>agent.architect(requirements,[],{projectId:'p',purpose:'architecture'}),/JSON|架构|Unexpected|Expected/);
  }
  const architecture={version:1,summary:'frozen',modules:[],digest:'fixture'};
  for(const reply of [{passed:true,findings:['still broken']},{passed:false,findings:[]},{passed:'true',findings:[]},{passed:false,findings:['']},{passed:true,findings:'none'}]){
    const agent=createApiXAgent({infer:async()=>JSON.stringify(reply)});await assert.rejects(()=>agent.review(requirements,architecture,'core',{}, {projectId:'p',purpose:'quality'}),/无效|问题/);
  }
});
