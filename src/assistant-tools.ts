import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {managedCommand,type CommandHooks} from './command-lifecycle.js';
import {object,text} from './contracts.js';

const excluded=(name:string)=>name==='node_modules'||name==='.git'||name.startsWith('.tmp')||/^\.env(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key|pfx|p12)$/i.test(name);
function within(root:string,path:string){const rel=relative(root,path);return rel!== '..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel);}
export function projectPath(root:string,input:unknown,write=false):string {
  root=realpathSync.native(root);const name=text(input,1000);
  if(isAbsolute(name)||name.includes('\0')||name.includes(':')||name.split(/[\\/]/).some(excluded))throw new Error('路径不能访问项目外或凭据文件');
  const target=resolve(root,name);if(!within(root,target))throw new Error('路径越过项目边界');
  let parent=target;while(!existsSync(parent)){const next=dirname(parent);if(next===parent)throw new Error('路径不存在');parent=next;}
  if(!within(root,realpathSync.native(parent)))throw new Error('链接越过项目边界');
  if(!write&&!existsSync(target))throw new Error('文件不存在');return target;
}
export function projectFingerprint(root:string,mutablePaths:string[]=[],protectChecks=false):string {
  root=realpathSync.native(root);const hash=createHash('sha256');let count=0,bytes=0;
  function visit(dir:string){for(const name of readdirSync(dir).sort()){
    if(protectChecks?name==='.git':excluded(name))continue;const path=join(dir,name),stat=lstatSync(path);if(++count>3000)throw new Error('项目超过完整验证范围，请拆分任务或使用委派工作区');
    if(stat.isSymbolicLink())throw new Error('验证范围包含链接，请使用可核对的工作区');
    const rel=relative(root,path).replaceAll('\\','/');
    const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
    if(mutablePaths.some(p=>key(rel)===key(p)||key(rel).startsWith(key(p)+'/')))continue;
    if(!protectChecks)hash.update(JSON.stringify([relative(root,path),stat.isDirectory(),stat.size]));
    if(stat.isDirectory()){visit(path);}else if(stat.isFile()){if(protectChecks)hash.update(JSON.stringify([rel,stat.size]));if((bytes+=stat.size)>8*1024*1024)throw new Error('项目超过 8 MiB 完整验证范围');hash.update(readFileSync(path));}
  }}visit(root);return hash.digest('hex');
}
export function projectInstructions(root:string){
  return ['AGENTS.md','APIX.md','CLAUDE.md'].filter(name=>existsSync(join(root,name))).map(name=>{
    const path=projectPath(root,name);if(lstatSync(realpathSync.native(path)).size>16000)throw new Error(`${name} 超过规则预算，请精简后继续`);
    return {path:name,content:readFileSync(path,'utf8')};
  });
}
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
export function fileTool(root:string,tool:string,input:unknown){
  const args=object(input);
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
  if(tool==='read_file'){if(lstatSync(realpathSync.native(path)).size>20000)throw new Error('文件超过完整读取预算，请委派拆分审查');return {path:args.path,content:readFileSync(path,'utf8')};}
  if(tool==='write_file'){
    if(typeof args.content!=='string'||args.content.length>20000||path===realpathSync.native(root))throw new Error('写入内容无效或过大');
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,args.content);return {path:args.path,bytes:Buffer.byteLength(args.content)};
  }
  throw new Error('未知文件工具');
}
export async function commandTool(root:string,input:unknown,env:NodeJS.ProcessEnv,signal:AbortSignal,onSpawn:(pid:number|undefined)=>void=()=>{},protectedValues:string[]=[],hooks:CommandHooks={}){
  const args=object(input);const executable=text(args.executable,1000);
  if(args.args===undefined)args.args=[];
  if(!Array.isArray(args.args)||args.args.length>40||args.args.some(a=>typeof a!=='string'||a.length>2000||a.includes('\0')))throw new Error('命令参数无效');
  const timeout=Number(args.timeoutMs??30000);if(!Number.isSafeInteger(timeout)||timeout<100||timeout>120000)throw new Error('命令超时应为 100–120000 毫秒');
  if(signal.aborted)throw new Error('执行已停止');
  const secrets=[...new Set([...protectedValues.filter(v=>!!v),...Object.entries({...process.env,...env}).filter(([key,value])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&value&&value.length>=6).map(([,value])=>value!)])];
  return managedCommand(executable==='node'?process.execPath:executable,args.args as string[],realpathSync.native(root),env,signal,timeout,onSpawn,secrets,hooks);
}
