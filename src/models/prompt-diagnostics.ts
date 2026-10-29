import {createHash,randomUUID} from 'node:crypto';

export const requestHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export interface PromptDescriptor {
  schema:1;layout:'legacy-v1';generation:null;promptSha256:string;
  regions:{name:'instruction'|'tool_catalog'|'context';start:number;end:number}[];
  fields:{name:string;hash:string}[];frames:{eventId:number;hash:string}[];
}
export interface DiagnosticScope {projectId:string;sessionId:string;purpose:string;routeScopeId:string;configurationRevision?:number;previousUsageId?:string;previousProcessId?:string}
export interface TransportObservation {requestCreated:boolean;writeCompleted:boolean;responseHeaders:boolean;terminal:boolean}
export interface RequestDiagnostic {
  schema:1;processInstanceId:string;usageId:string;attempt:number;scope:DiagnosticScope;layout:string;generation:null;
  wireBodyHash:string;wireBodyBytes:number;promptSha256:string;logicalInputHash:string;systemHash:string;
  parameterHashes:Record<string,string>;carriedHistoryHash:string|null;
  baselineUsageId:string|null;comparisonState:'available'|'unavailable';baselineUnavailableReason:string|null;
  wireBodyPrefixBytes:number|null;logicalInputPrefixBytes:number|null;
  firstChangedRegion:string|null;firstChangedHostField:string|null;firstChangedEventId:number|null;
  changedHostFields:string[];historyChanges:('rewrite'|'remove'|'reorder')[];
  historyMutation:'none'|'rewrite'|'remove'|'reorder'|'unknown';changedParameters:string[];
  providerCacheCause:'unknown';transportObservation?:TransportObservation;
}
const hostFields=new Set(['toolAccess','toolLimits','policy','capabilities','currentTask','taskFeedback','latestUserRequest','initialRequest','summary','recalledMemories','memoryIndex','outputIndex','needsVerification','hasVerification','verificationState','contextBudget','contextReadPolicy','deferredTools','context','history']);
export const diagnosticHostFields=[...hostFields];
export interface RequestShape {bodyText:string;prompt:string;system:string;parameterHashes:Record<string,string>}
interface Baseline {usageId:string;wire:Buffer;prompt:Buffer;descriptor?:PromptDescriptor;metadata:RequestDiagnostic;order:number}
const prefix=(a:Buffer,b:Buffer)=>{let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;return i;};
const emptyTransport=():TransportObservation=>({requestCreated:false,writeCompleted:false,responseHeaders:false,terminal:false});
export {emptyTransport};

