import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPromptDiagnostics,requestHash} from '../dist/src/models/prompt-diagnostics.js';
import {legacyAssistantPrompt} from '../dist/src/assistant/prompt-descriptor.js';
import {createTokenUsage} from '../dist/src/assistant/token-usage.js';
import {createContextOutputs,trimHistory} from '../dist/src/assistant/assistant-context.js';
import {tokenUsageView} from '../dist/web/token-usage-view.js';
const scope={projectId:'p',sessionId:'s',purpose:'assistant_loop',routeScopeId:'route',configurationRevision:1};
const shape=(prompt)=>({bodyText:JSON.stringify({input:prompt}),prompt,system:'fixed-system',parameterHashes:{model:requestHash('fixture')}});
const rendered=value=>legacyAssistantPrompt('fixed instruction',[{name:'read_file'}],value);
const compare=(tracker,id,value)=>{const p=rendered(value);return tracker.prepare(scope,id,1,shape(p.prompt),p.descriptor);};
const event=(id,text='原文')=>({id,kind:'tool_result',role:'tool',body:{tool:'read_file',ok:true,result:{content:text}}});
test('UTF-8 wire/text offsets, append/remove/rewrite/reorder and dynamic fields have separate evidence without content leaks',()=>{
 const t=createPromptDiagnostics(),first=compare(t,'first',{currentTask:'one',history:[event(1,'中文 "escape"\n history <private>'),event(2)]});t.headers(first);t.commit(first);
 const append=compare(t,'append',{currentTask:'two',history:[event(1,'中文 "escape"\n history <private>'),event(2),event(3)]});assert.equal(append.metadata.historyMutation,'none');assert.equal(append.metadata.firstChangedHostField,'currentTask');assert.equal(append.metadata.firstChangedRegion,'context');assert(!JSON.stringify(append.metadata).includes('private'));
 const cases=[[[event(2)],'remove',1],[[event(1,'changed'),event(2)],'rewrite',1],[[event(2),event(1,'中文 "escape"\n history <private>')],'reorder',2]];
 for(const [history,mutation,id] of cases){const value=compare(t,mutation,{currentTask:'one',history});assert.equal(value.metadata.historyMutation,mutation);assert.equal(value.metadata.firstChangedEventId,id);const a=first.candidate.wire,b=value.candidate.wire;let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;assert.equal(value.metadata.wireBodyPrefixBytes,i);}
 const opaque=t.prepare(scope,'opaque',1,shape('prefix-中文'));
 assert.equal(opaque.metadata.historyMutation,'unknown');
 const ordered=compare(t,'ordered',{history:[event(1),event(2),event(3),event(4)]});t.headers(ordered);t.commit(ordered);
 assert.equal(compare(t,'late-reorder',{history:[event(1),event(2),event(4),event(3)]}).metadata.firstChangedEventId,4);
});
test('headers are required, LRU is bounded, restart and scopes are honest',()=>{
 const t=createPromptDiagnostics(1,10000),a=compare(t,'a',{history:[]});t.commit(a);assert.equal(compare(t,'b',{history:[]}).metadata.comparisonState,'unavailable');t.headers(a);t.commit(a);
 for(const change of [{projectId:'other-project'},{sessionId:'other-session'},{purpose:'compaction'},{routeScopeId:'other-configuration'}]){
  const isolated=t.prepare({...scope,...change},'isolated',1,shape('same'));assert.equal(isolated.metadata.comparisonState,'unavailable');assert.equal(isolated.metadata.baselineUsageId,null);
 }
 const b=t.prepare({...scope,sessionId:'other'},'other',1,shape('other'));t.headers(b);t.commit(b);
 const evicted=compare(t,'c',{history:[]});assert.equal(evicted.metadata.logicalInputPrefixBytes,null);assert.equal(evicted.metadata.baselineUnavailableReason,'memory_budget');
 const restart=createPromptDiagnostics().prepare({...scope,previousUsageId:'a',previousProcessId:a.metadata.processInstanceId},'restart',1,shape('new'));assert.equal(restart.metadata.baselineUnavailableReason,'restart');assert.equal(restart.metadata.wireBodyPrefixBytes,null);
 const tiny=createPromptDiagnostics(1,1),large=compare(tiny,'large',{history:[]});tiny.headers(large);tiny.commit(large);assert.equal(compare(tiny,'again',{history:[]}).metadata.baselineUnavailableReason,'memory_budget');
});
test('parameter deletion is visible and diagnostic UI escapes persisted data',()=>{
 const t=createPromptDiagnostics(),initial=shape('same');initial.parameterHashes.reasoning=requestHash('high');
 const a=t.prepare(scope,'a',1,initial);t.headers(a);t.commit(a);
 const b=t.prepare(scope,'b',1,shape('same'));assert.deepEqual(b.metadata.changedParameters,['reasoning']);
 const s=store();try{
  const usage=createTokenUsage(s),payload='<img src=x onerror=alert(1)>',report=usage.report('p','s','task');
  report.recent=[{purpose:'assistant_loop',requestDiagnostics:{...b.metadata,layout:payload,wireBodyHash:payload,firstChangedHostField:payload,changedHostFields:[payload],changedParameters:[payload],historyChanges:['remove','rewrite']}}];
  const output=tokenUsageView(report);assert(output.includes('&lt;img'));assert(!output.includes('<img'));assert(output.includes('最终请求诊断'));assert(output.includes('历史事件移除、事件表示改写'));assert(output.includes('事件候选'));
  report.recent=[{purpose:'assistant_loop'}];assert(!tokenUsageView(report).includes('最终请求诊断'));
 }finally{s.db.close();}
});
function store(){const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES ('s'),('other')");return {db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};}
test('legacy moving file pool and age filter diagnose actual event representation changes',()=>{
 const s=store();try{
 const out=createContextOutputs(s),t=createPromptDiagnostics();const raw=[1,2,3].map(id=>({id,role:'tool',kind:'tool_result',body:JSON.stringify({tool:'read_file',ok:true,result:{path:'file-'+id,content:'x'.repeat(14000)}})}));
 const a=compare(t,'a',{history:out.history('s',raw,true,true)});t.headers(a);t.commit(a);
 const b=compare(t,'b',{history:out.history('s',[...raw,{...raw[0],id:4,body:raw[0].body.replace('file-1','file-4')}],true,true)});assert.equal(b.metadata.historyMutation,'rewrite');assert.equal(b.metadata.firstChangedEventId,2);
 const activity={id:10,role:'assistant',kind:'activity',body:'{}'},padding=Array.from({length:10},(_,i)=>({id:11+i,role:'system',kind:'message',body:'{}'}));
 const a2=compare(t,'a2',{history:out.history('s',trimHistory([activity]),true)});t.headers(a2);t.commit(a2);assert.equal(compare(t,'b2',{history:out.history('s',trimHistory([activity,...padding]),true)}).metadata.historyMutation,'remove');
 }finally{s.db.close();}
});
test('diagnostic persistence is pending-only, scope-bound, atomic with usage and read-only on report',()=>{
 const s=store();try{
 const usage=createTokenUsage(s),settings={provider:'custom',model:'fixture',apiType:'openai-completions',baseUrl:'http://private-endpoint.invalid',apiKeyEnv:'PRIVATE_KEY_REF'};
 const currentScope=usage.diagnosticScope('p','s','assistant_loop',settings,1,'legacy-v1');
 const id=usage.start({invocationId:'inv',attempt:1,projectId:'p',sessionId:'s',taskId:'task',purpose:'assistant_loop',provider:'custom',model:'fixture',apiType:'openai-completions',estimatedPromptTokens:1});
 const t=createPromptDiagnostics(),p=rendered({history:[]}),d=t.prepare(currentScope,id,1,shape(p.prompt),p.descriptor);
 assert.throws(()=>usage.attachDiagnostic(id,2,d.metadata),/归属/);usage.attachDiagnostic(id,1,d.metadata);assert.throws(()=>usage.attachDiagnostic(id,1,d.metadata));
 const done={attempt:1,status:'completed',durationMs:1,usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,cacheWriteTokens:null,reasoningTokens:null},usageComplete:true,transportObservation:{requestCreated:true,writeCompleted:true,responseHeaders:true,terminal:true}};
 s.db.exec("CREATE TRIGGER reject_diagnostic_finish BEFORE UPDATE ON model_prompt_diagnostics BEGIN SELECT RAISE(ABORT,'diagnostic save failed');END");assert.throws(()=>usage.finish(id,done));assert.equal(s.row('SELECT status FROM model_token_usage').status,'pending');s.db.exec('DROP TRIGGER reject_diagnostic_finish');usage.finish(id,done);
 const changed=s.row('SELECT total_changes() n').n;const report=usage.report('p','s','task');assert.equal(report.recent[0].requestDiagnostics.wireBodyHash,d.metadata.wireBodyHash);assert.equal(usage.report('p','other','task').recent.length,0);assert.equal(s.row('SELECT total_changes() n').n,changed);
 const rebuilt=createTokenUsage(s),nextScope=rebuilt.diagnosticScope('p','s','assistant_loop',settings,1,'legacy-v1');assert.equal(nextScope.previousUsageId,id);assert.equal(nextScope.routeScopeId,currentScope.routeScopeId);
 assert.equal(createPromptDiagnostics().prepare(nextScope,'next',1,shape(p.prompt),p.descriptor).metadata.baselineUnavailableReason,'restart');
 assert(!JSON.stringify(report).includes('private-endpoint'));assert(!JSON.stringify(report).includes('PRIVATE_KEY_REF'));s.db.prepare('DELETE FROM model_token_usage WHERE id=?').run(id);assert.equal(s.row('SELECT COUNT(*) n FROM model_prompt_diagnostics').n,0);
 }finally{s.db.close();}
});
