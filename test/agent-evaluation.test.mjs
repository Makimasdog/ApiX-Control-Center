import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {assertion,caseStatus,normalizeCoding,normalizeCollaboration,findingsFor,redactEvidence} from '../src/evaluation/evidence.mjs';
import {startEvaluationGateway} from '../src/evaluation/model-gateway.mjs';

test('hard evidence distinguishes false completion, unknown and expected rejected operations',()=>{
 const report={mode:'deterministic',results:[{taskId:'logic',runtimeVerified:true,independentTaskSuccess:false,finalAttempt:{tracePassed:true,independent:{evidence:{processesEnded:true}}},events:[{id:17,kind:'tool_result',body:{ok:false,error:'expected conflict'}}]}]};
 const [failed]=normalizeCoding(report);assert.equal(failed.status,'fail');assert.equal(failed.events[0].eventId,17);assert.equal(findingsFor(failed)[0].category,'IMPLEMENTATION_DELIVERY');assert.equal(findingsFor(failed)[0].firstDeviationEventId,null);
 report.results[0].independentTaskSuccess=null;assert.equal(normalizeCoding(report)[0].status,'unknown');
 report.results[0].status='not_run';assert.deepEqual(findingsFor(normalizeCoding(report)[0]),[]);delete report.results[0].status;
 const recovered=normalizeCollaboration({caseId:'conflict-recovered',status:'pass',checks:[{id:'preserves-user-edit',actual:true,expected:true}],artifacts:{}});assert.equal(recovered.status,'pass');assert.deepEqual(findingsFor(recovered),[]);
 assert.equal(caseStatus([]),'unknown');assert.equal(assertion('unknown',null,true).status,'unknown');
 assert.throws(()=>normalizeCoding({results:{}}));assert.throws(()=>normalizeCollaboration({caseId:'broken'}));
 const dag=normalizeCollaboration({caseId:'dag',status:'pass',checks:[{id:'accepted',actual:true,expected:true}],artifacts:{session:{id:'session',tasks:[{id:'a'},{id:'b'}],dependencies:[{task_id:'b',depends_on_id:'a'}]}}});assert.deepEqual(dag.tasks.map(t=>t.dependencies),[[],['a']]);
 report.results[0].events.push({id:18,kind:'verification_contract',body:{checks:[{id:'unit',args:['check.cjs']}],runtime:{executable:'node'},authorized:true}});assert.equal(normalizeCoding(report)[0].verificationContracts[0].eventId,18);
});

test('exports redact credential values and private reasoning without deleting public usage',()=>{
 const value=redactEvidence({text:'key abcdefabcdef',authorization:'Bearer xyz',nativeSessionId:'private',reasoning_content:'hidden',child:{apiKey:'sensitive',usage:{inputTokens:8}}},['abcdefabcdef']);
 assert.equal(value.text,'key <redacted>');assert.equal(value.authorization,'<redacted>');assert(!('reasoning_content' in value));assert(!('nativeSessionId' in value));assert.equal(value.child.apiKey,'<redacted>');assert.equal(value.child.usage.inputTokens,8);
});

const python=process.env.APIX_EVALUATION_PYTHON??resolve('.tmp/evaluation/openjudge/venv/Scripts/python.exe');
test('installed OpenJudge evaluates pass/fail/unknown/not-run and rejects inconsistent evidence',()=>{
 assert(existsSync(python),'Install the isolated OpenJudge environment or set APIX_EVALUATION_PYTHON');
 const dir=mkdtempSync(join(tmpdir(),'apix-openjudge-test-')),input=join(dir,'cases.jsonl'),output=join(dir,'scores.json');
 const rows=[true,false,null].map((actual,i)=>({schemaVersion:1,caseId:'case-'+i,attemptId:'unit',status:actual===true?'pass':actual===false?'fail':'unknown',assertions:[assertion('actual-code',actual,true)]}));
 rows.push({...rows[0],caseId:'not-run',status:'not_run'});writeFileSync(input,rows.map(r=>JSON.stringify(r)).join('\n'));
 const run=()=>spawnSync(python,['scripts/evaluation/openjudge/evaluate.py','--input',input,'--output',output],{encoding:'utf8',windowsHide:true,timeout:30000});
 let result=run();assert.equal(result.status,1,result.stderr);const scores=JSON.parse(readFileSync(output,'utf8'));assert.deepEqual(scores.results.map(r=>r.hardStatus),['pass','fail','unknown','not_run']);assert.deepEqual(scores.results.map(r=>r.score),[1,0,null,null]);assert.equal(scores.distribution.mean,.5);
 rows[0].assertions[0].status='fail';writeFileSync(input,JSON.stringify(rows[0]));result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/inconsistent/);
});

