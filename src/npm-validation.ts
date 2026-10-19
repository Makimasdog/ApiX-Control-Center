import {mkdtempSync,mkdirSync,writeFileSync,lstatSync,openSync,closeSync,readSync,writeSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {type Store} from './contracts.js';
import {type VerificationContract,contractCurrent,verificationFingerprint,checkPassed} from './assistant-verification.js';
import {sourceManifest,treeEvidence,boundedJson,boundedNames,nodeProjectLimits as limits} from './node-project.js';
import {CommandSafetyError} from './assistant-commands.js';
import {hostResultSummary} from './assistant-result.js';

interface Session {id:string;project_id:string;task_id?:string|null}
interface Dependencies extends Store {directory:string;root(project:string):string;command(s:Session,args:Record<string,unknown>,signal:AbortSignal,context:{root:string;env:NodeJS.ProcessEnv}):Promise<unknown>}
function copySource(from:string,to:string,size:number){const input=openSync(from,'r');let output:number|undefined,total=0;try{output=openSync(to,'wx');const buffer=Buffer.alloc(65536);let n;while((n=readSync(input,buffer,0,buffer.length,null))){if((total+=n)>size)throw new Error('复制期间源码超过预算');let offset=0;while(offset<n)offset+=writeSync(output,buffer,offset,n-offset);}if(total!==size)throw new Error('复制期间源码变化');}finally{closeSync(input);if(output!==undefined)closeSync(output);}}
// Owned copies are retained for diagnosis. No automatic deletion or resume/replay after restart.
export function createNpmValidation(deps:Dependencies){
 const {db,now}=deps;
 function event(s:Session,kind:string,body:unknown){db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(s.id,kind,JSON.stringify(body),now());}
 function capacity(){mkdirSync(deps.directory,{recursive:true});const entries=boundedNames(deps.directory,20);if(entries.length>=20)throw new Error('已保留 20 次验证副本，请核对诊断资料后手工整理');let bytes=0;for(const name of entries){const path=join(deps.directory,name);if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw new Error('验证存储包含未知资料');bytes+=treeEvidence(path,60000,384*1024*1024).bytes;}if(bytes>1024*1024*1024)throw new Error('验证副本总容量超过 1 GiB，请手工整理');}
 async function run(s:Session,c:VerificationContract,checkId:string,parentSignal:AbortSignal){
  const controller=new AbortController(),signal=controller.signal,abort=()=>controller.abort();parentSignal.addEventListener('abort',abort,{once:true});if(parentSignal.aborted)abort();
  try{return await runOwned(s,c,checkId,signal,controller);}finally{parentSignal.removeEventListener('abort',abort);}
 }
 async function runOwned(s:Session,c:VerificationContract,checkId:string,signal:AbortSignal,controller:AbortController){
  if(!c.npm||!contractCurrent(deps.root(s.project_id),c))throw new Error('npm 配置已失效，请重新批准');
  const check=c.npm.scripts.find(e=>e.id===checkId);if(!check)throw new Error('npm 检查未批准');
  if(signal.aborted)throw new Error('验证已取消，未准备');capacity();
  const source=deps.root(s.project_id),manifest=sourceManifest(source,c.npm.artifacts),fingerprint=verificationFingerprint(source,c);
  const owned=mkdtempSync(join(deps.directory,'run-')),workspace=join(owned,'workspace');mkdirSync(workspace);
  if(!resolve(owned).startsWith(resolve(deps.directory)+sep))throw new Error('验证目录越界');
  const run:any={schemaVersion:1,taskId:s.task_id??null,sessionId:s.id,projectId:s.project_id,contractVersion:c.version,sourceFingerprint:fingerprint,source:{hash:manifest.hash,files:manifest.files.length,bytes:manifest.bytes},runtime:c.npm.runtime,installPolicy:c.npm.installPolicy,environmentPolicy:c.npm.environmentPolicy,network:c.npm.network,ownedDirectory:owned,checkId,startedAt:now(),status:'preparing',commands:[],artifacts:[]};
  event(s,'npm_validation_started',run);
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','ComSpec','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  for(const name of ['tmp','home','cache'])mkdirSync(join(owned,name));
  const config=join(owned,'user.npmrc'),globalConfig=join(owned,'global.npmrc');writeFileSync(config,'');writeFileSync(globalConfig,'');
  Object.assign(env,{PATH:dirname(c.npm.runtime.node)+';'+join(process.env.SystemRoot??'C:\\Windows','System32'),TEMP:join(owned,'tmp'),TMP:join(owned,'tmp'),USERPROFILE:join(owned,'home'),HOME:join(owned,'home'),CI:'true',NPM_CONFIG_USERCONFIG:config,NPM_CONFIG_GLOBALCONFIG:globalConfig,NPM_CONFIG_CACHE:join(owned,'cache'),NPM_CONFIG_UPDATE_NOTIFIER:'false',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',NPM_CONFIG_IGNORE_SCRIPTS:'true'});
  const command=async(args:string[])=>{if(signal.aborted)throw new Error('验证已取消');let resourceError='';
   const guard=setInterval(()=>{try{treeEvidence(owned,60000,384*1024*1024,true);}catch(e){resourceError=e instanceof Error?e.message:'验证资源超限';controller.abort();}},1500);
   let result:Record<string,any>;try{result=await deps.command(s,{executable:c.npm!.runtime.node,args:[c.npm!.runtime.npm,...args],timeoutMs:120000},signal,{root:workspace,env}) as Record<string,any>;}finally{clearInterval(guard);}
   run.commands.push({...hostResultSummary(result),outputRef:result.outputRef,executable:c.npm!.runtime.node,args:[c.npm!.runtime.npm,...args],cwd:workspace});if(resourceError)throw new Error(resourceError);if(!checkPassed(result)||result.log?.complete!==true)throw new Error('准备或检查失败；请读取 command outputRef/operationId 的尾部日志');return result;};
  let actual:Record<string,any>|undefined;
  try{
   for(const file of manifest.files){const path=join(source,file.path),target=join(workspace,file.path);mkdirSync(dirname(target),{recursive:true});copySource(path,target,file.size);}
   if(sourceManifest(workspace,c.npm.artifacts).hash!==manifest.hash||sourceManifest(source,c.npm.artifacts).hash!==manifest.hash)throw new Error('复制期间源码变化，未启动安装');
   actual=await command(c.npm.installArgs);
   const dependencies=treeEvidence(join(workspace,'node_modules'),limits.dependencyFiles,limits.dependencyBytes);run.dependencies={...dependencies,files:dependencies.files.length};
   // Reject native/install packages even if incomplete lock metadata failed to declare them.
   for(const f of dependencies.files){if(/(?:^|[\\/])binding\.gyp$|\.node$/i.test(f.path))throw new Error('已安装依赖包含不支持的原生扩展');if(/(?:^|[\\/])package\.json$/.test(f.path)){const pkg=boundedJson(join(workspace,'node_modules',f.path));if(['preinstall','install','postinstall','prepare'].some(n=>pkg.scripts?.[n]))throw new Error('已安装依赖要求安装脚本，准备不完整');}}
   if(sourceManifest(workspace,c.npm.artifacts).hash!==manifest.hash)throw new Error('依赖准备改写源码或配置');
   run.preparation={strategy:'fresh-npm-ci',lockHash:manifest.files.find(f=>f.path==='package-lock.json')!.sha256,dependencyHash:dependencies.hash,installOperationId:actual.operationId,ignoreScripts:true};run.status='checking';event(s,'npm_validation_prepared',run);
   for(const invocation of check.commands){const script=invocation.name;event(s,'npm_validation_step',{taskId:s.task_id,checkId,script,status:script.includes('build')?'building':script.includes('test')?'testing':'checking'});actual=await command(invocation.npmArgs);if(sourceManifest(workspace,c.npm.artifacts).hash!==manifest.hash||treeEvidence(join(workspace,'node_modules'),limits.dependencyFiles,limits.dependencyBytes).hash!==dependencies.hash)throw new Error('检查改写源码、配置或依赖，原证据作废');}
   run.artifacts=c.npm.artifacts.map(path=>({path,...treeEvidence(join(workspace,path),limits.artifactFiles,limits.artifactBytes),fresh:true,owner:run.startedAt}));
   if(verificationFingerprint(source,c)!==fingerprint||!contractCurrent(source,c))throw new Error('源项目在检查期间变化；结果只适用于副本，不能验收当前版本');
   run.status='passed';
  }catch(e){if(e instanceof CommandSafetyError)throw e;run.status=signal.aborted?'cancelled':run.commands.some((r:any)=>r.unknown||!r.processesEnded)?'unknown':run.preparation?'failed':'preparation_incomplete';run.error=e instanceof Error?e.message:'验证失败';}
  run.finishedAt=now();
  // Saving the summary is part of verification. A failed SQLite write never yields a trusted pass.
  event(s,'npm_validation_finished',run);
  const last=run.commands.at(-1)??actual;
  return {...last,exitCode:run.status==='passed'?0:last?.exitCode??null,unknown:run.status==='unknown'||last?.unknown===true,executionComplete:run.status==='passed'&&last?.executionComplete===true,passed:run.status==='passed',error:run.error,npmValidation:run};
 }
 return {run};
}
