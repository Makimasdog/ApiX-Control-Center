import {createHash} from 'node:crypto';
import {object,text,type PlanStep} from './contracts.js';
import {taskProfile,overlaps} from './scheduling.js';

export interface CheckCommand {id:string;args:string[];timeoutMs:number}
export interface AutonomyPolicy {
  enabled:boolean;version:number;maxRepairs:number;maxMinutes:number;maxRunMinutes:number;
  checkpointMinutes:number;autoReassign:boolean;taskCapMinor:number|null;checks:CheckCommand[];
}
export interface ModuleContract {
  id:string;name:string;paths:string[];dependsOn:string[];risk:'low'|'medium'|'high';difficulty:number;
  workload:{inputTokens:number;outputTokens:number;calls:number};
  interfaces:{name:string;consumer:string;protocol:string;request:Record<string,unknown>;response:Record<string,unknown>}[];
  dataStructures:{name:string;schema:Record<string,unknown>}[];acceptance:string[];checkIds:string[];
}
export interface Architecture {version:1;summary:string;modules:ModuleContract[];digest:string}
export const autonomyDefaults:AutonomyPolicy={enabled:false,version:0,maxRepairs:2,maxMinutes:120,maxRunMinutes:30,checkpointMinutes:5,autoReassign:true,taskCapMinor:null,checks:[]};
function bounded(value:unknown,name:string,min:number,max:number){if(!Number.isSafeInteger(value) || Number(value)<min || Number(value)>max)throw new Error(`${name} 应为 ${min}–${max} 的整数`);return Number(value);}
function strings(value:unknown,name:string,max=30){if(!Array.isArray(value) || value.length>max)throw new Error(`${name} 数量无效`);const result=value.map(v=>text(v,1000));if(new Set(result).size!==result.length)throw new Error(`${name} 不得重复`);return result;}
export function parseAutonomyPolicy(input:Record<string,unknown>,version:number):AutonomyPolicy {
  if(typeof input.enabled!=='boolean' || typeof input.autoReassign!=='boolean')throw new Error('自主交付与自动改派必须为布尔值');
  if(!Array.isArray(input.checks) || input.checks.length>20)throw new Error('验收命令最多 20 项');
  const checks=input.checks.map(value=>{const c=object(value);const id=text(c.id,60);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('检查 ID 无效');
    // The host uses its Node executable directly: no shell interpolation or model-supplied commands.
    const args=strings(c.args,'Node 参数',30);if(!args.length || args[0]!.startsWith('-') || /^(?:[a-z]:|[\\/])/i.test(args[0]!) || args[0]!.includes('\\') || args[0]!.split('/').some(p=>p==='..'||p==='.'||!p) || !/\.(?:mjs|cjs|js)$/.test(args[0]!))throw new Error('验收入口应为项目内 Node 脚本的相对路径');
    return {id,args,timeoutMs:bounded(c.timeoutMs,'检查超时毫秒',100,600000)};});
  if(new Set(checks.map(c=>c.id)).size!==checks.length)throw new Error('检查 ID 不得重复');
  if(input.enabled && !checks.length)throw new Error('自主交付至少需要一项实际验收命令');
  return {enabled:input.enabled,version,maxRepairs:bounded(input.maxRepairs,'最多修复轮次',0,10),maxMinutes:bounded(input.maxMinutes,'目标最长分钟',1,1440),maxRunMinutes:bounded(input.maxRunMinutes,'员工最长运行分钟',1,240),checkpointMinutes:bounded(input.checkpointMinutes,'检查点分钟',1,60),autoReassign:input.autoReassign,taskCapMinor:input.taskCapMinor==null?null:bounded(input.taskCapMinor,'每次员工执行批准费用上界',0,1000000000),checks};
}
function schema(value:unknown){const result=object(value);if(!Object.keys(result).length || JSON.stringify(result).length>6000)throw new Error('接口/数据结构需要具体且有限的 schema');return result;}
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>JSON.stringify(key)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
export function parseArchitecture(value:unknown,checks:CheckCommand[]):Architecture {
  const a=object(value);if(!Array.isArray(a.modules) || !a.modules.length || a.modules.length>24)throw new Error('架构需要 1–24 个模块');
  const modules:ModuleContract[]=a.modules.map(value=>{const m=object(value);const id=text(m.id,60);if(!/^[a-z][a-z0-9_-]*$/.test(id) || id==='integration')throw new Error('模块 ID 无效');
    const profile=taskProfile({writePaths:m.paths,difficulty:m.difficulty,workload:m.workload});if(!profile.writePaths.length || !profile.workload || profile.difficulty==null)throw new Error('模块必须声明文件边界、难度与工作量');
    if(!['low','medium','high'].includes(String(m.risk)))throw new Error('模块风险无效');
    const acceptance=strings(m.acceptance,'模块验收条件');const checkIds=strings(m.checkIds,'模块检查 ID',20);if(!acceptance.length || !checkIds.length || checkIds.some(id=>!checks.some(c=>c.id===id)))throw new Error('模块必须引用已授权的实际检查');
    if(!Array.isArray(m.interfaces) || m.interfaces.length>20 || !Array.isArray(m.dataStructures) || m.dataStructures.length>20)throw new Error('接口/数据结构清单无效');
    const interfaces=m.interfaces.map(v=>{const i=object(v);return {name:text(i.name,200),consumer:text(i.consumer,60),protocol:text(i.protocol,200),request:schema(i.request),response:schema(i.response)};});
    const dataStructures=m.dataStructures.map(v=>{const d=object(v);return {name:text(d.name,200),schema:schema(d.schema)};});
    return {id,name:text(m.name,200),paths:profile.writePaths,dependsOn:strings(m.dependsOn,'模块依赖',24),risk:m.risk as ModuleContract['risk'],difficulty:profile.difficulty,workload:profile.workload,interfaces,dataStructures,acceptance,checkIds};});
  const ids=modules.map(m=>m.id);if(new Set(ids).size!==ids.length)throw new Error('模块 ID 不得重复');
  const shared=new Map<string,string>();for(const module of modules)for(const data of module.dataStructures){const signature=canonical(data.schema);if(shared.has(data.name)&&shared.get(data.name)!==signature)throw new Error(`共享数据结构 ${data.name} 在模块间不一致`);shared.set(data.name,signature);}
  const visited=new Set<string>();const visiting=new Set<string>();
  const visit=(id:string)=>{if(visiting.has(id))throw new Error('模块依赖存在循环');if(visited.has(id))return;const m=modules.find(m=>m.id===id);if(!m)throw new Error('模块依赖引用不存在的模块');visiting.add(id);m.dependsOn.forEach(visit);visiting.delete(id);visited.add(id);};ids.forEach(visit);
  for(let i=0;i<modules.length;i++){const m=modules[i]!;if(m.interfaces.some(i=>i.consumer!=='external' && (!ids.includes(i.consumer)||i.consumer===m.id)))throw new Error('接口消费者必须为其他模块或 external');for(let j=0;j<i;j++)if(overlaps(m.paths,modules[j]!.paths))throw new Error('模块文件边界重叠');}
  const body={version:1 as const,summary:text(a.summary,4000),modules};if(JSON.stringify(body).length>18000)throw new Error('统一契约超过员工上下文预算，请精简接口或拆分目标');return {...body,digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}
export function bindArchitecture(architecture:Architecture,steps:PlanStep[],cap:number|null):PlanStep[] {
  if(!steps.length || steps.length>31)throw new Error('自主计划需要 1–31 个实现步骤');
  const owners=new Map<string,number>();
  const bound=steps.map((step,index)=>{const module=architecture.modules.find(m=>m.id===step.moduleId);if(!module)throw new Error('实现步骤必须绑定冻结架构中的模块');if(owners.has(module.id))throw new Error('每个模块只能有一个实现负责人');owners.set(module.id,index);
    const profile=taskProfile(step.scheduling);if(profile.writePaths.length && profile.writePaths.some(p=>!module.paths.some(root=>p===root || p.startsWith(root+'/'))))throw new Error('步骤写入范围超出模块契约');
    return {...step,scheduling:taskProfile({...profile,contextTokens:Math.max(profile.contextTokens??0,module.workload.inputTokens+module.workload.outputTokens),writePaths:module.paths,difficulty:module.difficulty,workload:module.workload,estimateMinor:cap,fixedEmployeeId:null,estimates:[]})};});
  if(owners.size!==architecture.modules.length)throw new Error('计划未覆盖全部架构模块');
  for(const [index,step] of bound.entries()){const module=architecture.modules.find(m=>m.id===step.moduleId)!;for(const dep of module.dependsOn){const prior=owners.get(dep)!;if(prior>=index || !step.dependsOn.includes(prior))throw new Error('步骤必须遵守架构的前置模块依赖');}}
  const finalEmployee=bound[bound.length-1]!.employeeId;
  const integrationInput=architecture.modules.reduce((n,m)=>n+m.workload.inputTokens,0);
  bound.push({moduleId:'integration',employeeId:finalEmployee,dependsOn:bound.map((_,i)=>i),prompt:'接收全部已验收模块的冻结代码，按统一架构契约核对模块接口、数据结构和完整系统验收条件，完成必要集成及文档。仅处理已确认需求；执行所有已授权验收检查并提交实际证据。',scheduling:taskProfile({kind:'testing',writePaths:architecture.modules.flatMap(m=>m.paths),difficulty:Math.max(...architecture.modules.map(m=>m.difficulty)),contextTokens:integrationInput+2000,workload:{inputTokens:integrationInput,outputTokens:2000,calls:1},estimateMinor:cap})});
  return bound;
}
