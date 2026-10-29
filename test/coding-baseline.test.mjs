import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createContextOutputs} from '../dist/src/assistant/assistant-context.js';
import {toolResultSucceeded} from '../dist/web/assistant-view.js';
import {createAssistantCommands} from '../dist/src/assistant/assistant-commands.js';
import {preflightCommand,fileTool} from '../dist/src/assistant/assistant-tools.js';
import {createToolRegistry} from '../dist/src/assistant/tool-registry.js';
import {commandCapabilities} from '../dist/src/execution/command-capabilities.js';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';

function store(db){return {db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};}
test('long and short host results retain identical execution and verification decisions',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES ('s')");const outputs=createContextOutputs(store(db));let id=0;
 try{for(const facts of [{},{exitCode:2},{reason:'descendants_remaining',executionComplete:false,sideEffectsNeedReview:true},{unknown:true,processesEnded:false},{evidencePersisted:false},{passed:false}])for(const size of [20,9000]){
  const result={operationId:'op',reason:'exit',exitCode:0,unknown:false,timedOut:false,aborted:false,truncated:false,processesEnded:true,executionComplete:true,sideEffectsNeedReview:false,evidencePersisted:true,...facts,output:'x'.repeat(size)};
  const body={tool:'run_command',ok:true,result},projected=outputs.history('s',[{id:++id,role:'tool',kind:'tool_result',body:JSON.stringify(body)}])[0].body;
  assert.equal(toolResultSucceeded(projected),toolResultSucceeded(body),JSON.stringify(facts));
 }}finally{db.close();}
});
test('unsupported capabilities disable command tools but preserve file operations',()=>{
 const root=mkdtempSync(join(tmpdir(),'apix-capabilities-'));try{assert.equal(commandCapabilities('linux').managedCommands.available,false);assert.throws(()=>preflightCommand(root,{executable:'node'},'linux'),/本平台/);const registry=createToolRegistry([],false);assert.equal(registry.get('run_check'),undefined);assert(registry.get('read_file'));fileTool(root,'write_file',{path:'a',content:'available'});assert.equal(fileTool(root,'read_file',{path:'a'}).content,'available');}finally{assert(resolve(root).startsWith(resolve(tmpdir())));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
test('invalid executable is a known rejection before any intent or process uncertainty',async()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY,project_id TEXT);INSERT INTO assistant_sessions VALUES ('s','p');CREATE TABLE assistant_events(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,kind TEXT,body TEXT,created_at TEXT)");
 const bridge=createAssistantCommands({...store(db),root:()=>process.cwd(),env:()=>process.env,protectedValues:()=>[],policy:()=>({version:1,mode:'full_access'})});
 try{await assert.rejects(bridge.execute({id:'s',project_id:'p'},'run_command',{executable:'   '},new AbortController().signal),e=>{assert.notEqual(e.code,'COMMAND_LIFECYCLE_UNKNOWN');return true;});assert.equal(db.prepare('SELECT count(*) n FROM assistant_events').get().n,0);bridge.assertClear({id:'s',project_id:'p'});}finally{db.close();}
});
test('versioned command summaries fail closed on missing facts without condemning legacy reads',()=>{
 assert.equal(toolResultSucceeded({ok:true,result:{content:'legacy read'}}),true);
 const facts={hostResultVersion:1,operationId:'op',reason:'exit',exitCode:0,timedOut:false,aborted:false,unknown:false,processesEnded:true,executionComplete:true,sideEffectsNeedReview:false,evidencePersisted:true};
 assert.equal(toolResultSucceeded({result:{...facts,truncated:true}}),true);
 for(const key of Object.keys(facts)){if(key==='hostResultVersion')continue;const missing={...facts};delete missing[key];assert.equal(toolResultSucceeded({result:missing}),false,key);}
});
test('a long source read keeps its source SHA and cursor distinct from the saved JSON digest',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES ('s')");try{const outputs=createContextOutputs(store(db)),result={path:'large.ts',content:'x'.repeat(9000),sha256:'f'.repeat(64),nextCursor:'source-page',hasMore:true,byteBudget:16000};const r=outputs.history('s',[{id:1,role:'tool',kind:'tool_result',body:JSON.stringify({tool:'read_file',ok:true,result})}])[0].body.result;assert.equal(r.sha256,result.sha256);assert.equal(r.nextCursor,'source-page');assert.notEqual(r.savedResultSha256,r.sha256);}finally{db.close();}
});
