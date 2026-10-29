/**
 * 架构契约解析 - 模块合同、验收命令、自主交付策略、JSON Schema 验证
 *
 * 所属层级：协调层 - 领域服务（第3层）
 * 核心功能：
 *   1. parseAutonomyPolicy() - 解析自主交付策略（修复次数、时间上限、验收命令等）
 *   2. parseArchitecture() - 解析架构契约（模块边界、接口、依赖、验收条件）
 *   3. bindArchitecture() - 将架构绑定到计划步骤（每模块一个实现步骤 + 最终集成步骤）
 * 依赖关系：
 *   - 依赖 contracts.ts 的 object/text 工具函数和 PlanStep 类型
 *   - 依赖 scheduling.ts 的 taskProfile/overlaps 函数
 *   - 被 apix-agent.ts 和 autonomy.ts 调用
 * 设计意图：架构契约是自主交付模式的冻结合同——
 *   所有员工必须遵守模块边界，禁止自行扩大范围。
 */
import {createHash} from 'node:crypto';
import {object,text,type PlanStep} from './contracts.js';
import {taskProfile,overlaps} from './scheduling.js';
import {Ajv} from 'ajv';
import {Ajv2020} from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

/** 验收命令：检查 ID、Node.js 参数、超时时间 */
export interface CheckCommand {id:string;args:string[];timeoutMs:number}
/** 自主交付策略：控制自动修复、时间上限、验收检查等 */
export interface AutonomyPolicy {
  enabled: boolean;         // 是否启用自主交付
  version: number;          // 策略版本号（乐观锁）
  maxRepairs: number;       // 最大修复轮次
  maxMinutes: number;       // 目标最长执行时间（分钟）
  maxRunMinutes: number;    // 单次员工最长运行时间（分钟）
  checkpointMinutes: number; // 检查点间隔（分钟）
  autoReassign: boolean;    // 是否允许自动改派
  taskCapMinor: number | null; // 每次员工执行的费用上界
  checks: CheckCommand[];   // 验收命令列表
}
/** 模块合同：定义一个架构模块的边界、依赖、接口和验收条件 */
export interface ModuleContract {
  id: string;               // 模块唯一标识（小写字母开头）
  name: string;             // 模块显示名称
  paths: string[];          // 文件边界（项目内相对路径，互不重叠）
  dependsOn: string[];      // 依赖的其他模块 ID
  risk: 'low' | 'medium' | 'high'; // 风险等级
  difficulty: number;       // 推理难度（1-5）
  workload: {inputTokens:number;outputTokens:number;calls:number}; // 工作量估算
  interfaces: {name:string;consumer:string;protocol:string;request:Record<string,unknown>;response:Record<string,unknown>}[]; // 接口定义
  dataStructures: {name:string;schema:Record<string,unknown>}[]; // 数据结构定义
  acceptance: string[];     // 验收条件列表
  checkIds: string[];       // 引用的验收命令 ID
}
/** 架构契约：模块列表 + 摘要 + 摘要哈希 */
export interface Architecture {version:1;summary:string;modules:ModuleContract[];digest:string}
/** 自主交付策略默认值（禁用状态） */
export const autonomyDefaults:AutonomyPolicy={enabled:false,version:0,maxRepairs:2,maxMinutes:120,maxRunMinutes:30,checkpointMinutes:5,autoReassign:true,taskCapMinor:null,checks:[]};

/** 校验值在指定范围内的整数 */
function bounded(value:unknown,name:string,min:number,max:number){if(!Number.isSafeInteger(value) || Number(value)<min || Number(value)>max)throw new Error(`${name} 应为 ${min}–${max} 的整数`);return Number(value);}
/** 校验值为字符串数组且无重复 */
function strings(value:unknown,name:string,max=30){if(!Array.isArray(value) || value.length>max)throw new Error(`${name} 数量无效`);const result=value.map(v=>text(v,1000));if(new Set(result).size!==result.length)throw new Error(`${name} 不得重复`);return result;}

/**
 * parseAutonomyPolicy - 解析并校验自主交付策略
 * @param input - 原始策略对象（来自 LLM 或用户配置）
 * @param version - 当前策略版本号
 * @returns 校验后的 AutonomyPolicy
 * 设计意图：严格校验验收命令的安全性——
 *   只允许项目内的 Node.js 脚本，防止路径穿越和命令注入。
 */
