/**
 * NPM 校验 - 在隔离环境中执行 npm 安装和检查脚本，验证项目依赖和构建的正确性
 *
 * 所属层级：校验层
 * 核心功能：
 *   - 在独立的工作区副本中执行 npm ci --ignore-scripts，避免影响宿主环境
 *   - 逐步运行 typecheck / build / test 检查脚本，每步后验证源码和依赖未被篡改
 *   - 资源监控：每 1.5 秒扫描工作区大小，超出预算自动中止
 *   - 完整的 TOCTOU 保护：执行前后校验任务状态、源项目指纹和契约有效性
 *   - 详细的事件记录：每个步骤的开始、结束和状态变化都写入 assistant_events 表
 * 依赖关系：
 *   - 依赖 → [→ 见 src/coordination/contracts.ts] Store 接口定义
 *   - 依赖 → [→ 见 src/assistant/assistant-verification.ts] 验证契约
 *   - 依赖 → [→ 见 src/projects/project-io.ts] 项目 IO 线程池
 *   - 依赖 → [→ 见 src/assistant/assistant-commands.ts] CommandSafetyError
 *   - 依赖 → [→ 见 src/assistant/assistant-result.ts] 运行结果摘要
 *   - 被 ← control-plane.mjs 调用，用于验证契约执行
 */
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {type Store} from '../coordination/contracts.js';
import {type VerificationContract,checkPassed} from '../assistant/assistant-verification.js';
import {projectIo} from '../projects/project-io.js';
import {CommandSafetyError} from '../assistant/assistant-commands.js';
import {hostResultSummary} from '../assistant/assistant-result.js';

/** 会话信息：包含会话 ID、项目 ID 和可选的任务 ID */
interface Session {id:string;project_id:string;task_id?:string|null}
/** 依赖注入接口：扩展 Store，提供目录管理、项目根路径查询和命令执行能力 */
interface Dependencies extends Store {directory:string;root(project:string):string;command(s:Session,args:Record<string,unknown>,signal:AbortSignal,context:{root:string;env:NodeJS.ProcessEnv}):Promise<unknown>}
// Owned copies are retained for diagnosis. No automatic deletion or resume/replay after restart.
/**
 * createNpmValidation - 创建 NPM 校验处理器
 * @param deps - 依赖注入对象（数据库、目录、命令执行器等）
 * @returns {run} run 方法用于执行一次完整的 NPM 校验流程
 */
