/**
 * tool-dispatch.ts - executeInner 的工具路由
 *
 * 所属层级：助手层 - 工具执行
 * 核心功能：
 *   1. 按工具名分发到诊断、可信验收、记忆、上下文读取、工具发现、MCP 与通用执行
 *   2. 保持原有的审批、权限、日志、副作用记录、重试与验收证据边界
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 executeInner 调用
 *   - 调用 [→ 见 src/assistant/assistant-verification.ts] 判断检查是否通过
 *   - 调用 [→ 见 src/assistant/assistant-result.ts] 汇总宿主结果
 * 设计意图：只搬迁原有分支，不新增工具、不引入批量执行；审批、副作用与错误语义仍由 executeInner 负责。
 */
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import {object,type Policy} from '../coordination/contracts.js';
import {PreflightError,retryDelay} from '../recovery/fault-policy.js';
import {CommandSafetyError} from './assistant-commands.js';
import {hostResultSummary} from './assistant-result.js';
import {checkPassed,type VerificationContract} from './assistant-verification.js';
import type {AssistantSession} from './assistant-loop.js';
import type {ToolDefinition} from './tool-registry.js';

export interface ToolDispatchHost {
  policy(projectId:string):Policy;
  projectRoot?(projectId:string):string;
  npmCheck?(session:AssistantSession,contract:VerificationContract,checkId:string,signal:AbortSignal):Promise<unknown>;
  discoverTools?(projectId:string,signal:AbortSignal):Promise<{tools:ToolDefinition[];errors:string[]}>;
  callSkill?(session:AssistantSession,name:string,args:Record<string,unknown>,version:string,signal:AbortSignal):Promise<unknown>;
  callExternal?(session:AssistantSession,name:string,args:Record<string,unknown>,version:string,signal:AbortSignal):Promise<unknown>;
  execute(session:AssistantSession,tool:string,args:Record<string,unknown>,signal:AbortSignal,userApproved?:boolean):Promise<unknown>;
}

interface ToolDispatchContext {
  id:string;
  session:AssistantSession;
  tool:string;
  args:Record<string,unknown>;
  approved:boolean;
  definition:ToolDefinition;
  readonly:boolean;
  controller:AbortController;
  policy:Policy;
  deps:ToolDispatchHost;
  db:DatabaseSync;
  now():string;
  event(id:string,role:string,kind:string,body:unknown):{lastInsertRowid:number|bigint};
  update(id:string,status:string):void;
  getSession():AssistantSession;
  projectJob(projectId:string,operation:string,args:unknown[]):Promise<any>;
  currentFingerprint(projectId:string):Promise<string>;
  contract(session:AssistantSession):VerificationContract|null;
  assertSession(session:AssistantSession):void;
  catalog():ToolDefinition[];
  saving(id:string):boolean;
  outputs:{read(id:string,args:Record<string,unknown>):unknown};
  memory:{read(projectId:string,title:string,id?:string,taskId?:string,sessionId?:string):unknown};
  remember(projectId:string,title:unknown,content:unknown,source:string,kind:string,evidence:number|null):unknown;
  memoryEvidence:number|null;
  safeError(error:unknown):string;
  governanceCheck(projectId:string,definition:ToolDefinition,args:Record<string,unknown>):void;
}
/**
 * dispatchToolCall - 执行 executeInner 原有的工具分支
 * @param ctx - 会话、工具、已校验参数及主循环闭包能力
 * @returns 工具结果；错误继续抛给 executeInner 统一记录与分类
 */