export function parseAutonomyPolicy(input:Record<string,unknown>,version:number):AutonomyPolicy {
  if(typeof input.enabled!=='boolean' || typeof input.autoReassign!=='boolean')throw new Error('自主交付与自动改派必须为布尔值');
  if(!Array.isArray(input.checks) || input.checks.length>20)throw new Error('验收命令最多 20 项');
  const checks=input.checks.map(value=>{const c=object(value);const id=text(c.id,60);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('检查 ID 无效');
    // 宿主直接使用 Node 可执行文件：不经过 shell 解释，模型提供的命令不可直接执行
    const args=strings(c.args,'Node 参数',30);if(!args.length || args[0]!.startsWith('-') || /^(?:[a-z]:|[\\/])/i.test(args[0]!) || args[0]!.includes('\\') || args[0]!.split('/').some(p=>p==='..'||p==='.'||!p) || !/\.(?:mjs|cjs|js)$/.test(args[0]!))throw new Error('验收入口应为项目内 Node 脚本的相对路径');
    return {id,args,timeoutMs:bounded(c.timeoutMs,'检查超时毫秒',100,600000)};});
  if(new Set(checks.map(c=>c.id)).size!==checks.length)throw new Error('检查 ID 不得重复');
  if(input.enabled && !checks.length)throw new Error('自主交付至少需要一项实际验收命令');
  return {enabled:input.enabled,version,maxRepairs:bounded(input.maxRepairs,'最多修复轮次',0,10),maxMinutes:bounded(input.maxMinutes,'目标最长分钟',1,1440),maxRunMinutes:bounded(input.maxRunMinutes,'员工最长运行分钟',1,240),checkpointMinutes:bounded(input.checkpointMinutes,'检查点分钟',1,60),autoReassign:input.autoReassign,taskCapMinor:input.taskCapMinor==null?null:bounded(input.taskCapMinor,'每次员工执行批准费用上界',0,1000000000),checks};
}

/** JSON Schema 验证器缓存（支持 draft-07 和 2020-12） */
const schemaValidators={
  'http://json-schema.org/draft-07/schema#':new Ajv({strictTypes:false,strictTuples:false,strictRequired:false,allowUnionTypes:true,addUsedSchema:false}),
  'https://json-schema.org/draft/2020-12/schema':new Ajv2020({strictTypes:false,strictTuples:false,strictRequired:false,allowUnionTypes:true,addUsedSchema:false})
};
for(const validator of Object.values(schemaValidators))formatsModule.default(validator);

/**
 * schema - 校验并编译 JSON Schema（用于接口/数据结构定义）
 * @param value - 待校验的 Schema 对象
 * @returns 校验通过的 Schema 对象
 * 设计意图：不累积模型生成的 Schema，用完即清理缓存。
 */
function schema(value:unknown){
  const result=object(value);if(!Object.keys(result).length || JSON.stringify(result).length>6000)throw new Error('接口/数据结构需要具体且有限的 schema');
  const dialect=result.$schema??'https://json-schema.org/draft/2020-12/schema';
  if(typeof dialect!=='string'||!Object.hasOwn(schemaValidators,dialect))throw new Error('schema 仅支持 JSON Schema draft-07 或 2020-12');const validator=schemaValidators[dialect as keyof typeof schemaValidators];
  try{validator.compile(result);}catch(error){throw new Error(`接口/数据结构 schema 无效：${String(error instanceof Error?error.message:error).slice(0,1500)}`);}
  // 不累积模型生成的 schema，防止跨模块缓存污染
  finally{validator.removeSchema(result);}
  return result;
}

/** 将值转换为规范化的 JSON 字符串（键排序，用于比较 Schema 等价性） */
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>JSON.stringify(key)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}