export function createNpmValidation(deps:Dependencies){
 const {db,now}=deps;
 /** event - 将校验事件写入数据库 */
 function event(s:Session,kind:string,body:unknown){db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(s.id,kind,JSON.stringify(body),now());}
 /** preparing 串行化：确保同一时间只有一个工作区准备操作 */
 let preparing:Promise<unknown>=Promise.resolve();
 /**
  * run - 执行 NPM 校验（带信号传播）
  * @param s - 会话信息
  * @param c - 验证契约（包含 npm 配置、脚本序列等）
  * @param checkId - 要执行的检查 ID
  * @param parentSignal - 父级取消信号
  * @returns 校验结果
  */
 async function run(s:Session,c:VerificationContract,checkId:string,parentSignal:AbortSignal){
  // 创建子 AbortController，将父信号的取消传播到子信号
  const controller=new AbortController(),signal=controller.signal,abort=()=>controller.abort();parentSignal.addEventListener('abort',abort,{once:true});if(parentSignal.aborted)abort();
  try{return await runOwned(s,c,checkId,signal,controller);}finally{parentSignal.removeEventListener('abort',abort);}
 }
 /**
  * runOwned - 执行隔离的 NPM 校验流程
  *
  * 流程：准备工作区 → npm ci 安装 → 逐步执行检查脚本 → 收集产物 → 验证源项目未变化
  */
 async function runOwned(s:Session,c:VerificationContract,checkId:string,signal:AbortSignal,controller:AbortController){
  if(!c.npm)throw new Error('npm 配置已失效，请重新批准');
  const check=c.npm.scripts.find(e=>e.id===checkId);if(!check)throw new Error('npm 检查未批准');
  if(signal.aborted)throw new Error('验证已取消，未准备');
  // 串行化工作区准备：排队等待前一个准备完成后才开始
  const source=deps.root(s.project_id),job=preparing.then(()=>{if(signal.aborted)throw new Error('验证已取消，未准备');return projectIo('prepareNpmWorkspace',[deps.directory,source,c]);});preparing=job.then(()=>{},()=>{});
  const {manifest,fingerprint,owned,workspace}=await job;
  // 准备完成后进行 TOCTOU 校验
  if(signal.aborted||deps.root(s.project_id)!==source)throw new Error('验证准备期间任务已取消或项目路径变化');
  // 初始化运行记录对象
  const run:any={schemaVersion:1,taskId:s.task_id??null,sessionId:s.id,projectId:s.project_id,contractVersion:c.version,sourceFingerprint:fingerprint,source:{hash:manifest.hash,files:manifest.files.length,bytes:manifest.bytes},runtime:c.npm.runtime,installPolicy:c.npm.installPolicy,environmentPolicy:c.npm.environmentPolicy,network:c.npm.network,ownedDirectory:owned,checkId,startedAt:now(),status:'preparing',commands:[],artifacts:[]};
  event(s,'npm_validation_started',run);
  // 构建隔离的环境变量：清空用户配置，设置独立的 npm 配置和缓存目录
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','ComSpec','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  for(const name of ['tmp','home','cache'])mkdirSync(join(owned,name));
  const config=join(owned,'user.npmrc'),globalConfig=join(owned,'global.npmrc');writeFileSync(config,'');writeFileSync(globalConfig,'');
  Object.assign(env,{PATH:dirname(c.npm.runtime.node)+';'+join(process.env.SystemRoot??'C:\\Windows','System32'),TEMP:join(owned,'tmp'),TMP:join(owned,'tmp'),USERPROFILE:join(owned,'home'),HOME:join(owned,'home'),CI:'true',NPM_CONFIG_USERCONFIG:config,NPM_CONFIG_GLOBALCONFIG:globalConfig,NPM_CONFIG_CACHE:join(owned,'cache'),NPM_CONFIG_UPDATE_NOTIFIER:'false',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',NPM_CONFIG_IGNORE_SCRIPTS:'true'});
  /**
   * command - 在隔离环境中执行一条 npm 命令
   *
   * 内置资源监控：每 1.5 秒扫描工作区大小，超出预算自动中止。
   */
  const command=async(args:string[])=>{if(signal.aborted||deps.root(s.project_id)!==source)throw new Error('验证已取消');let resourceError='';
   let scanning=false,scan:Promise<void>=Promise.resolve();
   // 定时扫描工作区资源，防止依赖安装或检查脚本产生过多文件
   const guard=setInterval(()=>{if(scanning)return;scanning=true;scan=projectIo('treeEvidence',[owned,60000,384*1024*1024,true]).then(()=>{},e=>{resourceError=e instanceof Error?e.message:'验证资源超限';controller.abort();}).finally(()=>{scanning=false;});},1500);
   let result:Record<string,any>;try{result=await deps.command(s,{executable:c.npm!.runtime.node,args:[c.npm!.runtime.npm,...args],timeoutMs:120000},signal,{root:workspace,env}) as Record<string,any>;}finally{clearInterval(guard);await scan;}
   run.commands.push({...hostResultSummary(result),outputRef:result.outputRef,executable:c.npm!.runtime.node,args:[c.npm!.runtime.npm,...args],cwd:workspace});if(resourceError)throw new Error(resourceError);if(!checkPassed(result)||result.log?.complete!==true)throw new Error('准备或检查失败；请读取 command outputRef/operationId 的尾部日志');return result;};
  let actual:Record<string,any>|undefined;
  try{
   // 步骤 1：执行 npm ci 安装依赖
   actual=await command(c.npm.installArgs);
   const dependencies=await projectIo('npmDependencies',[workspace]);run.dependencies=dependencies;
   // 验证安装后源码未被篡改
   if((await projectIo('sourceManifest',[workspace,c.npm.artifacts])).hash!==manifest.hash)throw new Error('依赖准备改写源码或配置');
   run.preparation={strategy:'fresh-npm-ci',lockHash:manifest.files.find((f:{path:string;sha256:string})=>f.path==='package-lock.json')!.sha256,dependencyHash:dependencies.hash,installOperationId:actual.operationId,ignoreScripts:true};run.status='checking';event(s,'npm_validation_prepared',run);
   // 步骤 2：逐步执行检查脚本（typecheck / build / test）
   for(const invocation of check.commands){const script=invocation.name;event(s,'npm_validation_step',{taskId:s.task_id,checkId,script,status:script.includes('build')?'building':script.includes('test')?'testing':'checking'});actual=await command(invocation.npmArgs);if((await projectIo('sourceManifest',[workspace,c.npm.artifacts])).hash!==manifest.hash||(await projectIo('npmDependencies',[workspace])).hash!==dependencies.hash)throw new Error('检查改写源码、配置或依赖，原证据作废');}
   // 步骤 3：收集产物目录的证据
   run.artifacts=await Promise.all(c.npm.artifacts.map(async path=>({path,...await projectIo('treeEvidence',[join(workspace,path),6000,32*1024*1024]),fresh:true,owner:run.startedAt})));
   // 步骤 4：最终验证源项目指纹和契约仍然有效
   if((await projectIo('verificationFingerprint',[source,c]))!==fingerprint||!(await projectIo('contractCurrent',[source,c])))throw new Error('源项目在检查期间变化；结果只适用于副本，不能验收当前版本');
   run.status='passed';
  }catch(e){if(e instanceof CommandSafetyError)throw e;run.status=signal.aborted?'cancelled':run.commands.some((r:any)=>r.unknown||!r.processesEnded)?'unknown':run.preparation?'failed':'preparation_incomplete';run.error=e instanceof Error?e.message:'验证失败';}
  run.finishedAt=now();
  // Saving the summary is part of verification. A failed SQLite write never yields a trusted pass.
  event(s,'npm_validation_finished',run);
  const last=run.commands.at(-1)??actual;
  return {...last,exitCode:run.status==='passed'?0:last?.exitCode??null,unknown:run.status==='unknown'||last?.unknown===true,executionComplete:run.status==='passed'&&last?.executionComplete===true,passed:run.status==='passed',error:run.error,npmValidation:run};
 }
 return {run};
}
