import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {normalizeCoding,normalizeCollaboration,redactEvidence,findingsFor,digest} from '../../src/evaluation/evidence.mjs';
import {runCollaborationScenario} from './collaboration-scenarios.mjs';
import {startEvaluationGateway} from '../../src/evaluation/model-gateway.mjs';
import {loadEnvironment} from '../../src/infrastructure/environment.mjs';
import {configuredModel} from './evaluate-coding-real.mjs';
import {homedir} from 'node:os';

export async function main(argv=process.argv.slice(2)){
  const options={suite:'all'};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--help'){console.log('Usage: npm run eval:agents -- --suite all|coding|collaboration --python <isolated python> [--real-provider --max-cny 50 --model deepseek-v4.1-flash-1017]');return 0;}
    if(argv[i]==='--real-provider'){options.real=true;continue;}
    if(!['--suite','--python','--max-cny','--model'].includes(argv[i])||!argv[i+1])throw new Error('Unknown or missing option');
    options[argv[i].slice(2)]=argv[++i];
  }
  if(!['all','coding','collaboration'].includes(options.suite))throw new Error('Invalid suite');
  const parent=resolve('.tmp/evaluation');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'batch-'));
  const records=[],raw=[],failures=[];let gateway;
  if(options.real){
    loadEnvironment();const settings=configuredModel(join(homedir(),'.apix-agent-os','apix.sqlite'));
    gateway=await startEvaluationGateway({baseUrl:settings.baseUrl,apiKey:process.env[settings.apiKeyEnv],model:options.model,maxCny:Number(options['max-cny'])});
  }
  const secrets=Object.entries(process.env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v).map(([,v])=>v);
  const save=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(redactEvidence(value,secrets),null,2));
  const sourceFiles=['src/evaluation/evidence.mjs','src/evaluation/model-gateway.mjs','scripts/evaluation/evaluate-agents.mjs','scripts/evaluation/collaboration-scenarios.mjs','scripts/evaluation/openjudge/evaluate.py','scripts/evaluation/openjudge/requirements.lock','test/evaluation-worker.mjs','test/evaluation-model.mjs'];
  save('manifest.json',{schemaVersion:1,startedAt:new Date().toISOString(),repositoryHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),sourceHashes:Object.fromEntries(sourceFiles.map(path=>[path,digest(readFileSync(path,'utf8'))])),upstreamCommit:'070f7b8f2a3144f50788a9161c509c24130fb502',mode:options.real?'mixed-real-provider-and-local-protocol':'offline',model:gateway?.model??null});
  try{
    if(options.suite!=='collaboration'){
      const execution=await command(process.execPath,['scripts/evaluation/evaluate-coding-real.mjs','--mode','deterministic','--tasks','all']);
      if(execution.code!==0)failures.push({phase:'coding_execution',code:execution.code,stderr:execution.stderr});
      const summary=JSON.parse(execution.stdout.trim());const report=JSON.parse(readFileSync(summary.report,'utf8'));
      raw.push({kind:'coding',report});records.push(...normalizeCoding(report));
    }
    if(options.suite!=='coding')for(const id of ['collaboration-diamond','collaboration-recovery','collaboration-stop']){
      const report=await runCollaborationScenario(id,{gateway:id==='collaboration-diamond'?gateway:undefined});raw.push({kind:'collaboration',report});records.push(normalizeCollaboration(report));
      console.log(JSON.stringify({caseId:id,status:report.status,error:report.error??null}));
    }
    const safe=redactEvidence(records,secrets);writeFileSync(join(directory,'cases.jsonl'),safe.map(r=>JSON.stringify(r)).join('\n')+'\n');
    save('raw-reports.json',raw);save('findings.json',safe.flatMap(findingsFor));
    const python=options.python??resolve('.tmp/evaluation/openjudge/venv/Scripts/python.exe');
    if(gateway)save('judge-config.json',{baseUrl:gateway.baseUrl,model:gateway.model,caseIds:records.filter(r=>['coding-logs','collaboration-diamond','collaboration-recovery'].includes(r.caseId)).map(r=>r.caseId)});
    const graded=await command(python,['scripts/evaluation/openjudge/evaluate.py','--input',join(directory,'cases.jsonl'),'--output',join(directory,'scores.json'),...(gateway?['--judge-config',join(directory,'judge-config.json')]:[])]);
    if(graded.code!==0)failures.push({phase:'grading',code:graded.code,stderr:graded.stderr});
  }catch(error){failures.push({phase:'evaluation',message:error.message});}
  finally{
    save('raw-reports.json',raw);
    if(gateway){save('budget.json',gateway.summary());await gateway.close();}
  }
  const status=!failures.length&&records.length>0&&records.every(r=>r.status==='pass')?'pass':'fail';
  const scores=readFileSyncSafe(join(directory,'scores.json'));
  const findings=records.flatMap(findingsFor);
  for(const failure of failures)findings.push({findingId:'pipeline:'+findings.length,category:'EVAL_PIPELINE',status:'open',confidence:'confirmed',observation:failure});
  for(const result of scores?.semanticResults??[])if(result.status==='grader_error')findings.push({findingId:result.caseId+':'+result.dimension,caseId:result.caseId,category:'EVAL_PIPELINE',status:'open',confidence:'confirmed',observation:result});
  else if(result.dimension==='collaboration_evidence'&&result.score===0)findings.push({findingId:result.caseId+':semantic-review',caseId:result.caseId,category:'SEMANTIC_REVIEW',status:'open',confidence:'suspected',observation:result});
  save('findings.json',findings);
  save('batch.json',{schemaVersion:1,status,suite:options.suite,directory,node:process.version,records:records.length,caseDigest:digest(records),failures,semanticStatus:scores?.semanticStatus??'not_run',paidRequests:gateway?.summary().requests??0});
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  writeFileSync(join(directory,'index.html'),'<!doctype html><meta charset="utf-8"><title>ApiX OpenJudge evaluation</title><h1>ApiX OpenJudge evaluation</h1><p>'+escape(status)+'</p><p><a href="batch.json">Batch</a> · <a href="scores.json">Scores</a> · <a href="findings.json">Findings</a> · <a href="cases.jsonl">Evidence</a></p><table><tr><th>Case</th><th>Mode</th><th>Hard result</th></tr>'+records.map(r=>'<tr><td>'+escape(r.caseId)+'</td><td>'+escape(r.runType)+'</td><td>'+escape(r.status)+'</td></tr>').join('')+'</table><p>Semantic scores are diagnostic and uncalibrated; human acceptance is not implied.</p>');
  console.log(JSON.stringify({status,directory,cases:records.length,failures:redactEvidence(failures,secrets)}));return status==='pass'?0:1;
}
function readFileSyncSafe(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}}

async function command(executable,args){
  return new Promise((done,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.once('error',reject);child.once('close',code=>done({code,stdout,stderr}));
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(code=>process.exitCode=code).catch(error=>{console.error(error.message);process.exitCode=1;});
