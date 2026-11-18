import {randomUUID} from 'node:crypto';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileTool,projectPath} from '../../assistant/assistant-tools.js';
import type {ToolDefinition} from '../../assistant/tool-registry.js';
import type {Store} from '../../coordination/contracts.js';
import {PreflightError} from '../../recovery/fault-policy.js';
import {invalid,operations,required,unavailable,type AgentSkill} from './manifest.js';
import {readBounded} from '../channels/remote-adapter.js';
import {sandboxJavaScript} from './sandbox.js';

const string=(maxLength:number)=>({type:'string',minLength:1,maxLength});
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const time={type:'string',format:'date-time',maxLength:40};
const schemas={
  'file.read':schema({path:string(1000)},['path']),
  'file.write':schema({path:string(1000),content:{type:'string',maxLength:20000}},['path','content']),
  'web.search':schema({query:string(300)},['query']),
  'code.run':schema({code:string(8000),input:{}}),
  'calendar.list':schema({from:time,to:time}),
  'calendar.add':schema({title:string(160),startsAt:time,endsAt:time},['title','startsAt','endsAt']),
  'calendar.remove':schema({eventId:string(80)},['eventId']),
} as const;

export function skillTool(manifest:AgentSkill,revision:string):ToolDefinition{
  const operation=manifest.operation;
  return {name:'skill_'+manifest.id.replaceAll('-','_'),description:manifest.name+' · '+manifest.description,
    inputSchema:operation==='code.run'?(manifest.script?schema({input:{}}):schema(schemas['code.run'].properties,['code'])):schemas[operation],
    readOnly:operations[operation].readOnly,changesWorkspace:operation==='file.write',version:revision};
}

function scopedPath(root:string,directory:string,path:unknown,write:boolean){
  const scope=projectPath(root,directory);
  if(relative(scope,realpathSync.native(scope))||!statSync(scope).isDirectory())throw invalid('技能范围必须是项目内的实际目录');
  const target=projectPath(root,path,write);
  let ancestor=target;
  while(!existsSync(ancestor))ancestor=dirname(ancestor);
  const actual=resolve(realpathSync.native(ancestor),relative(ancestor,target));
  const inside=relative(scope,actual);
  if(!inside||inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside))throw unavailable('文件超出技能授权目录');
}

function iso(value:unknown){
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw invalid('日程时间无效');
  return new Date(value).toISOString();
}

export type SkillFileRunner=(tool:'write_file'|'read_file',args:Record<string,unknown>,signal:AbortSignal)=>unknown;

export function createSkillOperations({db,rows,now}:Store,projectRoot:(id:string)=>string,fetcher:typeof fetch=fetch){
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_skill_calendar (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,
      starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_skill_calendar_time ON assistant_skill_calendar(project_id,starts_at);
  `);

  async function search(query:string,signal:AbortSignal){
    const key=process.env.APIX_SKILL_BRAVE_KEY;
    if(!key)throw new PreflightError(unavailable('尚未设置 APIX_SKILL_BRAVE_KEY'));
    const url=new URL('https://api.search.brave.com/res/v1/web/search');
    try{url.searchParams.set('q',required(query,300,'查询'));}
    catch(error){throw new PreflightError(error);}
    url.searchParams.set('count','5');
    const response=await fetcher(url,{headers:{Accept:'application/json','X-Subscription-Token':key},redirect:'error',
      signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
    if(!response.ok){await response.body?.cancel();throw new Error('网页搜索服务请求失败');}
    const body=JSON.parse((await readBounded(response,1024*1024)).toString('utf8')) as {web?:{results?:{title?:unknown;url?:unknown;description?:unknown}[]}};
    return {authority:'reference_only',results:(Array.isArray(body?.web?.results)?body.web.results:[]).filter(item=>item&&typeof item==='object').slice(0,5).map(item=>({
      title:String(item.title??'').slice(0,300),url:String(item.url??'').slice(0,2000),description:String(item.description??'').slice(0,500),
    }))};
  }

  return async function run(projectId:string,manifest:AgentSkill,args:Record<string,unknown>,signal:AbortSignal,fileRunner?:SkillFileRunner){
    signal.throwIfAborted();
    switch(manifest.operation){
      case 'file.read':
      case 'file.write':{
        const write=manifest.operation==='file.write';
        let root:string;
        try{root=projectRoot(projectId);scopedPath(root,manifest.directory!,args.path,write);}
        catch(error){throw new PreflightError(error);}
        const tool=write?'write_file':'read_file';
        return fileRunner?fileRunner(tool,args,signal):fileTool(root,tool,args);
      }
      case 'web.search':return search(String(args.query),signal);
      case 'code.run':return sandboxJavaScript(manifest.script??String(args.code),args.input,signal);
      case 'calendar.list':{
        const from=args.from===undefined?'':iso(args.from),to=args.to===undefined?'9999-12-31T23:59:59.999Z':iso(args.to);
        if(from>=to)throw invalid('日程查询结束时间应晚于开始时间');
        return {events:rows('SELECT id,title,starts_at,ends_at FROM assistant_skill_calendar WHERE project_id=? AND ends_at>? AND starts_at<? ORDER BY starts_at,id LIMIT 100',projectId,from,to)};
      }
      case 'calendar.add':{
        const title=String(args.title).trim(),startsAt=iso(args.startsAt),endsAt=iso(args.endsAt);
        if(!title||endsAt<=startsAt)throw new PreflightError(invalid('日程标题或时间范围无效'));
        const id=randomUUID();
        db.prepare('INSERT INTO assistant_skill_calendar VALUES (?,?,?,?,?,?)').run(id,projectId,title,startsAt,endsAt,now());
        return {id,title,startsAt,endsAt};
      }
      case 'calendar.remove':return {deleted:Boolean(db.prepare('DELETE FROM assistant_skill_calendar WHERE project_id=? AND id=?').run(projectId,String(args.eventId)).changes)};
    }
  };
}
