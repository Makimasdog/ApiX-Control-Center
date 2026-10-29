/**
 * 工具调用分发 (Tool Dispatch) — 接收 LLM 的工具调用请求，分发到具体工具执行
 *
 * 所属层级：助手层 - 工具执行
 * 核心功能：
 *   1. 项目路径安全检查——防止访问项目外文件或凭据文件
 *   2. 项目指纹计算——生成工作区的 SHA256 摘要用于变更检测
 *   3. 文件工具分发——处理 read_file/write_file/edit_file/list_files/search_files/load_skill
 *   4. 命令工具分发——处理 run_command/verify，包含参数校验和安全执行
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 executeInner 调用
 *   - 被 [→ 见 src/assistant/assistant-verification.ts] 调用 projectPath/projectFingerprint
 *   - 被 [→ 见 src/assistant/assistant-coding.ts] 调用 fileTool/projectPath
 *   - 调用 [→ 见 src/assistant/coding-files.ts] 的底层文件读写
 *   - 调用 [→ 见 src/execution/command-lifecycle.ts] 的 managedCommand 执行命令
 */
import {loadInstructions,type InstructionOptions} from './instruction-memory.js';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {managedCommand,type CommandHooks} from '../execution/command-lifecycle.js';
import {object,text} from '../coordination/contracts.js';
import {commandCapabilities} from '../execution/command-capabilities.js';
import {readSource,sourceBuffer,fileSha,prepareEdit,commitEdit,searchSource} from './coding-files.js';
import {projectScanLimits,scanProjectFile} from '../infrastructure/project-scan.js';

/** excluded - 判断文件名是否属于排除列表（凭据、node_modules、.git、临时文件等） */
const excluded=(name:string)=>['.npmrc','model-credentials.json','owner-access.json'].includes(name.toLowerCase())||name==='node_modules'||name==='.git'||name.startsWith('.tmp')||/^\.env(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key|pfx|p12)$/i.test(name);
/** within - 检查目标路径是否在项目根目录内，防止路径穿越攻击 */
function within(root:string,path:string){const rel=relative(root,path);return rel!== '..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel);}
/**
 * projectPath - 解析并校验项目内文件路径的安全性
 * @param root - 项目根目录
 * @param input - 用户输入的路径
 * @param write - 是否为写入操作（写入时允许文件不存在）
 * @returns 解析后的绝对路径
 * 设计意图：多重安全检查——禁止绝对路径、禁止凭据文件、禁止符号链接穿越、禁止目录穿越
 */
export function projectPath(root:string,input:unknown,write=false):string {
  root=realpathSync.native(root);const name=text(input,1000);
  if(isAbsolute(name)||name.includes('\0')||name.includes(':')||name.split(/[\\/]/).some(excluded))throw new Error('路径不能访问项目外或凭据文件');
  const target=resolve(root,name);if(!within(root,target))throw new Error('路径越过项目边界');
  let parent=target;while(!existsSync(parent)){const next=dirname(parent);if(next===parent)throw new Error('路径不存在');parent=next;}
  if(!within(root,realpathSync.native(parent)))throw new Error('链接越过项目边界');
  if(relative(root,realpathSync.native(parent)).split(/[\\/]/).some(excluded))throw new Error('实际路径包含凭据文件');
  if(!write&&!existsSync(target))throw new Error('文件不存在');return target;
}
/**
 * projectFingerprint - 计算项目工作区的 SHA256 指纹，用于检测代码变更
 * @param root - 项目根目录
 * @param mutablePaths - 可修改路径列表（这些路径的变化不计入指纹）
 * @param protectChecks - 是否保护验收脚本（为 true 时只扫描 .git 目录）
 * @returns 十六进制 SHA256 字符串
 * 设计意图：每次工具执行前后对比指纹，判断代码是否被外部修改
 */
export function projectFingerprint(root:string,mutablePaths:string[]=[],protectChecks=false):string {
  root=realpathSync.native(root);const hash=createHash('sha256');let count=0,bytes=0;
  function visit(dir:string){for(const name of readdirSync(dir).sort()){
    if(protectChecks?name==='.git':excluded(name))continue;const path=join(dir,name),stat=lstatSync(path);if(++count>projectScanLimits.items)throw new Error('项目超过 20000 项完整扫描范围，请缩小工作区');
    if(stat.isSymbolicLink())throw new Error('验证范围包含链接，请使用可核对的工作区');
    const rel=relative(root,path).replaceAll('\\','/');
    const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
    if(mutablePaths.some(p=>key(rel)===key(p)||key(rel).startsWith(key(p)+'/')))continue;
    if(!protectChecks)hash.update(JSON.stringify([relative(root,path),stat.isDirectory(),stat.size]));
    if(stat.isDirectory()){visit(path);}else if(stat.isFile()){if(protectChecks)hash.update(JSON.stringify([rel,stat.size]));if((bytes+=stat.size)>projectScanLimits.bytes)throw new Error('项目超过 256 MiB 完整扫描范围，请缩小工作区');hash.update(scanProjectFile(path,stat).sha256);}else throw new Error('扫描不支持此文件类型');
  }}visit(root);return hash.digest('hex');
}
/** projectInstructions - 加载项目指令文件（AGENTS.md 等） [→ 见 src/assistant/instruction-memory.ts] */
export function projectInstructions(root:string,options:InstructionOptions={}){return loadInstructions(root,options);}
/**
 * skillsFor - 发现项目内所有可用的 Skill（技能包）
 * @param root - 项目根目录
 * @returns Skill 列表，每项包含 id/name/path/root
 * 设计意图：扫描多个约定目录（.apix/skills、.claude/skills 等）发现可用技能
 */
export function skillsFor(root:string){
  const result:{id:string;name:string;path:string;root:string}[]=[];
  for(const base of [join(root,'.apix','skills'),join(root,'.claude','skills'),join(root,'.agents','skills'),join(homedir(),'.apix','skills')]){
    if(!existsSync(base)||!lstatSync(base).isDirectory()||lstatSync(base).isSymbolicLink())continue;
    if(base!==join(homedir(),'.apix','skills')&&!within(realpathSync.native(root),realpathSync.native(base)))continue;
    for(const name of readdirSync(base).slice(0,50)){
      if(!/^[a-zA-Z0-9_-]{1,64}$/.test(name))continue;const path=join(base,name,'SKILL.md');
      if(existsSync(path)&&within(realpathSync.native(base),realpathSync.native(path)))result.push({id:createHash('sha256').update(path).digest('hex').slice(0,16),name,path,root:base});
    }
  }return result;
}
/**
 * fileTool - 文件工具分发器，根据工具名称路由到具体的文件操作
 * @param root - 项目根目录
 * @param tool - 工具名称（search_files/read_file/write_file/edit_file/list_files/load_skill）
 * @param input - 工具参数
 * @returns 工具执行结果
 */
export function fileTool(root:string,tool:string,input:unknown){
  const args=object(input);
  if(tool==='search_files')return searchSource(realpathSync.native(root),args,path=>projectPath(root,path));
  if(tool==='edit_file'){const path=projectPath(root,args.path);return {path:args.path,...commitEdit(path,prepareEdit(path,args))};}
  if(tool==='list_files'){
    const path=projectPath(root,args.path??'.');const entries=readdirSync(path,{withFileTypes:true}).filter(e=>!excluded(e.name));
    return {entries:entries.slice(0,200).map(e=>({name:e.name,directory:e.isDirectory(),link:e.isSymbolicLink()})),truncated:entries.length>200};
  }
  if(tool==='load_skill'){
    const skill=skillsFor(root).find(s=>s.id===args.id);if(!skill)throw new Error('Skill 不存在');
    if(lstatSync(realpathSync.native(skill.path)).size>16000)throw new Error('Skill 超过完整加载预算');
    return {name:skill.name,content:readFileSync(skill.path,'utf8'),authority:'context_only'};
  }
  const path=projectPath(root,args.path,tool==='write_file');
  if(tool==='read_file'){
    if(args.startLine!==undefined||args.endLine!==undefined||args.cursor!==undefined||args.maxBytes!==undefined)return {path:args.path,...readSource(path,args)};
    if(lstatSync(realpathSync.native(path)).size>20000)throw new Error('文件超过完整读取预算，请用 startLine/endLine 或游标按范围读取');const data=sourceBuffer(path,20000);return {path:args.path,content:data.toString('utf8'),sha256:fileSha(data),startLine:1,endLine:data.toString('utf8').split('\n').length,bytesReturned:data.length,byteBudget:20000,hasMore:false,nextCursor:null};
  }
  if(tool==='write_file'){
    if(typeof args.content!=='string'||args.content.length>20000||path===realpathSync.native(root))throw new Error('写入内容无效或过大');
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,args.content);return {path:args.path,bytes:Buffer.byteLength(args.content)};
  }
  throw new Error('未知文件工具');
}
/**
 * preflightCommand - 命令执行前的参数校验和安全检查
 * @param root - 项目根目录
 * @param input - 命令参数（executable/args/timeoutMs）
 * @param platform - 操作系统平台（默认 process.platform）
 * @returns 校验后的命令配置（可执行文件路径、参数、工作目录、超时）
 */
