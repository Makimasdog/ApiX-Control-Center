import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,mkdirSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createToolRegistry} from '../../assistant/tool-registry.js';
import {object,type Store} from '../../coordination/contracts.js';
import {PreflightError} from '../../recovery/fault-policy.js';
import {changed,digest,invalid,loadManifest,readManifest,required,skillId,unavailable,type AgentSkill} from './manifest.js';
import {builtinMarket} from './market.js';
import {createSkillOperations,skillTool,type SkillFileRunner} from './operations.js';

function validateId(id:string){
  if(!skillId.test(id))throw invalid('技能标识无效');
  return id;
}

function directoryExists(path:string){
  try{
    const stat=lstatSync(path);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable('技能目录不可用');
    return true;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
    throw error;
  }
}

export function createAgentSkills(store:Store,dataDir:string,projectRoot:(id:string)=>string,
  projectMode:(id:string)=>string,fetcher:typeof fetch=fetch){
  const {db,row,now}=store;
  const base=join(dataDir,'agent-skills');
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_skill_grants (
    project_id TEXT NOT NULL REFERENCES projects(id),skill_id TEXT NOT NULL,revision TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(project_id,skill_id)
  )`);
  const execute=createSkillOperations(store,projectRoot,fetcher);

  function project(id:string){
    if(!row('SELECT id FROM projects WHERE id=?',id))throw invalid('项目不存在');
    return join(base,createHash('sha256').update(id).digest('hex'));
  }
  function paths(projectId:string,id:string){
    const directory=project(projectId);
    const path=join(directory,validateId(id)+'.json');
    const exists=directoryExists(base)&&directoryExists(directory);
    return {directory,path,exists};
  }
  function read(projectId:string,id:string){
    const location=paths(projectId,id);
    const manifest=location.exists?loadManifest(location.path,id):undefined;
    if(!manifest)throw unavailable('技能不存在');
    const revision=digest(manifest);
    const grant=row<{revision:string}>('SELECT revision FROM assistant_skill_grants WHERE project_id=? AND skill_id=?',projectId,id);
    return {id,manifest,revision,enabled:grant?.revision===revision};
  }

  function list(projectId:string){
    const directory=project(projectId);
    if(!directoryExists(base)||!directoryExists(directory))return [];
    return readdirSync(directory,{withFileTypes:true})
      .map(entry=>entry.name)
      .filter(name=>name.endsWith('.json')&&skillId.test(name.slice(0,-5)))
      .sort().slice(0,64).map(name=>{
        const id=name.slice(0,-5);
        try{return read(projectId,id);}
        catch{return {id,manifest:null,revision:null,enabled:false,error:'技能清单不可读或格式无效'};}
      });
  }

  function revoke(projectId:string,id:string){
    db.prepare('DELETE FROM assistant_skill_grants WHERE project_id=? AND skill_id=?').run(projectId,id);
  }

  function install(projectId:string,raw:unknown){
    const input=object(raw);
    const source=input.market===undefined?null:object(input.market);
    if(source&&input.manifest!==undefined)throw invalid('请选择一种技能来源');
    const manifest=source?builtinMarket.get(required(source.id,48,'技能标识'),required(source.version,20,'技能版本')):readManifest(input.manifest);
    const revision=digest(manifest);
    const {directory,path,exists}=paths(projectId,manifest.id);
    const previous=exists?loadManifest(path,manifest.id):undefined;
    const previousRevision=previous?digest(previous):undefined;
    if(previousRevision!==input.expectedRevision)throw changed();
    if(!previous&&list(projectId).length>=64)throw invalid('每个项目最多安装 64 个技能');
    mkdirSync(directory,{recursive:true,mode:0o700});
    const temporary=join(directory,randomUUID()+'.tmp');
    try{
      writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
      if(previousRevision!==revision)revoke(projectId,manifest.id);
      renameSync(temporary,path);
    }finally{rmSync(temporary,{force:true});}
    return {id:manifest.id,manifest,revision,enabled:read(projectId,manifest.id).enabled};
  }

  function setEnabled(projectId:string,id:string,raw:unknown){
    const input=object(raw);
    if(typeof input.enabled!=='boolean')throw invalid('启用状态无效');
    if(!input.enabled){
      paths(projectId,id);
      revoke(projectId,id);
      return {id,enabled:false};
    }
    const current=read(projectId,id);
    if(input.revision!==current.revision)throw changed();
    db.prepare(`INSERT INTO assistant_skill_grants VALUES (?,?,?,?)
      ON CONFLICT(project_id,skill_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(projectId,id,current.revision,now());
    return {...current,enabled:true};
  }

  function remove(projectId:string,id:string){
    const {path,exists}=paths(projectId,id);
    revoke(projectId,id);
    if(exists)rmSync(path,{force:true});
    return {id,removed:true};
  }

  function available(projectId:string,id:string,revision:unknown){
    const entry=read(projectId,id);
    if(entry.revision!==revision)throw changed();
    if(!entry.enabled)throw unavailable('技能需要所有者启用');
    const tool=skillTool(entry.manifest,entry.revision);
    if(!tool.readOnly&&projectMode(projectId)==='read_only')throw unavailable('项目只读，当前技能需要额外权限');
    return {manifest:entry.manifest,tool};
  }

  async function run(projectId:string,id:string,raw:unknown){
    const input=object(raw),entry=available(projectId,id,input.revision);
    const args=createToolRegistry([entry.tool]).validate(entry.tool.name,input.args??null);
    return execute(projectId,entry.manifest,args,AbortSignal.timeout(12000));
  }

  async function call(projectId:string,name:string,revision:string,args:Record<string,unknown>,signal:AbortSignal,fileRunner?:SkillFileRunner){
    let entry;
    try{entry=available(projectId,name.slice(6).replaceAll('_','-'),revision);}
    catch(error){throw new PreflightError(error);}
    return execute(projectId,entry.manifest,args,signal,fileRunner);
  }

  function tools(projectId:string){
    try{
      return list(projectId).flatMap(entry=>entry.enabled&&entry.manifest&&entry.revision
        ?[skillTool(entry.manifest,entry.revision)]:[]);
    }catch{
      // The owner API reports storage errors. The assistant can still run without skills.
      return [];
    }
  }

  return {list,install,setEnabled,remove,run,call,tools};
}
