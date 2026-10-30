import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {Query,SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {RunHandle,RuntimeInput} from './runtime-contract.js';
import {runtimeError} from './runtime-contract.js';
import {nativeQuestions,runtimeChannel,stopRuntimeTree} from './native-runtime.js';

export function openClaudeAgentSdk(input:RuntimeInput):RunHandle{
  const channel=runtimeChannel(),questions=nativeQuestions(channel),inputs:{content:string;id?:string}[]=[{content:input.prompt}];
  let wake:(()=>void)|undefined,stopping=false,done=false,child:ChildProcess|undefined,session:Query|undefined,turnId='',output='',nativeSession='',readyForNext=true;
  let closing:Promise<{evidence:'quiescent'|'unknown'}>|undefined;
  async function* messages():AsyncGenerator<SDKUserMessage>{while(!stopping){if(!inputs.length||!readyForNext){await new Promise<void>(resolve=>wake=resolve);continue;}const next=inputs.shift()!;readyForNext=false;turnId=randomUUID();output='';channel.runtime('turn.started',{turnId,messageId:next.id});if(next.id)channel.runtime('message.delivery',{messageId:next.id,mode:'queue',state:'accepted'});yield {type:'user',message:{role:'user',content:next.content},parent_tool_use_id:null,session_id:nativeSession};}}
  function close(){return closing??=(async()=>{stopping=true;const evidence=await stopRuntimeTree(child);wake?.();questions.cancel();done=true;try{session?.close();}catch{return {evidence:'unknown' as const};}return {evidence};})();}
  async function run(){
    const {query}=await import('@anthropic-ai/claude-agent-sdk');if(stopping)return;
    session=query({prompt:messages(),options:{cwd:input.cwd,env:input.env,pathToClaudeCodeExecutable:input.command.prefix[0]??input.command.executable,model:input.model||undefined,resume:input.resumeSessionId,settingSources:[],settings:{disableAllHooks:true},tools:['Read','Glob','Grep','Edit','Write','Bash','AskUserQuestion'],permissionMode:'default',includePartialMessages:true,
      spawnClaudeCodeProcess(options){if(stopping)throw new Error('运行已停止，不再启动原生进程');const process=spawn(options.command,options.args,{cwd:options.cwd,env:options.env,windowsHide:true,detached:globalThis.process.platform!=='win32',stdio:['pipe','pipe','pipe']});child=process;channel.runtime('runtime.process',{pid:process.pid??null});return process;},
      async canUseTool(name,args){
        if(!['Read','Glob','Grep','Edit','Write','Bash','AskUserQuestion'].includes(name))return {behavior:'deny',message:'工具不在 ApiX 本次运行范围内'};
        if(name==='AskUserQuestion'){const answer=await questions.ask('question',{questions:args.questions,answerFormat:'claude'});return {behavior:'allow',updatedInput:{...args,answers:answer.answers}};}
        if(input.fullAccess)return {behavior:'allow',updatedInput:args};
        const answer=await questions.ask('approval',{operation:name,summary:JSON.stringify(args).slice(0,4000)});return answer.decision==='approve'?{behavior:'allow',updatedInput:args}:{behavior:'deny',message:'ApiX 用户拒绝本次操作'};
      }
    }});
    for await(const event of session){
      if(stopping)break;const value=event as any;
      if(value.type==='system'&&value.subtype==='init')channel.runtime('runtime.version',{executorVersion:value.claude_code_version??null,sdkVersion:'0.3.314'});
      if(input.resumeSessionId&&value.session_id&&value.session_id!==input.resumeSessionId)throw new Error('原生延续返回了不同会话，已请求关闭');
      if(value.session_id&&value.session_id!==nativeSession){nativeSession=value.session_id;channel.runtime('runtime.bound',{nativeSessionId:nativeSession});}
      if(value.type==='stream_event'&&value.event?.type==='content_block_delta'&&value.event.delta?.type==='text_delta')channel.runtime('output.delta',{turnId,text:value.event.delta.text,nodeId:value.event.index});
      if(value.type==='assistant')for(const block of value.message?.content??[]){if(block.type==='text')output+=(output?'\n':'')+block.text;if(block.type==='tool_use')channel.runtime('tool.started',{turnId,toolCallId:block.id,name:block.name,summary:block.name});}
      if(value.type==='user')for(const block of value.message?.content??[])if(block.type==='tool_result')channel.runtime('tool.finished',{turnId,toolCallId:block.tool_use_id,name:'tool',status:block.is_error?'failed':'completed'});
      if(value.type==='result'){
        const success=value.subtype==='success'&&!value.is_error;if(!success)channel.runtime('runtime.error',{code:'NATIVE_TURN_FAILED',message:String(value.errors?.join('\n')??value.subtype??'SDK 回合失败')});channel.runtime('usage.updated',{turnId,basis:'turn',source:'claude-agent-sdk',usage:value.usage??{}});channel.runtime('turn.finished',{turnId,status:success?'completed':'failed'});
        channel.emit({kind:'output',text:String(value.result??output)+'\n'});
        if(!success||!inputs.length){const result=await close();channel.emit({kind:'closed',code:child?.exitCode??null,signal:child?.signalCode??null,evidence:result.evidence,outcome:success?'completed':'failed'});return;}readyForNext=true;wake?.();wake=undefined;
      }
    }
    if(!done){const result=await close();channel.emit({kind:'closed',code:child?.exitCode??null,signal:child?.signalCode??null,evidence:result.evidence,outcome:'failed'});}
  }
  void run().catch(async error=>{channel.runtime('runtime.error',{code:'NATIVE_RUNTIME_ERROR',message:error instanceof Error?error.message:'SDK 运行失败'});const result=await close();channel.emit({kind:'closed',code:child?.exitCode??null,signal:child?.signalCode??null,evidence:result.evidence,outcome:'failed'});});
  return {events:channel.events,get pid(){return child?.pid??null;},isActive:()=>!done,closeInput:()=>{},close,answer:questions.answer,
    interrupt(){if(stopping)return;void close().then(result=>channel.emit({kind:'closed',code:child?.exitCode??null,signal:child?.signalCode??null,evidence:result.evidence,outcome:'cancelled'}));},
    async send(message){if(message.mode!=='queue')throw runtimeError('RUNTIME_UNSUPPORTED','Claude SDK 仅支持排队补充',400);if(stopping)throw runtimeError('RUN_NOT_ACTIVE','运行已关闭');inputs.push({id:message.messageId,content:message.content});wake?.();wake=undefined;return {state:'queued'};}
  };
}
