/**
 * 验证流程 (Verification) — 可信验收契约的创建、校验和状态判定
 *
 * 所属层级：助手层 - 验收验证
 * 核心功能：
 *   1. verificationContract — 创建验收契约（包含检查命令、可修改范围、保护指纹）
 *   2. contractCurrent — 校验契约是否仍然有效（内容未被篡改）
 *   3. verificationFingerprint — 计算当前代码指纹用于变更检测
 *   4. checkPassed — 判断单次检查是否通过（exitCode=0、未超时、未中止、状态已知）
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 verificationState/executeInner 调用
 *   - 调用 [→ 见 src/assistant/assistant-tools.ts] 的 projectPath/projectFingerprint
 *   - 调用 [→ 见 src/validation/node-project.ts] 的 npmProfile/sourceManifest
 *   - 调用 [→ 见 src/coordination/architecture.ts] 的 parseAutonomyPolicy
 */
import {createHash} from 'node:crypto';
import {projectPath,projectFingerprint} from './assistant-tools.js';
import {parseAutonomyPolicy,autonomyDefaults,type CheckCommand} from '../coordination/architecture.js';
import {object} from '../coordination/contracts.js';
import {existsSync,realpathSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';
import {npmProfile,sourceManifest,type NpmProfile} from '../validation/node-project.js';

/**
 * VerificationContract — 验收契约接口，定义用户批准的检查命令和可修改范围
 * 设计意图：契约一旦创建即冻结，任何代码或脚本的变化都必须重新批准
 */
export interface VerificationContract {version:string;source:'user_approved';authorized:true;checks:CheckCommand[];writablePaths:string[];protectedFingerprint:string;runtime:{executable:string;nodeVersion:string};npm?:NpmProfile}
/**
 * verificationContract - 创建验收契约
 * @param root - 项目根目录
 * @param input - 用户提交的验收配置（检查命令/npm 配置/可修改范围）
 * @returns 包含检查命令、可修改路径、保护指纹和版本哈希的契约对象
 * 设计意图：验收脚本和配置文件必须位于可修改范围之外，防止助手修改测试来通过验收
 */
export function verificationContract(root:string,input:Record<string,unknown>):VerificationContract {
  const npm=input.npm?npmProfile(root,input.npm as Record<string,unknown>):undefined;
  const checks=npm?npm.scripts.map(s=>({id:s.id,args:[s.id],timeoutMs:120000})):parseAutonomyPolicy({...autonomyDefaults,enabled:true,checks:input.checks},1).checks;
  if(checks.some(c=>c.timeoutMs>120000||c.args.length>40||c.args.some(a=>a.length>2000)))throw new Error('检查参数超出命令执行器限制');
  if(!Array.isArray(input.writablePaths)||!input.writablePaths.length||input.writablePaths.length>40)throw new Error('必须明确批准 1–40 个可修改文件或目录');
  function canonical(path:string){const target=projectPath(root,path,true);let parent=target;while(!existsSync(parent))parent=dirname(parent);return relative(realpathSync.native(root),resolve(realpathSync.native(parent),relative(parent,target))).replaceAll('\\','/');}
  const writablePaths=input.writablePaths.map(p=>{if(typeof p!=='string'||!p||p.length>1000||p.includes('\\')||p.split('/').some(s=>!s||s==='.'||s==='..'))throw new Error('可修改范围必须为项目相对路径');return canonical(p);});
  const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
  for(const path of npm?['package.json','package-lock.json','vendor','test','tests','scripts',...npm.trustedPaths,...npm.artifacts]:checks.map(c=>c.args[0]!)){if(!npm)projectPath(root,path);const script=key(canonical(path));if(writablePaths.some(p=>script===key(p)||script.startsWith(key(p)+'/')||npm&&key(p).startsWith(script+'/')))throw new Error('验收脚本、配置、依赖及产物不得位于可修改范围');}
  // Freeze helpers/configuration/dependencies too, including normally hidden command output paths.
  // Fail closed at the existing scan limits rather than silently trusting an incomplete script closure.
  const body={source:'user_approved' as const,authorized:true as const,checks,writablePaths,protectedFingerprint:npm?sourceManifest(root,npm.artifacts,writablePaths).hash:projectFingerprint(root,writablePaths,true),runtime:{executable:process.execPath,nodeVersion:process.version},...(npm?{npm}:{})};
  return {...body,version:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}
/**
 * contractCurrent - 校验契约是否仍然有效（未被篡改）
 * @param root - 项目根目录
 * @param c - 待校验的契约
 * @returns true=契约有效（内容哈希匹配且重新生成后版本一致）
 */
export function contractCurrent(root:string,c:VerificationContract){return createHash('sha256').update(JSON.stringify({...c,version:undefined})).digest('hex')===c.version&&verificationContract(root,{...c}).version===c.version;}
/**
 * verificationFingerprint - 计算当前代码指纹
 * @param root - 项目根目录
 * @param c - 验收契约（可选，npm 项目用 sourceManifest，普通项目用 projectFingerprint）
 * @returns 十六进制 SHA256 字符串
 */
export function verificationFingerprint(root:string,c:VerificationContract|null){return c?.npm?sourceManifest(root,c.npm.artifacts).hash:projectFingerprint(root);}
/**
 * checkPassed - 判断单次检查是否通过
 * @param result - 检查执行结果
 * @returns true=通过（exitCode=0、未超时、未中止、状态已知、进程完整、无副作用待核对、证据已持久化）
 */
export function checkPassed(result:unknown){const r=object(result);return r.exitCode===0&&r.timedOut===false&&r.aborted===false&&r.unknown===false&&(!r.operationId||r.processesEnded===true&&r.executionComplete===true&&r.sideEffectsNeedReview===false&&r.evidencePersisted===true);}
