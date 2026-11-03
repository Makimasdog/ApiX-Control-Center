import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {openCodexAppServer} from '../dist/src/agents/codex-app-server.js';
import {openClaudeAgentSdk} from '../dist/src/agents/claude-agent-sdk.js';
import {openCliRuntime} from '../dist/src/agents/cli-runtime.js';
import {stopRuntimeTree} from '../dist/src/agents/native-runtime.js';
import {spawn} from 'node:child_process';
const input=(prompt)=>({command:{executable:process.execPath,prefix:[resolve('test/fake-native-runtime.mjs')]},args:[],cwd:process.cwd(),env:{...process.env,ANTHROPIC_API_KEY:'fixture-not-a-real-key'},runtime:'codex',format:'jsonl',prompt,runId:'run-fixture',fullAccess:false});
test('Codex resumes retained history taking longer than the ordinary 15 second RPC deadline',{timeout:35000},async()=>{
 const value=input('resume history');value.env.APIX_FAKE_RESUME_DELAY_MS='16000';const handle=openCodexAppServer({...value,resumeSessionId:'session-fixture'});const events=[];
 try{for await(const event of handle.events)events.push(event);assert.equal(events.at(-1).outcome,'completed',JSON.stringify(events));assert(events.some(e=>e.kind==='output'&&e.text.includes('原生延续')));}finally{await handle.close();}
});
for(const [name,open] of [['codex',openCodexAppServer],['claude-sdk',openClaudeAgentSdk]])test(`${name} real adapter processes local protocol output and closes its live process`,{timeout:30000},async()=>{
 const handle=open(input('只读任务'));const events=[];try{for await(const e of handle.events)events.push(e);assert(events.some(e=>e.kind==='runtime'&&e.name==='turn.started'));assert(events.some(e=>e.kind==='runtime'&&e.name==='usage.updated'));assert(events.some(e=>e.kind==='output'&&e.text.includes('中文')));const end=events.at(-1);assert.equal(end.kind,'closed');assert.equal(end.outcome,'completed',JSON.stringify(events));assert.equal(end.evidence,'quiescent');assert.equal(handle.isActive(),false);}finally{await handle.close();}
});
test('Codex questions route only an explicit answer and completed turn is independent of process exit',{timeout:30000},async()=>{
 const handle=openCodexAppServer(input('ask'));let asked=false;try{for await(const e of handle.events){if(e.kind==='runtime'&&e.name==='interaction.opened'){asked=true;assert.equal(e.payload.kind,'question');await handle.answer(e.payload.interactionId,{answers:{choice:{answers:['只读']}}});}if(e.kind==='closed')assert.equal(e.outcome,'completed');}assert(asked);}finally{await handle.close();}
});
test('Codex steer, queue and interruption have explicit capability and lifecycle results',{timeout:30000},async()=>{
 const handle=openCodexAppServer(input('hold'));let sent=false,finished=0;try{for await(const e of handle.events){if(e.kind==='runtime'&&e.name==='turn.started'&&!sent){sent=true;await new Promise(r=>setTimeout(r,50));assert.equal((await handle.send({messageId:'second',content:'下一轮',mode:'queue'})).state,'queued');assert.equal((await handle.send({messageId:'guide',content:'finish',mode:'steer'})).state,'accepted');}if(e.kind==='runtime'&&e.name==='turn.finished')finished++;}assert.equal(finished,2);}finally{await handle.close();}
});
test('unexpected App Server exit preserves unknown stop evidence',{timeout:30000},async()=>{const handle=openCodexAppServer(input('disconnect'));try{const events=[];for await(const e of handle.events)events.push(e);assert.equal(events.at(-1).evidence,'unknown');assert.equal(events.at(-1).outcome,'failed');}finally{await handle.close();}});
test('duplicate native turn completion does not repeat host completion or final output',{timeout:30000},async()=>{const handle=openCodexAppServer(input('duplicate'));const events=[];try{for await(const event of handle.events)events.push(event);assert.equal(events.filter(e=>e.kind==='closed').length,1);assert.equal(events.filter(e=>e.kind==='runtime'&&e.name==='turn.finished').length,1);assert.equal(events.filter(e=>e.kind==='output').length,1);}finally{await handle.close();}});
for(const kind of ['SDK_ASK','SDK_APPROVAL'])test(`real SDK bridges ${kind}, queues another round and counts two distinct host turns`,{timeout:30000},async()=>{
 const handle=openClaudeAgentSdk(input(kind));let questions=0,turns=0,usage=0;
 try{for await(const e of handle.events){if(e.kind==='runtime'&&e.name==='turn.started')turns++;if(e.kind==='runtime'&&e.name==='usage.updated')usage++;if(e.kind==='runtime'&&e.name==='interaction.opened'){questions++;assert.equal((await handle.send({messageId:'next-round',mode:'queue',content:'下一轮中文任务'})).state,'queued');await assert.rejects(handle.send({messageId:'invalid',mode:'steer',content:'指导'}),x=>x.code==='RUNTIME_UNSUPPORTED');await handle.answer(e.payload.interactionId,kind==='SDK_ASK'?{answers:{'请选择范围':'只读'}}:{decision:'deny'});}if(e.kind==='closed')assert.equal(e.evidence,'quiescent');}assert.equal(questions,1);assert.equal(turns,2);assert.equal(usage,2);}finally{await handle.close();}
});