export function preflightCommand(root:string,input:unknown,platform=process.platform){
  const args=object(input);const executable=text(args.executable,1000);
  if(args.args===undefined)args.args=[];
  if(!Array.isArray(args.args)||args.args.length>40||args.args.some(a=>typeof a!=='string'||a.length>2000||a.includes('\0')))throw new Error('命令参数无效');
  const timeout=Number(args.timeoutMs??30000);if(!Number.isSafeInteger(timeout)||timeout<100||timeout>120000)throw new Error('命令超时应为 100–120000 毫秒');
  if(!commandCapabilities(platform).managedCommands.available)throw new Error(commandCapabilities(platform).managedCommands.reason!);
  return {executable:executable==='node'?process.execPath:executable,args:args.args as string[],cwd:realpathSync.native(root),timeout};
}
/**
 * commandTool - 执行外部命令（run_command/verify），包含密钥脱敏和生命周期管理
 * @param root - 项目根目录
 * @param input - 命令参数
 * @param env - 环境变量
 * @param signal - 中断信号
 * @param onSpawn - 进程启动回调（用于记录 PID）
 * @param protectedValues - 额外的受保护值（会加入密钥脱敏列表）
 * @param hooks - 命令生命周期钩子
 * @returns 命令执行结果
 */
export async function commandTool(root:string,input:unknown,env:NodeJS.ProcessEnv,signal:AbortSignal,onSpawn:(pid:number|undefined)=>void=()=>{},protectedValues:string[]=[],hooks:CommandHooks={}){
  if(signal.aborted)throw new Error('执行已停止');const command=preflightCommand(root,input);
  const secrets=[...new Set([...protectedValues.filter(v=>!!v),...Object.entries({...process.env,...env}).filter(([key,value])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&value&&value.length>=6).map(([,value])=>value!)])];
  return managedCommand(command.executable,command.args,command.cwd,env,signal,command.timeout,onSpawn,secrets,hooks);
}