/** 只缓存前次比较所需字节；正文不进入持久诊断，淘汰与重启时不伪造精确前缀。 */
export function createPromptDiagnostics(maxScopes=8,maxBytes=8*1024*1024){
  if(!Number.isSafeInteger(maxScopes)||maxScopes<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('请求诊断内存限额无效');
  const processInstanceId=randomUUID();
  const baselines=new Map<string,Baseline>(),evicted=new Set<string>();let bytes=0,order=0;
  const key=(s:DiagnosticScope,layout:string)=>JSON.stringify([s.projectId,s.sessionId,s.routeScopeId,s.purpose,layout]);
  function prepare(scope:DiagnosticScope,usageId:string,attempt:number,shape:RequestShape,descriptor?:PromptDescriptor){
    if(descriptor&&(descriptor.schema!==1||descriptor.layout!=='legacy-v1'||descriptor.generation!==null||descriptor.promptSha256!==requestHash(shape.prompt)||descriptor.frames.length>201||descriptor.fields.some(f=>!hostFields.has(f.name))||descriptor.regions.some(r=>!['instruction','tool_catalog','context'].includes(r.name)||!Number.isSafeInteger(r.start)||r.start<0||r.end<r.start||r.end>Buffer.byteLength(shape.prompt))))throw new Error('宿主请求描述与实际提示词不一致');
    // 复制描述信息，调用者后续修改对象不能改写已观察的历史。
    descriptor=descriptor?JSON.parse(JSON.stringify(descriptor)):undefined;
    if(descriptor&&(descriptor.fields.length>diagnosticHostFields.length||descriptor.regions.length>3||new Set(descriptor.frames.map(f=>f.eventId)).size!==descriptor.frames.length||descriptor.frames.some(f=>!Number.isSafeInteger(f.eventId)||f.eventId<1||!/^[a-f0-9]{64}$/.test(f.hash))))throw new Error('宿主历史描述无效');
    const layout=descriptor?.layout??'opaque-v1',scopeKey=key(scope,layout),baseline=baselines.get(scopeKey);
    if(baseline){baselines.delete(scopeKey);baselines.set(scopeKey,baseline);}
    const wire=Buffer.from(shape.bodyText),prompt=Buffer.from(shape.prompt),logicalPrefix=baseline?prefix(baseline.prompt,prompt):null;
    let mutation:RequestDiagnostic['historyMutation']='unknown',eventId:number|null=null;const historyChanges:RequestDiagnostic['historyChanges']=[];
    if(baseline?.descriptor&&descriptor){
      const before=baseline.descriptor.frames,after=descriptor.frames,byId=new Map(after.map(f=>[f.eventId,f]));
      const removed=before.find(f=>!byId.has(f.eventId)),rewritten=before.find(f=>byId.has(f.eventId)&&byId.get(f.eventId)!.hash!==f.hash);
      const commonBefore=before.filter(f=>byId.has(f.eventId)).map(f=>f.eventId),oldIds=new Set(before.map(f=>f.eventId)),commonAfter=after.filter(f=>oldIds.has(f.eventId)).map(f=>f.eventId);
      mutation=removed?'remove':rewritten?'rewrite':JSON.stringify(commonBefore)!==JSON.stringify(commonAfter)?'reorder':'none';
      // 变化类型可同时存在；事件候选取最早受影响旧事件，重排则跳过未变化的共同前段。
      eventId=before.find(f=>!byId.has(f.eventId)||byId.get(f.eventId)!.hash!==f.hash)?.eventId??(mutation==='reorder'?commonAfter.find((id,i)=>id!==commonBefore[i])??null:null);
      if(removed)historyChanges.push('remove');if(rewritten)historyChanges.push('rewrite');if(JSON.stringify(commonBefore)!==JSON.stringify(commonAfter))historyChanges.push('reorder');
    }
    // 同时比较新增、改值与删除；仅遍历当前参数会漏掉被移除的推理配置。
    const changedParameters=baseline?[...new Set([...Object.keys(baseline.metadata.parameterHashes),...Object.keys(shape.parameterHashes)])].filter(k=>baseline.metadata.parameterHashes[k]!==shape.parameterHashes[k]):[];
    const changedHostFields=baseline?.descriptor&&descriptor?descriptor.fields.filter(f=>baseline.descriptor!.fields.find(old=>old.name===f.name)?.hash!==f.hash).map(f=>f.name):[];
    const unavailable=baseline?null:evicted.has(scopeKey)||scope.previousUsageId&&scope.previousProcessId===processInstanceId?'memory_budget':scope.previousUsageId?'restart':[...baselines.values()].some(b=>b.metadata.scope.sessionId===scope.sessionId)?'scope_change':'first_request';
    const metadata:RequestDiagnostic={schema:1,processInstanceId,usageId,attempt,scope:{projectId:scope.projectId,sessionId:scope.sessionId,purpose:scope.purpose,routeScopeId:scope.routeScopeId,configurationRevision:scope.configurationRevision},layout,generation:null,wireBodyHash:requestHash(wire),wireBodyBytes:wire.length,promptSha256:requestHash(prompt),logicalInputHash:requestHash(JSON.stringify([['adapter_system',shape.system],['prompt',shape.prompt]])),systemHash:requestHash(shape.system),parameterHashes:{...shape.parameterHashes},carriedHistoryHash:descriptor?requestHash(JSON.stringify(descriptor.frames)):null,baselineUsageId:baseline?.usageId??scope.previousUsageId??null,comparisonState:baseline?'available':'unavailable',baselineUnavailableReason:unavailable,wireBodyPrefixBytes:baseline?prefix(baseline.wire,wire):null,logicalInputPrefixBytes:logicalPrefix,firstChangedRegion:logicalPrefix!==null&&logicalPrefix<Math.max(prompt.length,baseline!.prompt.length)?descriptor?.regions.find(r=>logicalPrefix>=r.start&&logicalPrefix<r.end)?.name??'opaque':null,firstChangedHostField:baseline?.descriptor&&descriptor?descriptor.fields.find(f=>baseline.descriptor!.fields.find(old=>old.name===f.name)?.hash!==f.hash)?.name??null:null,firstChangedEventId:eventId,historyMutation:mutation,historyChanges,changedHostFields,changedParameters,providerCacheCause:'unknown'};
    // 冻结副本仅供回调；内部基线不与回调共享可变对象。
    const callbackValue=JSON.parse(JSON.stringify(metadata)) as RequestDiagnostic;
    Object.freeze(callbackValue.scope);Object.freeze(callbackValue.parameterHashes);Object.freeze(callbackValue.changedParameters);Object.freeze(callbackValue.changedHostFields);Object.freeze(callbackValue.historyChanges);Object.freeze(callbackValue);
    const candidate:Baseline={usageId,wire,prompt,descriptor,metadata,order:0};
    return {metadata:callbackValue,candidate,scopeKey};
  }
  function headers(value:ReturnType<typeof prepare>){value.candidate.order=++order;}
  function commit(value:ReturnType<typeof prepare>){
    const {candidate,scopeKey}=value;if(!candidate.order)return;
    const previous=baselines.get(scopeKey);if(previous&&previous.order>candidate.order)return;
    if(previous){bytes-=previous.wire.length+previous.prompt.length;baselines.delete(scopeKey);}
    const size=candidate.wire.length+candidate.prompt.length;
    if(size>maxBytes){evicted.add(scopeKey);}else{baselines.set(scopeKey,candidate);bytes+=size;evicted.delete(scopeKey);}
    while(baselines.size>maxScopes||bytes>maxBytes){const [k,b]=baselines.entries().next().value!;baselines.delete(k);bytes-=b.wire.length+b.prompt.length;evicted.add(k);}
    while(evicted.size>maxScopes)evicted.delete(evicted.values().next().value!);
  }
  return {prepare,headers,commit};
}
