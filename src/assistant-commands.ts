import {randomUUID,createHash} from 'node:crypto';
import {commandTool,preflightCommand,projectFingerprint} from './assistant-tools.js';
import {inspectCommandSync,type CommandIdentity,type CommandResult} from './command-lifecycle.js';
import {type Store,type Policy} from './contracts.js';

export class CommandSafetyError extends Error {readonly code='COMMAND_LIFECYCLE_UNKNOWN';constructor(message:string,readonly operationId?:string,readonly resource:'command_operation'|'file_operation'='command_operation'){super(message);}}
interface Session {id:string;project_id:string}
interface Dependencies extends Store {root(projectId:string):string;env():NodeJS.ProcessEnv;protectedValues():string[];policy(projectId:string):Policy}
export function createAssistantCommands(deps:Dependencies){
 const {db,row,rows,now}=deps,inFlight=new Set<string>(),blocked=new Set<string>();
 const safe=(error:unknown)=>{let text=error instanceof Error?error.message:'命令记录失败';for(const secret of [...deps.protectedValues(),...Object.entries({...process.env,...deps.env()}).filter(([key,value])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&value&&value.length>=6).map(([,value])=>value!)])if(secret)text=text.split(secret).join('<redacted>');return text.slice(0,1000);};
 const event=(id:string,kind:string,body:unknown)=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(id,kind,JSON.stringify(body),now());
 function pending(projectId:string){
  const events=rows<{id:number;session_id:string;kind:string;body:string}>("SELECT e.* FROM assistant_events e JOIN assistant_sessions s ON s.id=e.session_id WHERE s.project_id=? AND e.kind IN ('command_intent','command_identity','command_finished','resumed') ORDER BY e.id",projectId);
  const operations=new Map<string,{id:number;sessionId:string;identity:CommandIdentity;result?:CommandResult}>(),resumed=new Map<string,number>();
  for(const e of events){const body=JSON.parse(e.body);if(e.kind==='resumed'){resumed.set(e.session_id,e.id);continue;}if(e.kind==='command_intent')operations.set(body.operationId,{id:e.id,sessionId:e.session_id,identity:body.identity});else{const op=operations.get(body.operationId);if(op){op.id=e.id;if(e.kind==='command_identity')op.identity=body.identity;else op.result=body;}}}
  return [...operations.entries()].filter(([,op])=>!(op.result?.processesEnded&&!op.result.sideEffectsNeedReview&&op.result.evidencePersisted)&&((resumed.get(op.sessionId)??0)<=op.id));
 }
 function assertClear(s:Session,ownOnly=false){
  if(blocked.has(s.project_id)||pending(s.project_id).some(([,op])=>!ownOnly||op.sessionId===s.id))throw new Error('本项目有命令或副作用尚未核对；普通消息不会重放，请检查后恢复');
 }
 function recover(s:Session){
  for(const [id,op] of pending(s.project_id).filter(([,op])=>op.sessionId===s.id)){
   if(inFlight.has(id))throw new CommandSafetyError('命令仍在收尾，不能确认恢复',id);
   if(!op.result?.processesEnded&&inspectCommandSync(op.identity)!=='ended')throw new CommandSafetyError('受管进程仍活跃或身份/终止无法确认，不能放行冲突写入',id);
  }
  // A failed journal must be writable again before any explicit recovery can clear memory protection.
  event(s.id,'command_recovery_checked',{projectId:s.project_id});blocked.delete(s.project_id);
 }
 async function execute(s:Session,tool:string,args:Record<string,unknown>,signal:AbortSignal){
  if(signal.aborted)throw new Error('执行已停止');
  assertClear(s);const operationId=randomUUID(),root=deps.root(s.project_id),identity={jobName:'Local\\ApiX-Command-'+operationId};
  preflightCommand(root,args);
  const values=deps.protectedValues(),version=deps.policy(s.project_id).version;
  let before:string|null=null;if(tool==='verify')before=projectFingerprint(root);
  let intentId:number;
  try{intentId=Number(event(s.id,'command_intent',{operationId,projectId:s.project_id,sessionId:s.id,identity,commandHash:createHash('sha256').update(JSON.stringify(args)).digest('hex'),tool,startedAt:now()}).lastInsertRowid);}
  catch(error){blocked.add(s.project_id);throw new CommandSafetyError('执行意图未可靠保存，命令未启动：'+safe(error),operationId);}
  inFlight.add(operationId);
  try{
   const result=await commandTool(root,args,deps.env(),signal,()=>{},values,{operationId,identity:identity=>event(s.id,'command_identity',{operationId,projectId:s.project_id,identity})});
   if(deps.policy(s.project_id).version!==version){result.aborted=true;result.sideEffectsNeedReview=true;result.executionComplete=false;result.reason='permission_revoked';}
   const outputRef=randomUUID(),body=JSON.stringify(result);
   try{db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(outputRef,s.id,intentId,body,createHash('sha256').update(body).digest('hex'),now());result.evidencePersisted=true;event(s.id,'command_finished',{...result,outputRef,output:undefined});}
   catch(error){blocked.add(s.project_id);throw new CommandSafetyError('命令最终证据未可靠保存，不得宣称成功：'+safe(error),operationId);}
   if(result.sideEffectsNeedReview||result.unknown)try{event(s.id,'process_unknown',{resource:'command_operation',operationId,processesEnded:result.processesEnded,error:'命令异常或部分副作用待核对；不自动重放'});}catch(error){blocked.add(s.project_id);throw new CommandSafetyError('命令异常状态未可靠保存：'+safe(error),operationId);}
   if(before!==null&&before!==projectFingerprint(root)&&!result.sideEffectsNeedReview)throw new Error('验证命令修改了项目文件，请重新检查并验证');
   return {...result,outputRef,...(tool==='verify'?{fingerprint:projectFingerprint(root)}:{})};
  }catch(error){
   if(error instanceof CommandSafetyError)throw error;
   // Validation/startup failures must have a trustworthy terminal too; an absent terminal remains gated.
   if(!row("SELECT id FROM assistant_events WHERE session_id=? AND kind='command_finished' AND json_extract(body,'$.operationId')=?",s.id,operationId)){
    blocked.add(s.project_id);throw new CommandSafetyError('执行没有可靠终态，请核对：'+safe(error),operationId);
   }throw error;
  }finally{inFlight.delete(operationId);}
 }
 return {execute,assertClear,recover};
}
