import {execFile,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {RuntimeTransportEvent} from './runtime-contract.js';

export function runtimeChannel(){
  const items:RuntimeTransportEvent[]=[];let ended=false,wake:(()=>void)|undefined;
  function emit(item:RuntimeTransportEvent){if(ended)return;items.push(item);if(item.kind==='closed')ended=true;wake?.();wake=undefined;}
  async function* events(){for(;;){while(items.length)yield items.shift()!;if(ended)return;await new Promise<void>(resolve=>wake=resolve);}}
  return {emit,events:events(),runtime:(name:string,payload:Record<string,any>)=>emit({kind:'runtime',name,payload})};
}

/** 在根进程仍存活时终止进程树；根已先退出则不能再证明其后代停止。 */
export async function stopRuntimeTree(child:ChildProcess|undefined,diagnostic?:(details:{reason:string;treeStopConfirmed:boolean;rootClosed:boolean;errorCode:string|number|null})=>void):Promise<'quiescent'|'unknown'>{
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null){diagnostic?.({reason:child?.pid?'root_already_exited':'root_unavailable',treeStopConfirmed:false,rootClosed:false,errorCode:null});return 'unknown';}
  let closed=false;const exit=new Promise<void>(resolve=>child.once('close',()=>{closed=true;resolve();}));
  let confirmed=false,errorCode:string|number|null=null;
  if(process.platform==='win32')confirmed=await new Promise<boolean>(resolve=>execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},error=>{errorCode=error?.code??null;resolve(!error);})).catch(()=>false);
  else{try{process.kill(-child.pid,'SIGKILL');confirmed=true;}catch(error){errorCode=(error as NodeJS.ErrnoException).code??null;try{child.kill('SIGKILL');}catch{diagnostic?.({reason:'tree_stop_failed',treeStopConfirmed:false,rootClosed:closed,errorCode});return 'unknown';}}}
  let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([exit,new Promise<void>(resolve=>{timer=setTimeout(resolve,6000);})]);clearTimeout(timer);
  diagnostic?.({reason:!confirmed?'tree_stop_failed':!closed?'root_close_timeout':'tree_stopped',treeStopConfirmed:confirmed,rootClosed:closed,errorCode});
  return confirmed&&closed?'quiescent':'unknown';
}

export function nativeQuestions(channel:ReturnType<typeof runtimeChannel>){
  const waiting=new Map<string,{resolve:(value:Record<string,any>)=>void;reject:(e:Error)=>void}>();
  function ask(kind:'question'|'approval',payload:Record<string,any>){
    if(kind==='question'){
      if(!Array.isArray(payload.questions)||!payload.questions.length||payload.questions.length>20||payload.questions.some(q=>!q||typeof q.question!=='string'||q.question.length>4000||payload.answerFormat==='codex'&&typeof q.id!=='string'))throw new Error('原生问题格式无效');
      payload={answerFormat:payload.answerFormat,questions:payload.questions.map(q=>({...(typeof q.id==='string'?{id:q.id}:{}),question:q.question,header:typeof q.header==='string'?q.header.slice(0,200):'',options:Array.isArray(q.options)?q.options.slice(0,30).map((o:any)=>({label:String(o.label??'').slice(0,300),description:String(o.description??'').slice(0,1000)})):[]}))};
    }
    const id=randomUUID();return new Promise<Record<string,any>>((resolve,reject)=>{waiting.set(id,{resolve,reject});channel.runtime('interaction.opened',{interactionId:id,kind,request:payload});});
  }
  async function answer(id:string,value:Record<string,any>){const pending=waiting.get(id);if(!pending)throw new Error('原生交互已失效');waiting.delete(id);pending.resolve(value);}
  function cancel(){for(const entry of waiting.values())entry.reject(new Error('运行已关闭'));waiting.clear();}
  return {ask,answer,cancel};
}
