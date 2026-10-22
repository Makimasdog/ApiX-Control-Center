import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {type Store,text} from '../coordination/contracts.js';
import {projectFingerprint} from './assistant-tools.js';
import {logLimits} from '../execution/command-logs.js';
import {sourceManifest} from '../validation/node-project.js';
import {projectScanLimits,scanProjectFile} from '../infrastructure/project-scan.js';

export const reviewLimits={items:projectScanLimits.items,bytes:projectScanLimits.bytes,textBytes:256*1024,artifactBytes:24*1024*1024,totalBytes:128*1024*1024,days:30,diffCharacters:16000,totalDiffCharacters:64000};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
interface Session {id:string;project_id:string;status:string;version:number;needs_verification:number}
interface File {path:string;sha256:string;size:number;detail:string;content?:string}
interface Snapshot {scopeVersion:1;manifest:string;files:File[];scope:{included:string;excluded:string[]};fingerprint:string}
interface Task {id:string;description:string;startedEventId:number;createdAt:string}
interface Verification {verificationStatus:string;contract?:{version:string}|null;checks?:any[]}
export interface Delivery {id:string;version:number;taskId:string;sessionId:string;projectId:string;description:string;createdAt:string;baselineRef:string|null;finalRef:string|null;baselineVersion:string|null;manifest:string|null;fingerprint:string|null;netChanges:any[];scope:unknown;requiresVerification:boolean;verification:Verification;modelSummary:string;execution:unknown}
const excluded=(name:string)=>['.npmrc','model-credentials.json'].includes(name.toLowerCase())||name==='.git'||name==='node_modules'||name.startsWith('.tmp')||/^\.env(?:\.|$)|^id_(rsa|ed25519)$|\.(pem|key|pfx|p12)$/i.test(name);
export function reviewSnapshot(root:string,artifacts:string[]=[]):Snapshot{
 root=realpathSync.native(root);const fingerprint=()=>artifacts.length?sourceManifest(root,artifacts).hash:projectFingerprint(root);const before=fingerprint(),files:File[]=[];let items=0,bytes=0,captured=0;
 function visit(dir:string){for(const name of readdirSync(dir).sort()){
  if((excluded(name)&&!(artifacts.length&&name.startsWith('.tmp')))||artifacts.includes(relative(root,join(dir,name)).replaceAll('\\','/')))continue;const path=join(dir,name),stat=lstatSync(path);if(++items>reviewLimits.items)throw new Error('审阅超过 20000 项范围');if(stat.isSymbolicLink())throw new Error('审阅范围包含链接，不能冻结');
  if(stat.isDirectory()){visit(path);continue;}if(!stat.isFile())throw new Error('审阅不支持此文件类型');if((bytes+=stat.size)>reviewLimits.bytes)throw new Error('审阅超过 256 MiB 范围');
  const scanned=scanProjectFile(path,stat,Math.min(reviewLimits.textBytes,Math.max(0,8*1024*1024-captured)));const data=scanned.data;
  let content:string|undefined,detail='oversize';if(data){captured+=data.length;try{if(data.includes(0))throw new Error();content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);detail='text';}catch{detail='binary';}}
  files.push({path:relative(root,path).replaceAll('\\','/'),sha256:scanned.sha256,size:scanned.bytes,detail,...(content===undefined?{}:{content})});
 }}visit(root);if(fingerprint()!==before)throw new Error('冻结期间工作区变化，请重新审阅');
 return {scopeVersion:1,manifest:sha(JSON.stringify(files.map(({path,sha256,size})=>({path,sha256,size})))),files,fingerprint:before,scope:{included:'项目内普通文件；文件字节，不包含目录属性',excluded:['.git','node_modules',...(artifacts.length?[]:['.tmp*']),'凭据文件','符号链接（拒绝）',...artifacts]}};
}
// Bounded line LCS after trimming common edges; large spans expose frozen before/after pages instead.
export function reviewDiff(before:string,after:string){
 const a=before.split('\n'),b=after.split('\n');let prefix=0,suffix=0;while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const x=a.slice(prefix,a.length-suffix),y=b.slice(prefix,b.length-suffix);if(x.length*y.length>200000)return {diff:'跨度超过有界 diff 预算；请读取冻结的修改前后内容',diffComplete:false};
 const table=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i]![j]=x[i]===y[j]?1+table[i+1]![j+1]!:Math.max(table[i+1]![j]!,table[i]![j+1]!);
 let i=0,j=0;const lines=[`@@ line ${prefix+1} @@`];while(i<x.length||j<y.length){if(i<x.length&&j<y.length&&x[i]===y[j]){lines.push(' '+x[i++]);j++;}else if(j<y.length&&(i===x.length||table[i]![j+1]!>=table[i+1]![j]!))lines.push('+'+y[j++]);else lines.push('-'+x[i++]);}
 const diff=lines.join('\n');return {diff:diff.slice(0,reviewLimits.diffCharacters),diffComplete:diff.length<=reviewLimits.diffCharacters};
}

