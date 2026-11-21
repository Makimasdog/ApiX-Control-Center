import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const evaluationSchemaVersion=1;
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');

export function redactEvidence(value,secrets=[]){
  const protectedValues=[...new Set(secrets.filter(v=>typeof v==='string'&&v.length>0))].sort((a,b)=>b.length-a.length);
  function clean(item){
    if(typeof item==='string'){for(const secret of protectedValues)item=item.split(secret).join('<redacted>');return item;}
    if(Array.isArray(item))return item.map(clean);
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).filter(([key])=>!['thinking','reasoning_content','native_session_id','nativeSessionId','configFingerprint'].includes(key)).map(([key,v])=>[key,/^(authorization|apiKey|token|password|secret|env)$/i.test(key)?'<redacted>':clean(v)]));
    return item;
  }
  return clean(value);
}

export function assertion(id,actual,expected,refs=[]){
  return {id,actual,expected,status:actual===undefined||actual===null?'unknown':isDeepStrictEqual(actual,expected)?'pass':'fail',refs};
}

export function caseStatus(assertions){
  if(assertions.some(a=>a.status==='fail'))return 'fail';
  return !assertions.length||assertions.some(a=>a.status==='unknown')?'unknown':'pass';
}

export function normalizeCoding(report){
  if(!Array.isArray(report.results))throw new Error('Coding report.results must be an array');
  return report.results.map(r=>{
    if(typeof r.taskId!=='string')throw new Error('Coding taskId required');
    const checks=[assertion('runtime-verified',r.runtimeVerified,true),assertion('frozen-task-correct',r.independentTaskSuccess,true),assertion('required-trace',r.finalAttempt?.tracePassed,true),assertion('processes-ended',r.finalAttempt?.independent?.evidence?.processesEnded,true)];
    const events=(r.events??[]).map(e=>({source:'assistant_events',eventId:e.id,sessionId:e.session_id,kind:e.kind,role:e.role,body:e.body}));
    const verificationContracts=events.filter(e=>e.kind==='verification_contract').map(e=>({eventId:e.eventId,checks:e.body.checks,runtime:e.body.runtime,authorized:e.body.authorized}));
    return {schemaVersion:evaluationSchemaVersion,caseId:'coding-'+r.taskId,attemptId:digest([report.repositoryHead,r.artifacts?.database,r.taskId]).slice(0,16),scenarioVersion:report.taskSet?.version??'coding-small-v1',runType:r.runType??report.mode,status:r.status==='not_run'?'not_run':caseStatus(checks),assertions:checks,events,verificationContracts,query:report.taskSet?.tasks?.find(t=>t.id===r.taskId)?.goal??null,toolDefinitions:report.toolDefinitions??null,sourceReportSha256:digest(report),repositoryHead:report.repositoryHead,sourceHashes:report.sourceHashes,artifacts:r.artifacts??{},semanticStatus:'not_run'};
  });
}

export function normalizeCollaboration(report){
  if(typeof report.caseId!=='string'||!Array.isArray(report.checks))throw new Error('Invalid collaboration report');
  const checks=report.checks.map(c=>assertion(c.id,c.actual,c.expected,c.refs));
  if(report.status==='fail'&&!checks.some(c=>c.status==='fail'))checks.push(assertion('scenario-execution',report.error??'incomplete','completed'));
  const s=report.artifacts?.session;
  return {schemaVersion:evaluationSchemaVersion,caseId:report.caseId,attemptId:digest([report.caseId,report.artifacts?.directory]).slice(0,16),scenarioVersion:report.scenarioVersion,runType:report.runType,status:caseStatus(checks),assertions:checks,events:(s?.turns??[]).map(t=>({source:'coordination_turns',eventId:t.id,sessionId:s.id,kind:t.kind,role:t.role,body:{content:t.content}})),tasks:(s?.tasks??[]).map(t=>({id:t.id,employeeId:t.employee_id,status:t.status,dependencies:s.dependencies?.filter(e=>e.task_id===t.id).map(e=>e.depends_on_id)??null})),runs:report.artifacts?.runs??[],sourceReportSha256:digest(report),artifacts:{directory:report.artifacts?.directory,sessionId:s?.id},error:report.error??null,semanticStatus:'not_run'};
}

export function findingsFor(record){
  if(record.status==='not_run')return [];
  return record.assertions.filter(a=>a.status!=='pass').map(a=>{
    const category=/process|stop|depend|branch|run|session|dispatch|guidance|reassign/.test(a.id)?'ORCHESTRATION_RUNTIME':/frozen|content|code|transfer/.test(a.id)?'IMPLEMENTATION_DELIVERY':'EVAL_PIPELINE';
    return {findingId:record.caseId+':'+a.id,caseId:record.caseId,attemptId:record.attemptId,status:'open',category,confidence:a.status==='unknown'?'unknown':'confirmed',observation:{assertion:a.id,actual:a.actual??null,expected:a.expected},evidenceRefs:a.refs,firstDeviationEventId:null,rootCause:'Requires source/trace investigation; assertion failure alone does not establish a code root cause',reproduce:{caseId:record.caseId,runType:record.runType},regressionCaseId:record.caseId};
  });
}
