import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerPrompt } from '../dist/src/worker-context.js';
import { coordinationStatus, progressSummary } from '../dist/src/task-tracker.js';
import { createApiXAgent } from '../dist/src/apix-agent.js';
import {normalizeWorkerEvent} from '../dist/src/worker-events.js';
test('native Codex retry diagnostics stay observable while terminal failures still fail',()=>{
  assert.equal(normalizeWorkerEvent('codex',{type:'error',message:'Reconnecting... 5/5 (request timed out)'}).failed,false);
  assert.equal(normalizeWorkerEvent('codex',{type:'turn.failed'}).failed,true);
  assert.equal(normalizeWorkerEvent('codex',{type:'error',message:'fatal error'}).failed,true);
  assert.equal(normalizeWorkerEvent('codex',{type:'error',message:{text:'Reconnecting...'}}).failed,true);
});
import { instructionState } from '../dist/web/execution-view.js';

test('worker context keeps approved instructions and all large dependency references within budget', () => {
  const {prompt,truncated}=workerPrompt('本次任务','已确认需求 v3 与消息协议',['前置 A: '+ 'a'.repeat(40000),'前置 B: '+ 'b'.repeat(40000),'项目档案'],1500);
  assert(prompt.startsWith('本次任务\n\n已确认需求 v3 与消息协议'));
  assert(prompt.length<=1500);
  assert.match(prompt,/前置 A:/); assert.match(prompt,/前置 B:/); assert.match(prompt,/项目档案/);
  assert.match(prompt,/不代表代码已进入/); assert.match(prompt,/资料截断/);
  assert.equal(truncated,2);
});

test('oversized approved context fails before it can be silently dropped', () => {
  assert.throws(()=>workerPrompt('task','x'.repeat(30000),[]),/重新批准/);
  assert.equal(workerPrompt('task','',[]).prompt,'task');
  assert.equal(workerPrompt('task','', ['x'],4).prompt,'task');
});

test('parallel execution never hides a failed task and completion requires acceptance', () => {
  const tasks=statuses=>statuses.map((status,index)=>({id:String(index),status}));
  assert.equal(coordinationStatus('running',tasks(['failed','running'])),'attention');
  assert.equal(coordinationStatus('running',tasks(['accepted','queued'])),'queued');
  assert.equal(coordinationStatus('running',tasks(['accepted','completed'])),'awaiting_acceptance');
  assert.equal(coordinationStatus('running',tasks(['completed','queued'])),'awaiting_acceptance');
  assert.equal(coordinationStatus('running',tasks(['accepted','accepted'])),'completed');
  assert.equal(coordinationStatus('plan_review',tasks(['awaiting_approval'])),'plan_review');
  assert.deepEqual(progressSummary([{id:'a',status:'completed',employee_id:'one'},{id:'b',status:'queued',employee_id:'two'}],[{task_id:'b',depends_on_id:'a'}])[1].waitingFor,['a']);
  assert.deepEqual(progressSummary([{id:'a',status:'accepted'},{id:'b',status:'queued'}],[{task_id:'b',depends_on_id:'a'}])[1].waitingFor,[]);
});

test('ApiX planning supports parallel ownership, evidence and explicit integration boundaries', async () => {
  let prompt;
  const agent=createApiXAgent({infer:async input=>{prompt=input;return JSON.stringify({steps:[{prompt:'实现 A 并提交验证证据',employeeId:'one',dependsOn:[]},{prompt:'实现 B 并提交验证证据',employeeId:'two',dependsOn:[]},{prompt:'集成后审查',employeeId:'two',dependsOn:[0,1]}]});}});
  const result=await agent.plan({goal:'优化协作',scope:'现有模块',constraints:'保留审批',deliverable:'代码与审查',acceptance:'可复现验证'},[{id:'one',role:'开发'},{id:'two',role:'审查'}]);
  assert.equal(result.mode,'api'); assert.deepEqual(result.steps.map(step=>step.dependsOn),[[],[],[0,1]]);
  assert.match(prompt,/文件范围不重叠/); assert.match(prompt,/另一位合适员工/); assert.match(prompt,/集成后才能验证/);
});

test('guidance acknowledgement is distinguished from delivery and reported processing',()=>{
  assert.equal(instructionState('queued'),'待接收');
  assert.equal(instructionState('delivered'),'已送达，待确认');
  assert.equal(instructionState('processing'),'员工已确认接收');
  assert.equal(instructionState('completed'),'员工已报告处理');
  assert.equal(instructionState('expired'),'已超时');
});