test('Windows/Linux tree shutdown ends a real child and its descendant instead of trusting a native interrupt ACK',{timeout:30000},async()=>{
 const child=spawn(process.execPath,['-e',"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"],{windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});let pid;
 try{pid=await new Promise((resolve,reject)=>{child.stdout.once('data',c=>resolve(Number(c.toString().trim())));child.once('error',reject);});assert(Number.isInteger(pid));assert.equal(await stopRuntimeTree(child),'quiescent');assert.throws(()=>process.kill(pid,0));}finally{if(child.exitCode===null&&child.signalCode===null)await stopRuntimeTree(child);if(pid){try{process.kill(pid,'SIGKILL');}catch{}}}
});
for(const runtime of ['pi','codex','claude','gemini','opencode','kimi','custom'])test(`${runtime} CLI transport keeps UTF-8, unparsed lines and trailing JSON with one close`,{timeout:15000},async()=>{
 const source="process.stdin.once('data',()=>{process.stdout.write('not json\\n'+JSON.stringify({type:'result',text:'中文报告'}));process.stderr.write('中文错误');process.stdin.destroy();});";
 const h=openCliRuntime({...input('只读'),runtime,command:{executable:process.execPath,prefix:['-e',source]}}),events=[];
 try{for await(const e of h.events)events.push(...(e.kind==='batch'?e.items:[e]));assert.equal(events.filter(e=>e.kind==='closed').length,1);assert(events.some(e=>e.kind==='native'&&e.item.text==='中文报告'));assert(events.some(e=>e.kind==='stderr'&&e.text==='中文错误'));assert(events.some(e=>e.kind==='unparsed'));}finally{await h.close();}
});
test('concurrent SDK queries keep per-Run environment and do not mutate the host environment',{timeout:30000},async()=>{
 const before=process.env.APIX_FAKE_TAG;
 const results=await Promise.all(['first','second'].map(async tag=>{const h=openClaudeAgentSdk({...input('只读'),env:{...input('只读').env,APIX_FAKE_TAG:tag}});let output='';try{for await(const e of h.events)if(e.kind==='output')output+=e.text;return output;}finally{await h.close();}}));
 assert(results[0].includes('first'));assert(!results[0].includes('second'));assert(results[1].includes('second'));assert(!results[1].includes('first'));assert.equal(process.env.APIX_FAKE_TAG,before);
});
for(const [name,open] of [['codex',openCodexAppServer],['claude-sdk',openClaudeAgentSdk]])test(`${name} cannot silently treat a different native session as successful continuation`,{timeout:30000},async()=>{
 const h=open({...input('只读续聊'),resumeSessionId:'not-the-requested-session'}),events=[];
 try{for await(const e of h.events)events.push(e);assert.equal(events.at(-1).outcome,'failed');assert(events.some(e=>e.kind==='runtime'&&e.name==='runtime.error'));assert(!events.some(e=>e.kind==='output'));}finally{await h.close();}
});
