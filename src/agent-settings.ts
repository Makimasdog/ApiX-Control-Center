import {spawn,execFile} from 'node:child_process';
import type {Command} from './runtime-adapters.js';

export function executionArgs(runtime:string,profile:{model:string;reasoningEffort?:string|null},difficulty:number|null|undefined,modelArgs:(runtime:string,model:string)=>string[]){
  const args=modelArgs(runtime,profile.model);
  if(profile.reasoningEffort){
    if(runtime!=='codex')throw new Error('推理强度参数目前仅支持 Codex');
    const effort=profile.reasoningEffort==='auto'?(difficulty==null?'medium':difficulty<=2?'low':difficulty<=3?'medium':'high'):profile.reasoningEffort;
    if(!['low','medium','high','xhigh'].includes(effort))throw new Error('推理强度参数无效');
    args.push('-c',`model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  return args;
}

// Read-only app-server requests: no inference turn, login, config write or token-file access.
export async function inspectCodex(command:Command,env:NodeJS.ProcessEnv,timeoutMs=12000){
  const child=spawn(command.executable,[...command.prefix,'app-server','--listen','stdio://'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');child.stderr.resume();
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();let id=0,buffer='',bytes=0,closed=false;
  const fail=(error:Error)=>{for(const p of pending.values())p.reject(error);pending.clear();};
  const kill=()=>{if(child.exitCode!==null||child.signalCode!==null)return;if(process.platform==='win32'&&child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:3000},()=>{});else child.kill('SIGKILL');};
  const timer=setTimeout(()=>{closed=true;fail(new Error('Codex 额度查询超时，请检查 CLI 登录和网络'));kill();},timeoutMs);
  child.on('error',()=>{closed=true;fail(new Error('无法启动 Codex，请检查 CLI 安装'));});
  child.on('close',()=>{closed=true;fail(new Error('Codex 查询进程已退出'));});
  child.stdin.on('error',()=>{closed=true;fail(new Error('Codex 查询连接已关闭'));});
  child.stdout.on('data',(chunk:string)=>{
    bytes+=Buffer.byteLength(chunk);if(bytes>2_000_000){closed=true;fail(new Error('Codex 查询响应过大'));kill();return;}
    buffer+=chunk;let index;
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const value=JSON.parse(line);const p=pending.get(value.id);if(p){pending.delete(value.id);if(value.error)p.reject(new Error('Codex 不支持此查询或当前登录无法提供数据'));else p.resolve(value.result);}}catch{/* CLI diagnostic line is not protocol data. */}}
  });
  const request=(method:string,params?:unknown)=>new Promise<any>((resolve,reject)=>{if(closed){reject(new Error('Codex 查询连接已关闭'));return;}const next=++id;pending.set(next,{resolve,reject});child.stdin.write(JSON.stringify({id:next,method,...(params===undefined?{}:{params})})+'\n');});
  try{
    await request('initialize',{clientInfo:{name:'apix_control_center',title:'ApiX',version:'0.1.0'},capabilities:{}});
    child.stdin.write('{"method":"initialized"}\n');
    const [limits,catalog]=await Promise.allSettled([request('account/rateLimits/read'),request('model/list',{limit:100})]);
    const quota=limits.status==='fulfilled'?normalizeQuota(limits.value):{state:'unknown',windows:[],message:limits.reason.message};
    const models=catalog.status==='fulfilled'&&Array.isArray(catalog.value?.data)?catalog.value.data.slice(0,100).map((m:any)=>({model:String(m.model??m.id??'').slice(0,200),name:String(m.displayName??m.model??'').slice(0,200),efforts:Array.isArray(m.supportedReasoningEfforts)?m.supportedReasoningEfforts.map((e:any)=>String(e.reasoningEffort)).filter((e:string)=>['none','minimal','low','medium','high','xhigh','max','ultra'].includes(e)):[]})):[];
    return {source:'codex-app-server',observedAt:new Date().toISOString(),quota,models,modelMessage:catalog.status==='rejected'?catalog.reason.message:null};
  }finally{clearTimeout(timer);child.stdin.end();kill();}
}

export function normalizeQuota(value:any){
  const buckets:[string,any][]=value?.rateLimitsByLimitId&&typeof value.rateLimitsByLimitId==='object'?Object.entries(value.rateLimitsByLimitId):value?.rateLimits?[['codex',value.rateLimits]]:[];
  const windows=buckets.flatMap(([id,bucket]:[string,any])=>['primary','secondary'].flatMap(key=>{
    const w=bucket?.[key];if(typeof w?.usedPercent!=='number'||!Number.isFinite(w.usedPercent))return [];
    return [{bucket:String(id).slice(0,100),window:key,remainingPercent:Math.max(0,Math.min(100,100-w.usedPercent)),windowDurationMins:typeof w.windowDurationMins==='number'?w.windowDurationMins:null,resetsAt:typeof w.resetsAt==='number'?w.resetsAt:null}];
  }));
  return {state:windows.length?'known':'unknown',windows,message:windows.length?null:'此登录未返回订阅额度；API Key 登录不能查询订阅额度'};
}
