import {initializeCodex} from './codex-rpc.js';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {RunHandle,RuntimeInput} from './runtime-contract.js';
import {runtimeError} from './runtime-contract.js';
import {nativeQuestions,runtimeChannel,stopRuntimeTree} from './native-runtime.js';

export function openCodexAppServer(input:RuntimeInput):RunHandle{
  const channel=runtimeChannel(),questions=nativeQuestions(channel);
  const child=spawn(input.command.executable,[...input.command.prefix,...(input.configArgs??[]),'-c','project_doc_max_bytes=0','-c','agents.enabled=false','-c','features.multi_agent=false','app-server','--listen','stdio://'],{cwd:input.cwd,env:input.env,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let sequence=0,buffer='',thread='',turn='',hostTurn='',stopping=false,done=false,output='',closing:Promise<{evidence:'quiescent'|'unknown'}>|undefined;
  const requests=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const pendingInputs:{messageId:string;content:string;mode:'steer'|'queue'}[]=[];
  function write(value:unknown){if(!child.stdin.writable)throw new Error('App Server 连接关闭');child.stdin.write(JSON.stringify(value)+'\n');}
  function request(method:string,params:unknown){return new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{requests.delete(id);reject(new Error('App Server 请求超时：'+method));},method==='thread/resume'?60000:15000);requests.set(id,{resolve,reject,timer});try{write({id,method,params});}catch(error){clearTimeout(timer);requests.delete(id);reject(error);}});}
  function rejectRequests(){for(const entry of requests.values()){clearTimeout(entry.timer);entry.reject(new Error('App Server 已关闭'));}requests.clear();}
  function close(){return closing??=(async()=>{stopping=true;questions.cancel();rejectRequests();const evidence=await stopRuntimeTree(child);done=true;return {evidence};})();}
  async function finish(success:boolean){if(stopping)return;stopping=true;questions.cancel();const result=await close();channel.emit({kind:'closed',code:child.exitCode,signal:child.signalCode,evidence:result.evidence,outcome:success?'completed':'failed'});}
  function failure(error:unknown){if(done||stopping)return;channel.runtime('runtime.error',{code:'NATIVE_RUNTIME_ERROR',message:error instanceof Error?error.message:'原生运行失败'});void finish(false);}
  async function startTurn(content:string,messageId?:string){hostTurn=randomUUID();output='';channel.runtime('turn.started',{turnId:hostTurn,messageId});const result=await request('turn/start',{threadId:thread,input:[{type:'text',text:content}],...(input.model?{model:input.model}:{})});turn=result.turn.id;channel.runtime('turn.bound',{turnId:hostTurn,nativeTurnId:turn});}
  async function nativeRequest(value:any){
    const params=value.params??{};
    if((params.turnId&&params.turnId!==turn)||(params.threadId&&params.threadId!==thread)){write({id:value.id,error:{code:-32602,message:'Unknown thread'}});return;}
    if(value.method==='item/tool/requestUserInput'){
      const answer=await questions.ask('question',{questions:params.questions,answerFormat:'codex'});write({id:value.id,result:{answers:answer.answers}});
    }else if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(value.method)){
      const answer=await questions.ask('approval',{operation:value.method,summary:String(params.command??params.reason??'文件修改请求').slice(0,4000)});write({id:value.id,result:{decision:answer.decision==='approve'?'accept':'decline'}});
    }else write({id:value.id,error:{code:-32601,message:'Unsupported host request'}});
  }
  async function notification(value:any){
    const p=value.params??{};if(stopping||p.threadId&&p.threadId!==thread)return;
    if(value.method==='turn/started')turn=p.turn?.id??turn;
    if(value.method==='item/agentMessage/delta'){output+=p.delta??'';channel.runtime('output.delta',{turnId:hostTurn,text:String(p.delta??''),nodeId:p.itemId});}
    if(value.method==='item/started'||value.method==='item/completed'){
      const item=p.item??{};if(['commandExecution','fileChange','mcpToolCall','dynamicToolCall'].includes(item.type))channel.runtime(value.method==='item/started'?'tool.started':'tool.finished',{turnId:hostTurn,toolCallId:item.id,name:item.type,summary:String(item.command??item.tool??item.type).slice(0,1000),status:item.status??'unknown'});
      if(value.method==='item/completed'&&item.type==='agentMessage'&&!output)output=String(item.text??'');
    }
    if(value.method==='thread/tokenUsage/updated')channel.runtime('usage.updated',{turnId:hostTurn,basis:'turn',source:'codex-app-server',usage:p.tokenUsage?.last??{}});
    if(value.method==='turn/completed'){
      if(!turn||p.turn?.id!==turn)return;turn='';const success=p.turn?.status==='completed';if(!success)channel.runtime('runtime.error',{code:'NATIVE_TURN_FAILED',message:String(p.turn?.error?.message??p.turn?.status??'原生回合失败')});if(output)channel.emit({kind:'output',text:output+'\n'});channel.runtime('turn.finished',{turnId:hostTurn,status:success?'completed':p.turn?.status??'failed'});
      if(success&&pendingInputs.length&&!stopping){const next=pendingInputs.shift()!;await startTurn(next.content,next.messageId);channel.runtime('message.delivery',{messageId:next.messageId,state:'accepted',mode:'queue'});}else await finish(success);
    }
  }
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',text=>channel.emit({kind:'stderr',text:String(text).slice(-4000)}));
  child.stdout.on('data',(chunk:string)=>{buffer+=chunk;if(Buffer.byteLength(buffer)>2_000_000){failure(new Error('App Server 单事件超过 2MB'));return;}let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;try{const value=JSON.parse(line),pending=requests.get(value.id);if(pending&&!value.method){clearTimeout(pending.timer);requests.delete(value.id);value.error?pending.reject(new Error('App Server 请求被拒绝')):pending.resolve(value.result);}else if(value.method&&value.id!==undefined)void nativeRequest(value).catch(failure);else void notification(value).catch(failure);}catch{failure(new Error('App Server 返回无效协议事件'));}}});
  child.on('error',failure);child.stdin.on('error',failure);child.on('close',()=>{rejectRequests();if(!stopping){done=true;questions.cancel();channel.runtime('runtime.error',{code:'NATIVE_DISCONNECTED',message:'App Server 意外断开，执行与后代停止待核对'});channel.emit({kind:'closed',code:child.exitCode,signal:child.signalCode,evidence:'unknown',outcome:'failed'});}});
  async function initialize(){const initialized=await initializeCodex(request,method=>write({method}),{experimentalApi:true});channel.runtime('runtime.version',{executorVersion:String(initialized.userAgent??'').match(/\d+\.\d+\.\d+/)?.[0]??null});const result=await request(input.resumeSessionId?'thread/resume':'thread/start',{...(input.resumeSessionId?{threadId:input.resumeSessionId}:{}),cwd:input.cwd,approvalPolicy:input.fullAccess?'never':'on-request',sandbox:input.fullAccess?'danger-full-access':'workspace-write',...(input.model?{model:input.model}:{})});thread=result.thread.id;if(input.resumeSessionId&&thread!==input.resumeSessionId)throw new Error('原生延续返回了不同会话，未启动回合');channel.runtime('runtime.bound',{nativeSessionId:thread});await startTurn(input.prompt);}
  void initialize().catch(failure);
  return {events:channel.events,get pid(){return child.pid??null;},isActive:()=>!done,closeInput:()=>{},close,answer:questions.answer,
    interrupt(){if(stopping)return;stopping=true;questions.cancel();if(turn)void request('turn/interrupt',{threadId:thread,turnId:turn}).catch(()=>{});void close().then(result=>channel.emit({kind:'closed',code:child.exitCode,signal:child.signalCode,evidence:result.evidence,outcome:'cancelled'}));},
    async send(message){if(stopping||!turn)throw runtimeError('STALE_TURN','当前回合已结束');if(message.mode==='queue'){pendingInputs.push(message);return {state:'queued'};}await request('turn/steer',{threadId:thread,expectedTurnId:turn,input:[{type:'text',text:message.content}]});return {state:'accepted'};}
  };
}
