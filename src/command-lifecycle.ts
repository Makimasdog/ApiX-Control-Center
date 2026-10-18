import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {resolve} from 'node:path';

const helper=fileURLToPath(new URL('../../src/windows-command.ps1',import.meta.url));
const powershell=process.env.SystemRoot?resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'):'powershell.exe';
export interface CommandIdentity {jobName:string;ownerPid?:number;ownerBirth?:string;pid?:number;birth?:string;observedMembers?:{pid:number;name:string}[]}
export interface CommandResult {operationId:string;startedAt:string;finishedAt:string;reason:string;exitCode:number|null;output:string;truncated:boolean;timedOut:boolean;aborted:boolean;unknown:boolean;processesEnded:boolean;sideEffectsNeedReview:boolean;executionComplete:boolean;identity:CommandIdentity;evidencePersisted?:boolean;error?:string}
export interface CommandHooks {operationId?:string;identity?(identity:CommandIdentity):void}
export function inspectCommandSync(identity:CommandIdentity):'ended'|'active'|'unknown'{
 if(process.platform!=='win32')return 'unknown';if(!identity.ownerPid)return 'ended';
 const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-JobName',identity.jobName,'-Inspect','-OwnerPid',String(identity.ownerPid),'-OwnerBirth',identity.ownerBirth??''],{windowsHide:true,timeout:6000,encoding:'utf8'});
 if(result.error||result.status!==0)return 'unknown';return result.stdout.includes('inspect|ended')?'ended':result.stdout.includes('inspect|active')?'active':'unknown';
}

