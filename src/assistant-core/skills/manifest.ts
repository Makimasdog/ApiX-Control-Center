import {lstatSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ToolError} from '../../assistant/tool-governance.js';
import {object} from '../../coordination/contracts.js';

export const operations = {
  'file.read': {permission:'workspace.read', readOnly:true},
  'file.write': {permission:'workspace.write', readOnly:false},
  'web.search': {permission:'network.brave-search', readOnly:false},
  'code.run': {permission:'sandbox.javascript', readOnly:true},
  'calendar.list': {permission:'calendar.read', readOnly:true},
  'calendar.add': {permission:'calendar.write', readOnly:false},
  'calendar.remove': {permission:'calendar.write', readOnly:false},
} as const;

export type Operation = keyof typeof operations;
export interface AgentSkill {
  schema: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  operation: Operation;
  permissions: string[];
  directory?: string;
  script?: string;
}
export const invalid = (message:string) => new ToolError('INVALID_ARGUMENTS',message,'correct_input');
export const unavailable = (message:string) => new ToolError('SKILL_UNAVAILABLE',message,'request_owner',{},403);
export const changed = () => new ToolError('SKILL_CHANGED','技能版本已变化，请刷新并重新启用','request_owner',{},409);
export const skillId = /^[a-z][a-z0-9-]{1,47}$/;
export const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function required(value:unknown, max:number, label:string){
  if(typeof value!=='string'||!value.trim()||value.length>max)throw invalid(label+'格式无效');
  return value.trim();
}

export function readManifest(raw:unknown):AgentSkill{
  const input=object(raw);
  const {schema,id,version,operation,permissions}=input;
  if(schema!==1||typeof id!=='string'||!skillId.test(id)||typeof version!=='string'||!versionPattern.test(version)||
     typeof operation!=='string'||!Object.hasOwn(operations,operation))throw invalid('AgentSkill 版本、标识或操作无效');
  const op=operation as Operation;
  const permission=operations[op].permission;
  if(!Array.isArray(permissions)||permissions.length!==1||permissions[0]!==permission)throw invalid('声明权限必须与所选操作一致');
  const name=required(input.name,80,'名称'),description=required(input.description,400,'说明');
  const isFile=op==='file.read'||op==='file.write';
  const fields=new Set(['schema','id','version','name','description','operation','permissions',...(isFile?['directory']:[]),...(op==='code.run'?['script']:[])]);
  if(Object.keys(input).some(key=>!fields.has(key)))throw invalid('AgentSkill 含有未支持的字段');
  const directory=isFile?required(input.directory??'.',500,'工作目录'):undefined;
  const script=op==='code.run'&&input.script!==undefined?required(input.script,8000,'脚本'):undefined;
  return {schema:1,id,version,name,description,operation:op,permissions:[permission],...(directory?{directory}:{}),...(script?{script}:{})};
}

export const digest=(manifest:AgentSkill)=>createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

const maxManifest=48*1024;
export function loadManifest(path:string,id:string){
  let info;
  try{info=lstatSync(path);}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
    throw error;
  }
  if(!info.isFile()||info.size>maxManifest)throw invalid('技能文件格式或大小无效');
  let input:unknown;
  try{input=JSON.parse(readFileSync(path,'utf8'));}
  catch(error){if(error instanceof SyntaxError)throw invalid('技能清单 JSON 无效');throw error;}
  const manifest=readManifest(input);
  if(manifest.id!==id)throw invalid('技能文件名与清单标识不符');
  return manifest;
}