/**
 * parseArchitecture - 解析并校验架构契约
 * @param value - 原始架构对象（来自 LLM 输出）
 * @param checks - 已授权的验收命令列表
 * @returns 校验后的 Architecture 对象（含摘要哈希）
 * 设计意图：严格校验模块边界不重叠、依赖无环、接口 Schema 有效；
 *   最终生成 SHA-256 摘要作为冻结合同的唯一标识。
 */
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
  // 校验共享数据结构在模块间的一致性
  const shared=new Map<string,string>();for(const module of modules)for(const data of module.dataStructures){const signature=canonical(data.schema);if(shared.has(data.name)&&shared.get(data.name)!==signature)throw new Error(`共享数据结构 ${data.name} 在模块间不一致`);shared.set(data.name,signature);}
  // 校验模块依赖无环（DFS 拓扑排序）
  const visited=new Set<string>();const visiting=new Set<string>();
  const visit=(id:string)=>{if(visiting.has(id))throw new Error('模块依赖存在循环');if(visited.has(id))return;const m=modules.find(m=>m.id===id);if(!m)throw new Error('模块依赖引用不存在的模块');visiting.add(id);m.dependsOn.forEach(visit);visiting.delete(id);visited.add(id);};ids.forEach(visit);
  // 校验接口消费者合法性 + 文件边界不重叠
  for(let i=0;i<modules.length;i++){const m=modules[i]!;if(m.interfaces.some(i=>i.consumer!=='external' && (!ids.includes(i.consumer)||i.consumer===m.id)))throw new Error('接口消费者必须为其他模块或 external');for(let j=0;j<i;j++)if(overlaps(m.paths,modules[j]!.paths))throw new Error('模块文件边界重叠');}
  const body={version:1 as const,summary:text(a.summary,4000),modules};if(JSON.stringify(body).length>18000)throw new Error('统一契约超过员工上下文预算，请精简接口或拆分目标');return {...body,digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}

/**
 * bindArchitecture - 将架构契约绑定到计划步骤
 * @param architecture - 冻结的架构契约
 * @param steps - 计划步骤列表
 * @param cap - 费用上界
 * @returns 绑定后的步骤列表（含最终集成步骤）
 * 设计意图：每个模块恰好一个实现步骤，按依赖拓扑排序；
 *   最后自动添加一个集成步骤，覆盖全部模块。
 */
export function bindArchitecture(architecture:Architecture,steps:PlanStep[],cap:number|null):PlanStep[] {
  if(!steps.length || steps.length>31)throw new Error('自主计划需要 1–31 个实现步骤');
  const owners=new Map<string,number>(); // 模块 ID → 步骤索引（确保每模块一个负责人）
  const bound=steps.map((step,index)=>{const module=architecture.modules.find(m=>m.id===step.moduleId);if(!module)throw new Error('实现步骤必须绑定冻结架构中的模块');if(owners.has(module.id))throw new Error('每个模块只能有一个实现负责人');owners.set(module.id,index);
    const profile=taskProfile(step.scheduling);if(profile.writePaths.length && profile.writePaths.some(p=>!module.paths.some(root=>p===root || p.startsWith(root+'/'))))throw new Error('步骤写入范围超出模块契约');
    return {...step,scheduling:taskProfile({...profile,contextTokens:Math.max(profile.contextTokens??0,module.workload.inputTokens+module.workload.outputTokens),writePaths:module.paths,difficulty:module.difficulty,workload:module.workload,estimateMinor:cap,fixedEmployeeId:null,estimates:[]})};});
  if(owners.size!==architecture.modules.length)throw new Error('计划未覆盖全部架构模块');
  // 校验步骤依赖遵守架构的模块依赖拓扑
  for(const [index,step] of bound.entries()){const module=architecture.modules.find(m=>m.id===step.moduleId)!;for(const dep of module.dependsOn){const prior=owners.get(dep)!;if(prior>=index || !step.dependsOn.includes(prior))throw new Error('步骤必须遵守架构的前置模块依赖');}}
  // 自动添加最终集成步骤（由最后一个步骤的员工执行）
  const finalEmployee=bound[bound.length-1]!.employeeId;
  const integrationInput=architecture.modules.reduce((n,m)=>n+m.workload.inputTokens,0);
  bound.push({moduleId:'integration',employeeId:finalEmployee,dependsOn:bound.map((_,i)=>i),prompt:'接收全部已验收模块的冻结代码，按统一架构契约核对模块接口、数据结构和完整系统验收条件，完成必要集成及文档。仅处理已确认需求；执行所有已授权验收检查并提交实际证据。',scheduling:taskProfile({kind:'testing',writePaths:architecture.modules.flatMap(m=>m.paths),difficulty:Math.max(...architecture.modules.map(m=>m.difficulty)),contextTokens:integrationInput+2000,workload:{inputTokens:integrationInput,outputTokens:2000,calls:1},estimateMinor:cap})});
  return bound;
}