export async function inspectCommand(identity:CommandIdentity,terminate=false):Promise<'ended'|'active'|'unknown'>{
 if(process.platform!=='win32')return 'unknown';
 if(!identity.ownerPid)return 'ended'; // No launch acknowledgement can be sent before its durable identity.
 return new Promise(resolve=>{
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-JobName',identity.jobName,'-Inspect','-OwnerPid',String(identity.ownerPid),'-OwnerBirth',identity.ownerBirth??''];if(terminate)args.push('-Terminate');
  const child=spawn(powershell,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let text='',done=false;
  const finish=(state:'ended'|'active'|'unknown')=>{if(done)return;done=true;clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();resolve(state);};
  const timer=setTimeout(()=>{try{child.kill();}catch{}finish('unknown');},5000);
  child.stdout.on('data',c=>{text=(text+c).slice(-2000);});child.stderr.resume();child.once('error',()=>finish('unknown'));child.once('close',()=>finish(text.includes('inspect|ended')?'ended':text.includes('inspect|active')?'active':'unknown'));
 });
}

export async function managedCommand(executable:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal,timeoutMs:number,onSpawn:(pid:number|undefined)=>void,secrets:string[],hooks:CommandHooks={}):Promise<CommandResult>{
 if(process.platform!=='win32')throw new Error('此平台尚无可确认的主 Agent 命令托管实现；未启动命令');
 const operationId=hooks.operationId??randomUUID(),identity:CommandIdentity={jobName:'Local\\ApiX-Command-'+operationId};
 const startedAt=new Date().toISOString();
 const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-JobName',identity.jobName],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const safe=(text:string)=>{for(const s of secrets)text=text.split(s).join('<redacted>');return text;};
 return new Promise(resolve=>{
  let reason='',exitCode:number|null=null,finished=false,launched=false,helperClosed=false,reportedEmpty=false,probe:Promise<void>|undefined,raw='',pending='',truncated=false,error='';
  const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};const limit=12000+Math.max(0,...secrets.map(s=>s.length));
  const output=(chunk:Buffer,channel:string)=>{raw+=decoders[channel==='stderr'?'stderr':'stdout'].write(chunk);if(raw.length>limit){truncated=true;raw=raw.slice(0,limit);}};
  const killHelper=()=>{try{child.kill();}catch(e){error=e instanceof Error?e.message:'终止监督进程失败';}};
  const finish=(processesEnded:boolean)=>{
   if(finished)return;finished=true;clearTimeout(startup);clearTimeout(deadline);clearTimeout(cleanup);signal.removeEventListener('abort',abort);
   child.stdout.removeAllListeners('data');child.stderr.removeAllListeners('data');child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
   raw+=decoders.stdout.end()+decoders.stderr.end();let text=safe(raw);if(text.length>12000)truncated=true;
   const executionComplete=reason==='exit'&&processesEnded&&exitCode!==null;
   resolve({operationId,startedAt,finishedAt:new Date().toISOString(),reason,exitCode,output:text.slice(0,12000),truncated,timedOut:reason==='timeout',aborted:reason==='aborted',unknown:!processesEnded,processesEnded,sideEffectsNeedReview:!executionComplete&&!(reason==='start_failed'&&!identity.pid),executionComplete,identity:{...identity},...(error?{error:safe(error).slice(0,1000)}:{})});
  };
  let startup:ReturnType<typeof setTimeout>,deadline:ReturnType<typeof setTimeout>|undefined,cleanup:ReturnType<typeof setTimeout>|undefined;
  const terminate=()=>{
   if(probe||finished)return;child.stdin.write('cancel\n',()=>{});
   if(!launched){killHelper();if(helperClosed)finish(true);return;}
   probe=(async()=>{const state=await inspectCommand(identity,true);if(state!=='ended')killHelper();finish(state==='ended');})();
  };
  const select=(why:string)=>{if(finished||reason)return;reason=why;clearTimeout(startup);clearTimeout(deadline);cleanup=setTimeout(()=>{killHelper();finish(!launched&&helperClosed);},6500);terminate();};
  const abort=()=>select('aborted');
  startup=setTimeout(()=>select('startup_timeout'),10000);signal.addEventListener('abort',abort,{once:true});
  child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{
   if(finished)return;pending+=chunk.toString('utf8');if(pending.length>200000){error='管理协议输出超限';select('protocol_error');return;}
   let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at).trim();pending=pending.slice(at+1);const [kind,a,b,c]=line.split('|');
    if(kind==='out'){output(Buffer.from(b??'','base64'),a??'stdout');continue;}
    if(kind==='member'){(identity.observedMembers??=[]).push({pid:Number(a),name:Buffer.from(b??'','base64').toString('utf8').slice(0,100)});identity.observedMembers=identity.observedMembers.slice(-20);continue;}
    if(kind==='job'){
     identity.ownerPid=Number(a);identity.ownerBirth=b;
     if(reason){terminate();continue;}
     try{onSpawn(identity.ownerPid);hooks.identity?.({...identity});}catch(e){error=e instanceof Error?e.message:'启动记录失败';select('record_failed');continue;}
     clearTimeout(startup);launched=true;child.stdin.write('go\n');deadline=setTimeout(()=>select('timeout'),timeoutMs+1000);
    }else if(kind==='started'){
     identity.pid=Number(a);identity.birth=b;try{hooks.identity?.({...identity});}catch(e){error=e instanceof Error?e.message:'身份记录失败';select('record_failed');}
    }else if(kind==='end'){
     if(reason)continue;reason=a??'protocol_error';exitCode=b!==''&&b!==undefined?Number(b):null;reportedEmpty=reason==='exit'&&Number(c)===1;
     clearTimeout(deadline);cleanup=setTimeout(()=>{killHelper();finish(false);},6500);
     if(reportedEmpty)child.stdin.end('release\n');else terminate();
    }else if(kind==='error'){error=Buffer.from(a??'','base64').toString('utf8');select(b==='worker'?'membership_unknown':'start_failed');}
   }
  });
  child.stderr.on('data',chunk=>{error=safe((error+chunk.toString('utf8')).slice(-2000));});
  child.on('error',e=>{if(finished)return;error=e.message;if(!reason)reason='start_failed';helperClosed=true;finish(!launched);});
  child.once('close',()=>{helperClosed=true;if(finished)return;if(reportedEmpty){finish(true);return;}if(!reason)reason='supervisor_lost';if(!launched)finish(true);else if(!probe){probe=(async()=>finish(await inspectCommand(identity)==='ended'))();}});
  child.stdin.write(JSON.stringify({executable,args,cwd,timeoutMs})+'\n');if(signal.aborted)abort();
 });
}
