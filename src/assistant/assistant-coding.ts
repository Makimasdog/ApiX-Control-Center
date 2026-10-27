/**
 * 代码修改能力 (Coding) — 文件读写、代码生成与修改，包含意图记录和冲突检测
 *
 * 所属层级：助手层 - 代码编辑
 * 核心功能：
 *   1. execute — 统一分发文件工具调用（get_diff/edit_file/write_file/只读工具）
 *   2. diff — 分页查询会话内的文件编辑历史，对比当前工作区哈希
 *   3. assertClear — 检查项目是否有未核对的文件操作副作用
 *   4. recover — 恢复未完成的文件操作（核对实际文件状态）
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的工具执行流程调用
 *   - 调用 [→ 见 src/assistant/assistant-tools.ts] 的 fileTool/projectPath
 *   - 调用 [→ 见 src/assistant/coding-files.ts] 的 prepareEdit/commitEdit 等底层操作
 *   - 调用 [→ 见 src/projects/project-io.ts] 的 projectIo 隔离执行
 */
import {PreflightError} from '../recovery/fault-policy.js';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {type Store} from '../coordination/contracts.js';
import {fileTool,projectPath} from './assistant-tools.js';
import {prepareEdit,commitEdit,sourceBuffer,fileSha,codingLimits,type PreparedEdit} from './coding-files.js';
import {CommandSafetyError} from './assistant-commands.js';
import {projectIo} from '../projects/project-io.js';

/** 会话接口子集——编码模块只需 id 和 project_id */
interface Session {id:string;project_id:string}
/**
 * createAssistantCoding - 创建编码能力模块，封装文件编辑的意图记录、冲突检测和恢复
 * @param store - 数据库存储接口
 * @param rootFor - 根据项目 ID 获取项目根目录的函数
 * @returns 包含 execute/diff/assertClear/recover 方法的对象
 * 设计意图：每次文件编辑前先记录意图（file_edit_intent），编辑后记录结果（file_edit_result），
 * 形成完整的审计链。如果编辑失败，项目会被标记为 blocked，必须手动核对后恢复。
 */
export function createAssistantCoding(store:Store,rootFor:(project:string)=>string){
 const {db,rows,now}=store,blocked=new Set<string>();
 const event=(s:Session,kind:string,body:unknown)=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(s.id,kind,JSON.stringify(body),now());
 /**
  * pending - 查询项目中未完成的文件操作（有意图但无结果）
  * @param s - 当前会话
  * @param own - 是否只查询当前会话的操作（false 则查询整个项目）
  * @returns 未完成的操作列表
  */
 function pending(s:Session,own=false){const events=rows<{session_id:string;kind:string;body:string;id:number}>("SELECT e.* FROM assistant_events e JOIN assistant_sessions s ON s.id=e.session_id WHERE s.project_id=? AND e.kind IN ('file_edit_intent','file_edit_result','resumed') ORDER BY e.id",s.project_id),map=new Map<string,{sessionId:string;id:number;body:Record<string,unknown>;done:boolean}>(),resumed=new Map<string,number>();for(const e of events){const body=JSON.parse(e.body);if(e.kind==='resumed')resumed.set(e.session_id,e.id);else if(e.kind==='file_edit_intent')map.set(body.operationId,{sessionId:e.session_id,id:e.id,body,done:false});else if(map.has(body.operationId))map.get(body.operationId)!.done=true;}return [...map.values()].filter(e=>!e.done&&(!own||e.sessionId===s.id)&&(resumed.get(e.sessionId)??0)<=e.id);}
 /** assertClear - 检查项目是否有未核对的文件操作副作用，有则抛出错误 */
 function assertClear(s:Session,own=false){if(blocked.has(s.project_id)||pending(s,own).length)throw new Error('本项目文件操作的副作用尚未核对，请检查后恢复');}
 /** recover - 恢复未完成的文件操作，核对实际文件状态后解除 blocked 标记 */
 async function recover(s:Session){const root=rootFor(s.project_id);await projectIo('codingRecovery',[root,pending(s,true).map(op=>op.body.path)]);if(rootFor(s.project_id)!==root)throw new Error('检查期间项目路径已变化');event(s,'file_recovery_checked',{});blocked.delete(s.project_id);}
 /**
  * diff - 分页查询会话内的文件编辑历史
  * @param s - 当前会话
  * @param args - 包含 beforeEventId（分页游标）和 path（可选过滤）
  * @returns 包含文件列表、编辑记录、当前哈希对比的对象
  */
 async function diff(s:Session,args:Record<string,unknown>){
  const page=rows<{id:number;body:string}>("SELECT id,body FROM assistant_events WHERE session_id=? AND kind='file_edit_result' AND id<? ORDER BY id DESC LIMIT 101",s.id,Number(args.beforeEventId??Number.MAX_SAFE_INTEGER));const records=page.slice(0,100).reverse().map(e=>JSON.parse(e.body)).filter(e=>args.path===undefined||e.path===args.path);
  const paths=[...new Set<string>(records.map(e=>e.path))],root=rootFor(s.project_id),hashes:(string|null)[]=await projectIo('codingHashes',[root,paths]);if(rootFor(s.project_id)!==root)throw new Error('检查期间项目路径已变化');
  return {scope:'session_file_tools_only',excludes:'pre_existing_changes_and_command_edits',files:paths.map((path,index)=>{const edits=records.filter(e=>e.path===path),last=edits.at(-1)!,currentSha256=hashes[index]??null;return {path,beforeSha256:edits[0].beforeSha256,afterSha256:last.afterSha256,currentSha256,workspaceChangedSinceEdit:currentSha256!==last.afterSha256,edits};}),bounded:true,limit:100,historyComplete:page.length<=100,nextBeforeEventId:page.length>100?page[99]!.id:null};
 }
 /**
  * execute - 统一分发文件工具调用
  * @param s - 当前会话
  * @param tool - 工具名称（get_diff/edit_file/write_file/其他只读工具）
  * @param args - 工具参数
  * @param signal - 中断信号
  * @returns 工具执行结果
  * 设计意图：写操作（edit_file/write_file）必须先记录意图再执行，失败则标记项目为 blocked
  */
 function execute(s:Session,tool:string,args:Record<string,unknown>,signal:AbortSignal){
  if(signal.aborted)throw new Error('执行已停止');if(tool==='get_diff')return diff(s,args);
  const root=rootFor(s.project_id);if(!['edit_file','write_file'].includes(tool))return projectIo('readProjectTool',[root,tool,args]).then(result=>{if(signal.aborted||rootFor(s.project_id)!==root)throw new Error('文件检查期间执行已停止或项目路径变化');return result;});
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
