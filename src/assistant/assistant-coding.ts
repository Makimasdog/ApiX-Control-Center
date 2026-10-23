import {PreflightError} from '../recovery/fault-policy.js';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {type Store} from '../coordination/contracts.js';
import {fileTool,projectPath,projectFingerprint} from './assistant-tools.js';
import {prepareEdit,commitEdit,sourceBuffer,fileSha,codingLimits,type PreparedEdit} from './coding-files.js';
import {CommandSafetyError} from './assistant-commands.js';

interface Session {id:string;project_id:string}
export function createAssistantCoding(store:Store,rootFor:(project:string)=>string){
 const {db,rows,now}=store,blocked=new Set<string>();
 const event=(s:Session,kind:string,body:unknown)=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(s.id,kind,JSON.stringify(body),now());
 function pending(s:Session,own=false){const events=rows<{session_id:string;kind:string;body:string;id:number}>("SELECT e.* FROM assistant_events e JOIN assistant_sessions s ON s.id=e.session_id WHERE s.project_id=? AND e.kind IN ('file_edit_intent','file_edit_result','resumed') ORDER BY e.id",s.project_id),map=new Map<string,{sessionId:string;id:number;body:Record<string,unknown>;done:boolean}>(),resumed=new Map<string,number>();for(const e of events){const body=JSON.parse(e.body);if(e.kind==='resumed')resumed.set(e.session_id,e.id);else if(e.kind==='file_edit_intent')map.set(body.operationId,{sessionId:e.session_id,id:e.id,body,done:false});else if(map.has(body.operationId))map.get(body.operationId)!.done=true;}return [...map.values()].filter(e=>!e.done&&(!own||e.sessionId===s.id)&&(resumed.get(e.sessionId)??0)<=e.id);}
 function assertClear(s:Session,own=false){if(blocked.has(s.project_id)||pending(s,own).length)throw new Error('本项目文件操作的副作用尚未核对，请检查后恢复');}
 function recover(s:Session){for(const op of pending(s,true)){const path=projectPath(rootFor(s.project_id),op.body.path,true);if(existsSync(path))sourceBuffer(path);}projectFingerprint(rootFor(s.project_id));event(s,'file_recovery_checked',{});blocked.delete(s.project_id);}
 function diff(s:Session,args:Record<string,unknown>){
  const page=rows<{id:number;body:string}>("SELECT id,body FROM assistant_events WHERE session_id=? AND kind='file_edit_result' AND id<? ORDER BY id DESC LIMIT 101",s.id,Number(args.beforeEventId??Number.MAX_SAFE_INTEGER));const records=page.slice(0,100).reverse().map(e=>JSON.parse(e.body)).filter(e=>args.path===undefined||e.path===args.path);
  const paths=[...new Set<string>(records.map(e=>e.path))];return {scope:'session_file_tools_only',excludes:'pre_existing_changes_and_command_edits',files:paths.map(path=>{const edits=records.filter(e=>e.path===path),last=edits.at(-1)!;let currentSha256:string|null=null;try{currentSha256=fileSha(sourceBuffer(projectPath(rootFor(s.project_id),path)));}catch{}return {path,beforeSha256:edits[0].beforeSha256,afterSha256:last.afterSha256,currentSha256,workspaceChangedSinceEdit:currentSha256!==last.afterSha256,edits};}),bounded:true,limit:100,historyComplete:page.length<=100,nextBeforeEventId:page.length>100?page[99]!.id:null};
 }
 function execute(s:Session,tool:string,args:Record<string,unknown>,signal:AbortSignal){
  if(signal.aborted)throw new Error('执行已停止');if(tool==='get_diff')return diff(s,args);
  const root=rootFor(s.project_id);if(!['edit_file','write_file'].includes(tool))return fileTool(root,tool,args);
  assertClear(s);let path:string,prepared:PreparedEdit|undefined,before:Buffer|null=null;
  try{path=projectPath(root,args.path,true);
  // All conflicts are determined before recording an intent or touching the file.
  if(tool==='edit_file'){prepared=prepareEdit(path,args);before=prepared.before;}
  else{if(typeof args.content!=='string'||args.content.includes('\0')||args.content.length>20000)throw new Error('写入内容无效或过大');if(existsSync(path))before=sourceBuffer(path,20000);}
  }catch(error){throw new PreflightError(error);}
  const operationId=randomUUID(),beforeSha256=before?fileSha(before):null,afterSha256=prepared?.afterSha256??fileSha(String(args.content));
  event(s,'file_edit_intent',{operationId,path:args.path,beforeSha256,plannedAfterSha256:afterSha256,tool});
  try{
   if(signal.aborted)throw new Error('执行已停止');let actual;
   if(prepared)actual=commitEdit(path,prepared);else{fileTool(root,tool,args);const text=String(args.content),diff=`-${(before?.toString('utf8')??'').replaceAll('\n','\n-')}\n+${text.replaceAll('\n','\n+')}`;actual={beforeSha256,afterSha256:fileSha(sourceBuffer(path,80000)),diff:diff.slice(0,codingLimits.diffCharacters),diffTruncated:diff.length>codingLimits.diffCharacters,added:text.split('\n').length,removed:before?before.toString('utf8').split('\n').length:0};}
   const result={operationId,path:args.path,...actual,recordedAt:now(),scope:'this_operation'};event(s,'file_edit_result',result);return result;
  }catch{blocked.add(s.project_id);throw new CommandSafetyError('文件写入或变更证据未确认，请核对实际文件后恢复；不会自动重放',operationId,'file_operation');}
 }
 return {execute,diff,assertClear,recover};
}