test('judge connection failure is grader_error and preserves the hard verdict',()=>{
 const dir=mkdtempSync(join(tmpdir(),'apix-judge-failure-')),input=join(dir,'cases.jsonl'),output=join(dir,'scores.json'),config=join(dir,'judge.json');
 writeFileSync(input,JSON.stringify({schemaVersion:1,caseId:'fixture',attemptId:'unit',status:'pass',assertions:[assertion('truth',true,true)]}));
 writeFileSync(config,JSON.stringify({model:'unreachable-test-model',baseUrl:'http://127.0.0.1:9/v1',caseIds:['fixture']}));
 const result=spawnSync(python,['scripts/evaluation/openjudge/evaluate.py','--input',input,'--output',output,'--judge-config',config],{encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,1,result.stderr);const report=JSON.parse(readFileSync(output,'utf8'));assert.equal(report.results[0].hardStatus,'pass');assert.equal(report.semanticStatus,'grader_error');assert.equal(report.semanticResults[0].score,null);
});

test('budget gateway rejects wrong model, unbounded input and invalid budget without upstream requests',async()=>{
 await assert.rejects(()=>startEvaluationGateway({baseUrl:'https://other.invalid/v1',apiKey:'test',model:'deepseek-v4.1-flash-1017',maxCny:1}),/budget profile/);
 await assert.rejects(()=>startEvaluationGateway({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'test',model:'deepseek-v4.1-flash-1017',maxCny:51}),/budget/);
 const gateway=await startEvaluationGateway({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'test',model:'deepseek-v4.1-flash-1017',maxCny:.000001});
 try{
  for(const body of [{model:'different',messages:[]},{model:gateway.model,messages:[{role:'user',content:'x'.repeat(120001)}]},{model:gateway.model,messages:[{role:'user',content:'budget must reject'}]}]){
   const response=await fetch(gateway.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,400);
  }
  assert.equal(gateway.summary().requests,0);assert.equal(gateway.summary().reservedCny,0);
 }finally{await gateway.close();}
});

test('full protocol collaboration exercises parallel frozen handoff, mailbox, recovery and stop',{timeout:300000},()=>{
 const result=spawnSync(process.execPath,['scripts/evaluation/evaluate-agents.mjs','--suite','collaboration','--python',python],{encoding:'utf8',windowsHide:true,timeout:280000,maxBuffer:4*1024*1024});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);const summary=JSON.parse(result.stdout.trim().split('\n').at(-1)),batch=JSON.parse(readFileSync(join(summary.directory,'batch.json'),'utf8'));
 assert.equal(batch.records,3);assert.equal(batch.paidRequests,0);const raw=JSON.parse(readFileSync(join(summary.directory,'raw-reports.json'),'utf8'));assert(raw.every(r=>r.report.status==='pass'));assert(raw[0].report.checks.some(c=>c.id==='host-hidden-inputs'&&c.passed));assert(raw[1].report.checks.some(c=>c.id==='one-failed-one-recovered-run'&&c.passed));assert(raw[2].report.checks.some(c=>c.id==='stop-evidence-known'&&c.passed));
});