export async function dispatchToolCall(ctx:ToolDispatchContext):Promise<unknown>{
  const {id,session:s,tool,args,controller,definition,deps}=ctx;
  if(tool==='diagnose_project'){if(!deps.projectRoot)throw new Error('项目路径不可用');return (await ctx.projectJob(s.project_id,'diagnoseNodeProject',[deps.projectRoot(s.project_id)]));}
  if(tool==='configure_verification'){
    if(!ctx.approved||!deps.projectRoot)throw new Error('需要用户批准及项目路径');
    const c=(await ctx.projectJob(s.project_id,'verificationContract',[deps.projectRoot(s.project_id),args]));ctx.assertSession(s);if(controller.signal.aborted||deps.policy(s.project_id).version!==ctx.policy.version)throw new Error('扫描期间执行授权已变化');ctx.event(id,'system','verification_contract',c);ctx.db.prepare('UPDATE assistant_sessions SET verification=NULL WHERE project_id=?').run(s.project_id);return c;
  }
  if(tool==='run_check'){
    const c=ctx.contract(s);if(!c||!deps.projectRoot||!(await ctx.projectJob(s.project_id,'contractCurrent',[deps.projectRoot(s.project_id),c])))throw new Error('没有有效可信验收契约，请请求用户批准');
    const check=c.checks.find(c=>c.id===args.checkId);if(!check)throw new Error('检查 ID 未获批准');
    const before=(await ctx.currentFingerprint(s.project_id)),runId=randomUUID(),startedAt=ctx.now();
    ctx.assertSession(s);if(controller.signal.aborted||deps.policy(s.project_id).version!==ctx.policy.version)throw new Error('扫描期间执行授权已变化');
    const base={sessionId:id,runId,checkId:check.id,checkContractVersion:c.version,source:c.source,executable:'node',args:check.args,timeoutMs:check.timeoutMs,startedAt,projectFingerprint:before};
    const started=ctx.event(id,'system','verification_evidence',{...base,passed:false,verificationStatus:'running'});
    let actual:Record<string,unknown>={exitCode:null,timedOut:false,aborted:false,unknown:true};
    try{actual=object(await (c.npm?(deps.npmCheck?deps.npmCheck(s,c,check.id,controller.signal):Promise.reject(new Error('npm 生产执行入口不可用'))):deps.execute(s,'run_command',{executable:'node',args:check.args,timeoutMs:check.timeoutMs},controller.signal,ctx.approved)));}
    catch(error){if((error as {code?:string})?.code==='COMMAND_LIFECYCLE_UNKNOWN')throw error;actual.error=ctx.safeError(error);}
    const outputRef=randomUUID(),body=JSON.stringify(actual);
    let same=false;try{same=before===(await ctx.currentFingerprint(s.project_id))&&ctx.contract(s)?.version===c.version&&(await ctx.projectJob(s.project_id,'contractCurrent',[deps.projectRoot(s.project_id),c]));}catch{}
    const passed=checkPassed(actual)&&same&&!controller.signal.aborted&&ctx.getSession().status==='running'&&deps.policy(s.project_id).version===ctx.policy.version;
    const result={...base,...hostResultSummary(actual),finishedAt:ctx.now(),exitCode:actual.exitCode??null,timedOut:actual.timedOut===true,aborted:actual.aborted===true||controller.signal.aborted,unknown:actual.unknown!==false,passed,outputRef,outputPreview:String(actual.output??actual.error??'').slice(-2000),truncated:actual.truncated===true,verificationStatus:actual.unknown!==false?'unknown':passed?'passed':'failed',codeAndContractUnchanged:same,...(actual.npmValidation?{npmValidation:actual.npmValidation}:{})};
    try{
      ctx.db.exec('SAVEPOINT assistant_check_evidence');
      ctx.db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(outputRef,id,Number(started.lastInsertRowid),body,createHash('sha256').update(body).digest('hex'),ctx.now());
      ctx.event(id,'system','verification_evidence',result);
      ctx.db.prepare('UPDATE assistant_sessions SET verification=? WHERE id=?').run(passed?before:null,id);
      ctx.db.exec('RELEASE assistant_check_evidence');
    }catch(error){try{ctx.db.exec('ROLLBACK TO assistant_check_evidence');ctx.db.exec('RELEASE assistant_check_evidence');}catch(rollbackError){console.error('验收证据回滚未确认：'+ctx.safeError(rollbackError));}throw new CommandSafetyError('可信检查最终证据未可靠保存：'+ctx.safeError(error),String(actual.operationId??''));}
    if(actual.timedOut||actual.aborted||actual.unknown!==false){ctx.event(id,'system','process_unknown',{error:'检查中断或进程结果未知，请检查后恢复；不自动重放',runId});if(ctx.getSession().status==='running')ctx.update(id,'attention');}
    return result;
  }
  if(tool==='remember')return ctx.remember(s.project_id,args.title,args.content,'agent',String(args.kind??'project'),ctx.memoryEvidence);
  if(tool==='read_memory')return ctx.memory.read(s.project_id,String(args.title??''),args.id?String(args.id):undefined,undefined,s.id);
  if(tool==='read_context')return ctx.outputs.read(id,args);
  if(tool==='search_tools'){
    // 标准模式的空查询保留外部发现语义；明确查询或节省模式才合并内置工具。
    const discovered=await deps.discoverTools?.(s.project_id,controller.signal)??{tools:[],errors:[]};const terms=String(args.query??'').toLowerCase().trim().split(/\s+/).filter(Boolean);const candidates=[...(ctx.saving(id)||terms.length?ctx.catalog().filter(t=>!t.name.startsWith('mcp_')):[]),...discovered.tools];const selected=candidates.map(t=>({tool:t,score:terms.reduce((n,word)=>n+(t.name.toLowerCase().includes(word)?4:0)+(t.description.toLowerCase().includes(word)?1:0),0)})).filter(t=>!terms.length||t.score>0).sort((a,b)=>b.score-a.score).slice(0,Number(args.limit??5)).map(t=>t.tool);
    for(const t of selected)ctx.db.prepare('INSERT INTO assistant_tool_discoveries VALUES (?,?,?) ON CONFLICT(session_id,name) DO UPDATE SET version=excluded.version').run(id,t.name,t.version??'');return {tools:selected,errors:discovered.errors};
  }
  if(tool.startsWith('skill_')){
    if(!deps.callSkill)throw new PreflightError('技能执行入口不可用');
    return await deps.callSkill(s,tool,args,definition.version!,controller.signal);
  }
  if(definition.name.startsWith('mcp_')){
    if(!deps.callExternal)throw new Error('MCP 执行入口不可用');return await deps.callExternal(s,tool,args,definition.version!,controller.signal);
  }
  for(let attempt=1;;attempt++){
    try{return await deps.execute(s,tool,args,controller.signal,ctx.approved);}
    catch(error){if(!ctx.readonly||tool.startsWith('mcp_')||attempt>=3||!['EBUSY','EAGAIN','ETIMEDOUT','EMFILE'].includes(String((error as NodeJS.ErrnoException).code))||controller.signal.aborted)throw error;
      const delayMs=retryDelay(attempt);ctx.event(id,'system','tool_retry',{content:'本地只读工具临时失败，退避后重试',tool,attempt:attempt+1,delayMs});await delay(delayMs,undefined,{signal:controller.signal});
      if(ctx.getSession().status!=='running'||deps.policy(s.project_id).version!==ctx.policy.version)throw new Error('权限或执行状态已变化');ctx.governanceCheck(s.project_id,definition,args);
    }
  }
}