export function createAssistantDelivery(store:Store,deps:{root?:(projectId:string)=>string;verification(s:Session):Verification;admit(s:Session):void;artifacts?(s:Session):string[];fingerprint?(s:Session):string}){
 const {db,row,rows,now}=store;
 const event=(s:Session,role:string,kind:string,body:unknown)=>db.prepare('INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,?,?,?,?)').run(s.id,role,kind,JSON.stringify(body),now());
 const entries=(s:Session,kind:string)=>rows<{id:number;body:string}>('SELECT id,body FROM assistant_events WHERE session_id=? AND kind=? ORDER BY id',s.id,kind).map(e=>({...JSON.parse(e.body),eventId:e.id}));
 function current(id:string):Task|null{const e=row<{id:number;body:string}>("SELECT id,body FROM assistant_events WHERE session_id=? AND kind='task_started' ORDER BY id DESC LIMIT 1",id);return e?{...JSON.parse(e.body),startedEventId:e.id}:null;}
 function transaction<T>(fn:()=>T):T{db.exec('SAVEPOINT assistant_delivery');try{const value=fn();db.exec('RELEASE assistant_delivery');return value;}catch(e){db.exec('ROLLBACK TO assistant_delivery');db.exec('RELEASE assistant_delivery');throw e;}}
 function snapshot(ref:string|null){if(!ref)throw new Error('此交付没有代码基线');const saved=row<{body:string;sha256:string;created_at:string}>('SELECT body,sha256,created_at FROM assistant_outputs WHERE id=?',ref);if(!saved||Date.parse(saved.created_at)<Date.parse(now())-reviewLimits.days*86400000)throw new Error('审阅资料已过期或不可用');if(sha(saved.body)!==saved.sha256)throw new Error('审阅资料完整性错误');return JSON.parse(saved.body).snapshot as Snapshot;}
 function save(s:Session,task:Task,value:Snapshot){
  const cutoff=new Date(Date.parse(now())-reviewLimits.days*86400000).toISOString();db.prepare("DELETE FROM assistant_outputs WHERE id LIKE 'review-%' AND created_at<?").run(cutoff);
  const body=JSON.stringify({kind:'review_snapshot_v1',taskId:task.id,snapshot:value}),size=Buffer.byteLength(body);let used=row<{n:number}>("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) n FROM assistant_outputs WHERE id LIKE 'review-%'")!.n;
  const protectedRef=baseline(s)?.ref;for(const saved of rows<{id:string;bytes:number}>("SELECT id,length(CAST(body AS BLOB)) bytes FROM assistant_outputs WHERE id LIKE 'review-%' ORDER BY created_at,event_id")){if(used+size<=reviewLimits.totalBytes)break;if(saved.id===protectedRef)continue;db.prepare('DELETE FROM assistant_outputs WHERE id=?').run(saved.id);used-=saved.bytes;event(s,'system','review_snapshot_expired',{ref:saved.id,reason:'capacity'});}
  if(size>reviewLimits.artifactBytes||used+size>reviewLimits.totalBytes)throw new Error('审阅资料容量不足；只读能力仍可用，请整理后开始新任务');
  const ref='review-'+randomUUID(),anchor=event(s,'system','review_snapshot',{taskId:task.id,ref,manifest:value.manifest});db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(ref,s.id,Number(anchor.lastInsertRowid),body,sha(body),now());return ref;
 }
 function baseline(s:Session){const task=current(s.id);if(!task)return null;return entries(s,'task_baseline').find(e=>e.taskId===task.id)??null;}
 function ensureBaseline(s:Session){const task=current(s.id);if(!task||!deps.root)return null;const prior=baseline(s);if(prior){snapshot(prior.ref);return prior;}const value=reviewSnapshot(deps.root(s.project_id),deps.artifacts?.(s));return transaction(()=>{const ref=save(s,task,value);event(s,'system','task_baseline',{taskId:task.id,ref,version:value.manifest});return {taskId:task.id,ref,version:value.manifest};});}
 function start(s:Session,description:string){const task={id:randomUUID(),description:text(description,4000),createdAt:now()};event(s,'user','task_started',task);try{ensureBaseline(s);}catch(e){event(s,'system','task_baseline_limited',{taskId:task.id,reason:e instanceof Error?e.message:'基线不可用'});}return current(s.id)!;}
 function net(s:Session,task:Task,initial:Snapshot,final:Snapshot){
  const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p,old=new Map(initial.files.map(f=>[key(f.path),f])),latest=new Map(final.files.map(f=>[key(f.path),f]));
  let remaining=reviewLimits.totalDiffCharacters;const ops=entries(s,'file_edit_result').filter(e=>e.eventId>task.startedEventId);return [...new Set([...old.keys(),...latest.keys()])].sort().flatMap(k=>{const a=old.get(k),b=latest.get(k);if(a?.sha256===b?.sha256)return [];const path=b?.path??a!.path;let chain=a?.sha256??null,known=false;for(const op of ops.filter(e=>key(relative(deps.root!(s.project_id),resolve(deps.root!(s.project_id),e.path)).replaceAll('\\','/'))===k)){if(op.beforeSha256!==chain){known=false;chain='external';break;}chain=op.afterSha256;known=true;}
   const source=known&&chain===(b?.sha256??null)?'agent_file_operations':'unattributed_or_external',detail=(a&&!a.content&&a.detail!=='text')||(b&&!b.content&&b.detail!=='text')?{diff:'仅有元数据：二进制或超出文本预算',diffComplete:false}:reviewDiff(a?.content??'',b?.content??'');
   if(detail.diff.length>remaining){detail.diff=detail.diff.slice(0,remaining);detail.diffComplete=false;}remaining-=detail.diff.length;return [{path,kind:!a?'added':!b?'deleted':'modified',beforeSha256:a?.sha256??null,afterSha256:b?.sha256??null,beforeBytes:a?.size??null,afterBytes:b?.size??null,source,...detail}];});
 }
 function observe(s:Session){const b=baseline(s),task=current(s.id);if(!b||!task||!deps.root)return {changes:[],baseline:null,final:null};const initial=snapshot(b.ref),final=reviewSnapshot(deps.root(s.project_id),deps.artifacts?.(s));return {changes:net(s,task,initial,final),baseline:b,final};}
 function freeze(s:Session,modelSummary:string){
  const task=current(s.id);if(!task)return null;let observed:ReturnType<typeof observe>;try{observed=observe(s);}catch(e){if(s.needs_verification)throw e;observed={changes:[],baseline:null,final:null};}
  if(s.needs_verification&&(!observed.baseline||!observed.final))throw new Error('没有可核对的任务基线，不能创建代码交付；请明确开始新任务');
  const previous=entries(s,'delivery_record').filter(e=>e.taskId===task.id).at(-1),verification=deps.verification(s);
  return transaction(()=>{const finalRef=observed.final?save(s,task,observed.final):null;const d:Delivery={id:randomUUID(),version:(previous?.version??0)+1,taskId:task.id,sessionId:s.id,projectId:s.project_id,description:task.description,createdAt:now(),baselineRef:observed.baseline?.ref??null,baselineVersion:observed.baseline?.version??null,finalRef,manifest:observed.final?.manifest??null,fingerprint:observed.final?.fingerprint??null,netChanges:observed.changes,scope:observed.final?.scope??{included:'只读说明，未冻结代码',complete:false},requiresVerification:!!s.needs_verification,verification,modelSummary,execution:{sideEffects:'按现有恢复门槛核对',checks:verification.checks?.map(c=>c?{runId:c.runId,operationId:c.operationId,outputRef:c.outputRef,log:c.log,executionComplete:c.executionComplete,evidencePersisted:c.evidencePersisted}:null)??[]}};event(s,'system','delivery_record',d);return d;});
 }
 function get(s:Session,id:string){const d=entries(s,'delivery_record').find(e=>e.id===id) as Delivery|undefined;if(!d||d.projectId!==s.project_id||d.sessionId!==s.id)throw new Error('交付不属于本项目/会话');return d;}
 function evidenceCurrent(d:Delivery){
  if(!d.requiresVerification)return;
  for(const check of d.verification.checks??[]){
   if(check?.passed!==true)throw new Error('可信检查未通过');
   for(const c of [check,...(check.npmValidation?.commands??[])]){
    if(!c?.outputRef||c.exitCode!==0||!c.executionComplete||!c.evidencePersisted||c.unknown!==false||c.sideEffectsNeedReview!==false)throw new Error('可信检查证据不完整');
    for(const ref of [c.outputRef,c.log?.stdoutRef,c.log?.stderrRef]){const saved=ref?row<{body:string;sha256:string;created_at:string}>('SELECT body,sha256,created_at FROM assistant_outputs WHERE id=? AND session_id=?',ref,d.sessionId):null;if(!saved||sha(saved.body)!==saved.sha256||(String(ref).startsWith('log-')&&Date.parse(saved.created_at)<Date.parse(now())-logLimits.retentionDays*86400000))throw new Error('必要检查或日志证据不可读取或已过期');}
    if(c.log?.complete!==true)throw new Error('检查日志不完整，不能正式验收');
   }
  }
 }
 function view(s:Session,d:Delivery){let staleReason:string|null=null;try{deps.admit(s);if(d.finalRef)snapshot(d.finalRef);if(d.baselineRef)snapshot(d.baselineRef);if(d.fingerprint&&(!deps.root||(deps.fingerprint?.(s)??projectFingerprint(deps.root(s.project_id)))!==d.fingerprint))staleReason='工作区已变化';if(d.requiresVerification){const v=deps.verification(s);if(v.contract?.version!==d.verification.contract?.version)staleReason='验收契约已变化';else if(v.verificationStatus!=='verified'&&!entries(s,'delivery_changes_requested').some(e=>e.deliveryId===d.id))staleReason??='当前可信检查尚未通过';evidenceCurrent(d);}}catch(e){staleReason=e instanceof Error?e.message:'交付资料不可用';}
  const accepted=entries(s,'delivery_accepted').find(e=>e.deliveryId===d.id),feedback=entries(s,'delivery_changes_requested').filter(e=>e.deliveryId===d.id);const latest=entries(s,'delivery_record').filter(e=>e.taskId===d.taskId).at(-1);if(latest?.id!==d.id)staleReason??='已有新交付版本';if(current(s.id)?.id!==d.taskId)staleReason??='当前已是其他任务';
  return {...d,status:staleReason?'stale':feedback.length?'changes_requested':accepted?'accepted':'awaiting_review',staleReason,historicalAcceptance:accepted??null,feedback};
 }
 function state(s:Session){const task=current(s.id),all=entries(s,'delivery_record'),records=all.filter(e=>e.taskId===task?.id);const last=records.at(-1);return {task,legacyScopeUnknown:!task,baselineReady:!!baseline(s),latestDelivery:last?view(s,last as Delivery):null,history:all.map(d=>({id:d.id,taskId:d.taskId,description:d.description,version:d.version,createdAt:d.createdAt})),limits:reviewLimits};}
 function readFile(s:Session,id:string,args:Record<string,unknown>){const d=get(s,id);if(args.version!==d.version)throw new Error('交付版本不匹配');const data=snapshot(args.side==='before'?d.baselineRef:args.side==='after'?d.finalRef:null),file=data.files.find(f=>f.path===args.path);if(!file)throw new Error('文件不在冻结审阅范围');if(file.content===undefined)return {path:file.path,sha256:file.sha256,detail:file.detail,text:null,nextOffset:null};const offset=Number(args.offset??0),limit=6000;if(!Number.isSafeInteger(offset)||offset<0||(offset>0&&/[\uDC00-\uDFFF]/.test(file.content[offset]??'')))throw new Error('片段偏移无效');let end=Math.min(file.content.length,offset+limit);if(end<file.content.length&&/[\uDC00-\uDFFF]/.test(file.content[end]??''))end--;return {path:file.path,sha256:file.sha256,detail:file.detail,text:file.content.slice(offset,end),nextOffset:end<file.content.length?end:null};}
 function decide(s:Session,input:Record<string,unknown>){
  const d=get(s,text(input.deliveryId,100));if(input.deliveryVersion!==d.version||current(s.id)?.id!==d.taskId)throw new Error('交付版本或当前任务已变化，请重新审阅');const action=String(input.action);if(!['accept','request_changes'].includes(action))throw new Error('审阅动作无效');
  const requestId=text(input.requestId,100),kind=action==='accept'?'delivery_accepted':'delivery_changes_requested',comment=action==='request_changes'?text(input.comment,4000):'';const prior=['delivery_accepted','delivery_changes_requested'].flatMap(k=>entries(s,k).map(e=>({...e,kind:k}))).find(e=>e.requestId===requestId);if(prior){if(prior.kind!==kind||prior.deliveryId!==d.id||prior.comment!==comment)throw new Error('重复请求内容不匹配');return view(s,d);}
  if(input.version!==s.version)throw new Error('会话版本已变化，请刷新后审阅');deps.admit(s);if(entries(s,'delivery_record').filter(e=>e.taskId===d.taskId).at(-1)?.id!==d.id)throw new Error('已有新交付版本，请重新审阅');const feedback=entries(s,'delivery_changes_requested').some(e=>e.deliveryId===d.id);if(action==='accept'){
   const v=view(s,d);if(v.staleReason||feedback)throw new Error(v.staleReason??'该版本已请求修改，请审阅新版本');if(d.requiresVerification){const current=deps.verification(s);if(current.verificationStatus!=='verified'||d.verification.verificationStatus!=='verified')throw new Error('当前交付未通过可信验证');evidenceCurrent(d);}

   if(d.finalRef){const current=reviewSnapshot(deps.root!(s.project_id),deps.artifacts?.(s));if(current.manifest!==d.manifest||current.fingerprint!==d.fingerprint)throw new Error('确认时内容已变化，请重新审阅');}
  }
  return transaction(()=>{if(action==='accept'&&entries(s,'delivery_accepted').some(e=>e.deliveryId===d.id))return view(s,d);event(s,'user',kind,{deliveryId:d.id,deliveryVersion:d.version,taskId:d.taskId,requestId,comment,at:now()});const changed=db.prepare("UPDATE assistant_sessions SET version=version+1,status=?,steps=0 WHERE id=? AND version=?").run(action==='request_changes'?'idle':s.status,s.id,s.version);if(changed.changes!==1)throw new Error('会话状态写入未确认，未保存验收');return view(s,d);});
 }
 return {current,start,ensureBaseline,observe,freeze,state,get:(s:Session,id:string)=>view(s,get(s,id)),readFile,decide};
}
