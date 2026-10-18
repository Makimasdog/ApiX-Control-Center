// Explicit operator opt-in only. Uses production runtime factories and an isolated workspace/ledger.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {loadEnvironment,workerEnvironment} from '../src/environment.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function artifactJson(value,secrets){
 const values=[...new Set(secrets.filter(Boolean))].sort((a,b)=>b.length-a.length);
 const clean=v=>{if(typeof v==='string'){for(const secret of values)v=v.split(secret).join('<redacted>');return v;}if(Array.isArray(v))return v.map(clean);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,item])=>[k,clean(item)]));return v;};
 return JSON.stringify(clean(value),null,2);
}
export function validateApproval(a,settingsSha256){
 if(!a||a.approveSpend!==true||a.approveWorkspace!==true||a.approveChecks!==true||a.providerBudgetConfirmed!==true||a.settingsSha256!==settingsSha256)throw new Error('Explicit spend/workspace/check approval, provider budget confirmation and matching settingsSha256 are required');
 for(const [key,max] of [['maxMinor',1000000000],['perRequestUpperBoundMinor',1000000000],['maxRequests',24],['maxMinutes',30]])if(!Number.isSafeInteger(a[key])||a[key]<1||a[key]>max)throw new Error('Invalid approval bound: '+key);
 if(!/^[A-Z]{3}$/.test(a.currency)||a.perRequestUpperBoundMinor>a.maxMinor)throw new Error('Invalid currency or reservation bound');
 return a;
}
export function configuredModel(path,sessionId){
 if(!existsSync(path))throw new Error('Settings database does not exist; no request sent');
 const db=new DatabaseSync(path,{readOnly:true});
 try{if(sessionId){const row=db.prepare("SELECT settings FROM conversation_models WHERE kind='assistant' AND session_id=?").get(sessionId);if(!row)throw new Error('Configured assistant session does not exist');return JSON.parse(row.settings);}
 const row=db.prepare('SELECT provider,model,base_url AS baseUrl,api_type AS apiType,api_key_env AS apiKeyEnv FROM apix_manager_settings WHERE id=1').get();if(!row)throw new Error('No configured model');return row;}finally{db.close();}
}
export async function main(argv=process.argv.slice(2)){
 const options={};for(let i=0;i<argv.length;i++){const k=argv[i];if(['--help','--inspect'].includes(k))options[k]=true;else if(['--settings-db','--session-id','--approval'].includes(k)&&argv[i+1]&&!argv[i+1].startsWith('--'))options[k]=argv[++i];else throw new Error('Unknown or missing option');}
 if(options['--help']){console.log('Usage: npm run eval:coding:real -- --inspect [--settings-db path] [--session-id id]\nThen: --approval manifest.json (same settings options). No request without approval.\nManifest: approveSpend/approveWorkspace/approveChecks/providerBudgetConfirmed=true, settingsSha256, currency, maxMinor, perRequestUpperBoundMinor, maxRequests<=24, maxMinutes<=30.\nProvider budget must be enforced on the provider account; runtime reservations are estimates, not measured billing. Artifacts remain in an owned temporary directory.');return 0;}
 if(!options['--inspect']&&!options['--approval']){console.log(JSON.stringify({status:'not_run',requests:0,reason:'explicit_approval_required'}));return 2;}
 loadEnvironment();const settings=configuredModel(options['--settings-db']??join(process.env.APIX_DATA_DIR??join(homedir(),'.apix-agent-os'),'apix.sqlite'),options['--session-id']);
 const settingsSha256=sha(JSON.stringify(settings));const publicSettings={provider:settings.provider,model:settings.model,apiType:settings.apiType,baseOrigin:new URL(settings.baseUrl).origin,reasoningEffort:settings.reasoningEffort??null,settingsSha256,credentialPresent:!!process.env[settings.apiKeyEnv]};
 if(options['--inspect']){console.log(JSON.stringify({status:'not_run',requests:0,settings:publicSettings}));return 0;}
 const approval=validateApproval(JSON.parse(readFileSync(options['--approval'],'utf8')),settingsSha256);
 const {inferModel,directModelSettings}=await import('../dist/src/model-backend.js');directModelSettings(settings); // Reject absent credentials before creating a task.
 const {commandCapabilities}=await import('../dist/src/command-capabilities.js');if(!commandCapabilities().managedCommands.available)throw new Error('Managed commands unavailable on this platform');
 const [{createAssistantLoop},{createAssistantCoding},{createAssistantCommands},{createAssistantInference},{createScheduling},{projectFingerprint}]=await Promise.all(['assistant-loop','assistant-coding','assistant-commands','assistant-inference','scheduling','assistant-tools'].map(x=>import('../dist/src/'+x+'.js')));
 const dir=mkdtempSync(join(tmpdir(),'apix-real-coding-')),root=join(dir,'workspace');mkdirSync(join(root,'src'),{recursive:true});
 const initial='module.exports=(a,b)=>a-b; // BUG:add\n',check="require('node:assert/strict').equal(require('./src/add.cjs')(2,3),5);console.log('approved real check passed');";
 writeFileSync(join(root,'src/add.cjs'),initial);writeFileSync(join(root,'check.cjs'),check);
 const db=new DatabaseSync(join(dir,'runtime.sqlite'));db.exec("PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p');CREATE TABLE employees(id TEXT PRIMARY KEY);CREATE TABLE tasks(id TEXT PRIMARY KEY);CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT)");
 const store={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()},policy={mode:'ask_approval',version:1};
 const safe=value=>{let s=String(value);for(const [k,v] of Object.entries(process.env))if(/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v)s=s.split(v).join('<redacted>');return s;};
 const scheduling=createScheduling(store,{employees:()=>[],available:()=>false,denied:()=>true,waiting:()=>null});scheduling.saveAccount({id:'evaluation',alias:'explicit evaluation budget',version:0,type:'api',currency:approval.currency,limitMinor:approval.maxMinor,remainingPercent:null});scheduling.savePolicy('p',{version:0,requireFreshQuota:false,currency:approval.currency,limitMinor:approval.maxMinor,managerAccountId:'evaluation',managerEstimateMinor:approval.perRequestUpperBoundMinor});
 let requests=0,sessionId;const start=Date.now(),deadline=start+approval.maxMinutes*60000;
 const inference=createAssistantInference({settings:()=>settings,account:()=> 'evaluation',reserve:(id,p)=>scheduling.reserveManager(id,p),settle:scheduling.settle,pause:scheduling.pauseAccountId,quotaFailure:m=>/insufficient_quota|rate_limit|额度不足|速率限制/.test(m),recordFailure:r=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system','inference_accounting_failure',?,?)").run(r.sessionId,JSON.stringify(r),store.now()),infer:async(prompt,_delta,context)=>{if(Date.now()>=deadline||requests>=approval.maxRequests)throw new Error('Evaluation request/time budget exhausted');requests++;return inferModel(settings,prompt,undefined,{signal:context.signal,timeoutMs:Math.min(60000,Math.max(1,deadline-Date.now()))});}});
 const commands=createAssistantCommands({...store,root:()=>root,policy:()=>policy,env:()=>workerEnvironment(process.env,'',settings.apiKeyEnv),protectedValues:()=>[process.env[settings.apiKeyEnv]].filter(Boolean)}),coding=createAssistantCoding(store,()=>root);
 const exactContract=a=>JSON.stringify(a?.writablePaths)===JSON.stringify(['src'])&&Array.isArray(a.checks)&&a.checks.length===1&&a.checks[0].id==='unit'&&JSON.stringify(a.checks[0].args)===JSON.stringify(['check.cjs'])&&a.checks[0].timeoutMs===5000;
 const allowedWrite=a=>a.path==='src/add.cjs';
 const service=createAssistantLoop({...store,policy:()=>policy,projectRoot:()=>root,fingerprint:()=>projectFingerprint(root),describe:()=>({evaluation:true,approvedCheck:{checks:[{id:'unit',args:['check.cjs'],timeoutMs:5000}],writablePaths:['src']},limits:{requests:approval.maxRequests,minutes:approval.maxMinutes}}),infer:inference,commandState:(s,phase)=>{if(phase==='resume'){commands.recover(s);coding.recover(s);}else{commands.assertClear(s,phase==='message');coding.assertClear(s,phase==='message');}},execute:(s,tool,args,signal)=>{if(['run_command','verify'].includes(tool)){if(tool!=='run_command'||args.executable!=='node'||JSON.stringify(args.args)!==JSON.stringify(['check.cjs'])||args.timeoutMs!==5000)throw new Error('Evaluation permits only the approved fixed check');return commands.execute(s,tool,args,signal);}if(tool==='read_output')return commands.readOutput(s.id,args);if(['write_file','edit_file'].includes(tool)&&!allowedWrite(args))throw new Error('Evaluation write scope exceeded');return coding.execute(s,tool,args,signal);},child:()=>({complete:false}),stopChild:()=>{}});
 let status='failed',failure=null,watchdog=false;sessionId=service.create({projectId:'p',title:'Explicit real-model small repair'}).id;
 const timer=setTimeout(()=>{watchdog=true;service.stop(sessionId);},Math.max(1,deadline-Date.now()));
 try{
  service.message(sessionId,{content:'Fix src/add.cjs addition bug. Search, read source and check.cjs, configure exactly unit/check.cjs timeoutMs=5000 writablePaths=[src], run_check before and after repair, read failed logs with read_output, edit_file using current SHA, get_diff and finish with actual evidence. Never modify check.cjs or use arbitrary commands. Formal acceptance remains with the user.'});
  let stoppingAt=null;
  while(true){const s=service.details(sessionId);if(!s.busy&&s.status==='waiting_user'){const p=s.pending,approved=p.kind==='approval'&&((p.tool==='configure_verification'&&exactContract(p.args))||(['edit_file','write_file'].includes(p.tool)&&allowedWrite(p.args))||(p.tool==='run_check'&&p.args.checkId==='unit'));db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'user','evaluation_manifest_approval',?,?)").run(sessionId,JSON.stringify({requestId:p.id,approved,manifestSha256:sha(JSON.stringify(approval))}),store.now());await service.reply(sessionId,{version:s.version,requestId:p.id,approved});if(!approved)throw new Error('Model requested an operation outside the explicit evaluation approval');}
   else if(!s.busy){status=s.status==='completed'&&s.verificationStatus==='verified'?'verified':'not_verified';break;}
   if(watchdog){stoppingAt??=Date.now();if(Date.now()-stoppingAt>15000)throw new Error('Evaluation cleanup deadline: runtime state must be reviewed; no replay');}await new Promise(r=>setTimeout(r,20));
  }
  if(watchdog)throw new Error('Evaluation watchdog fired');if(sha(readFileSync(join(root,'check.cjs')))!==sha(check))throw new Error('Approved check changed');
 }catch(e){failure=safe(e.message);service.stop(sessionId);const end=Date.now()+15000;while(service.details(sessionId).busy&&Date.now()<end)await new Promise(r=>setTimeout(r,20));if(service.details(sessionId).busy)failure+='; cleanup unconfirmed';}
 finally{
  clearTimeout(timer);const events=store.rows('SELECT * FROM assistant_events WHERE session_id=? ORDER BY id',sessionId).map(e=>({...e,body:JSON.parse(e.body)})),details=service.details(sessionId);
  const report={mode:'real_model',status,failure,settings:publicSettings,approval,requests,usage:null,actualCostMinor:null,billing:'unmeasured; estimated reservations; provider budget required',elapsedMs:Date.now()-start,task:{initialSha256:sha(initial),finalSha256:sha(readFileSync(join(root,'src/add.cjs'))),checkSha256:sha(check)},details,events,incorrectCompletionClaims:events.filter(e=>e.kind==='completion_rejected').length,ledger:scheduling.view('p').ledger,artifacts:{workspace:root,database:join(dir,'runtime.sqlite')}};
  writeFileSync(join(dir,'report.json'),artifactJson(report,[process.env[settings.apiKeyEnv],...Object.entries(process.env).filter(([k])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)).map(([,v])=>v)]));console.log(JSON.stringify({status,requests,usage:null,actualCostMinor:null,elapsedMs:report.elapsedMs,report:join(dir,'report.json')}));if(!details.busy)db.close();
 }
 return status==='verified'&&!failure?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('Evaluation not completed: inspect configuration/approval and retained runtime evidence. No sensitive error body emitted.');process.exitCode=1;});
