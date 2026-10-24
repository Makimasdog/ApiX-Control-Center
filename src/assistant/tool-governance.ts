import {createHash,randomUUID} from 'node:crypto';
import {type Store,object} from '../coordination/contracts.js';
import {type ToolDefinition} from './tool-registry.js';

export class ToolError extends Error {
  constructor(public code:string,message:string,public action='correct_input',public details:unknown={},public status=400){super(message);}
  get retryable(){return false;}
}
export function errorInfo(error:unknown){return error instanceof ToolError?{code:error.code,message:error.message,retryable:false,action:error.action,details:error.details}:{code:'EXECUTION_FAILED',message:'工具执行失败，请根据已保存结果检查原因',retryable:false,action:'inspect_result'};}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value)??'null';
}
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export function redact(value:unknown,maskPayload=true):unknown {
  if(Array.isArray(value))return value.map((v,i)=>typeof v==='string'&&i>0&&/^(?:--?(?:api[-_]?key|token|secret|password|authorization))$/i.test(String((value as unknown[])[i-1]))?'<redacted>':redact(v,maskPayload));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/key|token|secret|password|authorization|cookie/i.test(k)||maskPayload&&/^(?:content|oldText|newText|args)$/i.test(k)?'<redacted>':redact(v,maskPayload)]));
  if(typeof value==='string'){
    for(const [key,secret] of Object.entries(process.env))if(/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&secret&&secret.length>=6)value=String(value).split(secret).join('<redacted>');
    return String(value).replace(/\b(?:sk-|Bearer\s+)[\w.\-]+/g,'<redacted>').replace(/((?:api[-_]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi,'$1<redacted>').slice(0,maskPayload?300:30000);
  }return value;
}
export function safeArguments(value:unknown,depth=0){
  if(depth===0&&Buffer.byteLength(JSON.stringify(value))>64000)throw new ToolError('INVALID_ARGUMENTS','工具参数超过 64 KiB');
  if(depth>12)throw new ToolError('INVALID_ARGUMENTS','工具参数嵌套过深');
  if(typeof value==='string'&&value.includes('\0'))throw new ToolError('INVALID_ARGUMENTS','工具参数含 NUL');
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw new ToolError('INVALID_ARGUMENTS','禁止原型字段');safeArguments(item,depth+1);}
}
interface Access {role:string;allow:string[];deny:string[];version:number}
const roles=['planner','executor','coordinator'];
const coordinatorOnly=new Set(['configure_agents','configure_verification','delegate','send_agent_message']);
export function createToolGovernance(store:Store){
  const {db,row,rows,now}=store;
  db.exec(`CREATE TABLE IF NOT EXISTS tool_access(project_id TEXT NOT NULL REFERENCES projects(id),subject TEXT NOT NULL,role TEXT NOT NULL,allow_json TEXT NOT NULL,deny_json TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(project_id,subject));
    CREATE TABLE IF NOT EXISTS tool_audit(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,subject TEXT NOT NULL,tool TEXT NOT NULL,args_summary TEXT NOT NULL,outcome TEXT NOT NULL,code TEXT,created_at TEXT NOT NULL);`);
  function subject(projectId:string,id:string){if(!row('SELECT id FROM projects WHERE id=?',projectId)||id!=='apix'&&!row('SELECT id FROM employees WHERE id=? AND deleted_at IS NULL',id))throw new ToolError('SUBJECT_NOT_FOUND','项目或员工不存在');}
  function get(projectId:string,id='apix'):Access {subject(projectId,id);const p=row<{role:string;allow_json:string;deny_json:string;version:number}>('SELECT * FROM tool_access WHERE project_id=? AND subject=?',projectId,id);return p?{role:p.role,allow:JSON.parse(p.allow_json),deny:JSON.parse(p.deny_json),version:p.version}:{role:id==='apix'?'coordinator':'planner',allow:[],deny:[],version:0};}
  function save(projectId:string,input:Record<string,unknown>){
    const id=String(input.subject??'apix'),old=get(projectId,id);if(input.version!==old.version)throw new ToolError('VERSION_CONFLICT','工具策略已变化','refresh',{},409);
    if(!roles.includes(String(input.role)))throw new ToolError('INVALID_ARGUMENTS','安全角色无效');
    const names=(value:unknown)=>{if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!/^[a-zA-Z][\w]{0,119}$/.test(v)))throw new ToolError('INVALID_ARGUMENTS','工具清单无效');return [...new Set(value as string[])];};
    db.exec('SAVEPOINT tool_access_save');try{db.prepare('INSERT INTO tool_access VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,subject) DO UPDATE SET role=excluded.role,allow_json=excluded.allow_json,deny_json=excluded.deny_json,version=excluded.version').run(projectId,id,String(input.role),JSON.stringify(names(input.allow)),JSON.stringify(names(input.deny)),old.version+1);audit(projectId,id,'set_tool_access',{role:input.role,allow:input.allow,deny:input.deny},'updated');db.exec('RELEASE tool_access_save');return get(projectId,id);}catch(error){db.exec('ROLLBACK TO tool_access_save;RELEASE tool_access_save');throw error;}
  }
  function check(projectId:string,id:string,definition:ToolDefinition,args:Record<string,unknown>){
    safeArguments(args);const p=get(projectId,id),name=definition.name;
    if(p.deny.includes(name)||p.allow.length&&!p.allow.includes(name)||p.role==='planner'&&!definition.readOnly||p.role==='executor'&&coordinatorOnly.has(name))throw new ToolError('TOOL_FORBIDDEN','当前主体未获此工具权限','request_owner',{tool:name,role:p.role},403);
    return p;
  }
  function audit(projectId:string,subject:string,tool:string,args:unknown,outcome:string,code?:string){db.prepare('INSERT INTO tool_audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),projectId,subject,tool,JSON.stringify({role:get(projectId,subject).role,accessVersion:get(projectId,subject).version,args:redact(args)}),outcome,code??null,now());}
  return {get,save,check,audit,list:(projectId:string)=>{subject(projectId,'apix');return rows('SELECT id,subject,tool,args_summary,outcome,code,created_at FROM tool_audit WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100',projectId);}};
}
