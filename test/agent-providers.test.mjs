import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createAgentProviders,providerProtocols} from '../src/models/agent-providers.mjs';
import {modelCredentials} from '../src/infrastructure/model-credentials.mjs';

function fixture(work){
  const db=new DatabaseSync(':memory:'),dir=mkdtempSync(join(tmpdir(),'apix-providers-')),env={};
  db.exec(`CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT,runtime TEXT,deleted_at TEXT);CREATE TABLE tasks(id TEXT,employee_id TEXT,status TEXT);CREATE TABLE runs(id TEXT,task_id TEXT,status TEXT,ended_at TEXT);CREATE TABLE profiles(id TEXT PRIMARY KEY,body TEXT);`);
  for(const runtime of Object.keys(providerProtocols).filter(r=>r!=='apix')){db.prepare('INSERT INTO employees VALUES (?,?,?,NULL)').run(runtime,runtime,runtime);db.prepare('INSERT INTO profiles VALUES (?,?)').run(runtime,JSON.stringify({model:'old-model',version:0,pricing:{model:'old-model'},accountId:'old-api'}));}
  const store={db,row:(sql,...p)=>db.prepare(sql).get(...p),rows:(sql,...p)=>db.prepare(sql).all(...p),now:()=>new Date().toISOString()};
  let manager={provider:'apix-custom',model:'legacy',baseUrl:'https://old.invalid',apiType:'openai-completions',apiKeyEnv:''};
  const deps={...store,dataDir:dir,environment:env,credentials:modelCredentials(dir,env),profile:id=>JSON.parse(store.row('SELECT body FROM profiles WHERE id=?',id).body),saveProfile:(id,p)=>{db.prepare('UPDATE profiles SET body=? WHERE id=?').run(JSON.stringify({...p,version:p.version+1}),id);},managerSettings:()=>manager,saveManager:s=>manager={...s,provider:'apix-custom'}};
  const service=createAgentProviders(deps);
  const save=(apiType='openai-responses',extra={})=>service.save({version:0,name:'Test provider',model:'test-model',baseUrl:'https://api.example.invalid/v1',apiKey:'fixture-secret-only',apiType,...extra});
  const bind=(id,p)=>service.bind({agentId:id,version:service.list().agents.find(a=>a.id===id).version,providerId:p?.id??null,providerVersion:p?.version});
  try{return work({db,dir,env,deps,service,store,save,bind,restart:()=>createAgentProviders(deps)});}finally{db.close();assert(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true});}
}

test('declared context window is validated, applied to ApiX and retained through edits',()=>fixture(({service,save,bind,deps})=>{
  const provider=save('openai-completions',{contextWindow:64000});bind('apix',provider);assert.equal(deps.managerSettings().contextWindow,64000);
  const changed=service.save({...provider,name:'Changed',contextWindow:128000});assert.equal(deps.managerSettings().contextWindow,128000);assert.equal(service.list().agents.find(a=>a.id==='apix').providerId,provider.id);
  assert.throws(()=>service.save({...changed,contextWindow:1000}),/上下文窗口/);assert.equal(deps.managerSettings().contextWindow,128000);
}));
test('CRUD persists private key references, never echoes secrets, rejects stale edits and endpoint credential reuse',()=>fixture(({service,save,restart})=>{
  const p=save();assert(!JSON.stringify(service.list()).includes('fixture-secret'));assert.equal(p.hasKey,true);assert(!('keyRef' in p));assert.deepEqual(restart().list(),service.list());
  assert.throws(()=>service.save({...p,version:0}),/变化/);assert.throws(()=>service.save({...p,baseUrl:'https://elsewhere.invalid'}),/重新填写密钥/);assert.throws(()=>service.save({...p,baseUrl:'http://127.0.0.1:11434/v1'}),/重新填写密钥/);
  const edited=service.save({...p,name:'renamed'});assert.equal(edited.version,2);assert.throws(()=>service.remove(p),/变化/);service.remove(edited);assert.equal(service.list().providers.length,0);
}));
test('bindings enforce protocols, preserve run boundaries and clear old cost assumptions atomically',()=>fixture(({db,deps,service,save,bind})=>{
  const p=save();assert.throws(()=>bind('claude',p),/不兼容/);bind('codex',p);assert.equal(deps.profile('codex').model,p.model);assert.equal(deps.profile('codex').pricing,null);assert.equal(deps.profile('codex').accountId,null);
  assert.throws(()=>service.remove(p),/正在使用/);assert.throws(()=>service.assertModel('codex','wrong'),/供应商中心/);
  for(const state of ['running','starting','stopping','unknown','queued','awaiting_approval','completed']){db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('t','codex',state);assert.throws(()=>bind('codex',null),/任务/);assert.throws(()=>service.save({...p,name:'edit'}),/任务/);db.exec('DELETE FROM tasks');}
  bind('codex',null);assert.equal(deps.profile('codex').model,'');service.remove(p);
}));
test('all built-in workers receive only their selected credentials; Codex CLI args contain no API key',()=>fixture(({service,save,bind,env,dir})=>{
  for(const runtime of Object.keys(providerProtocols).filter(r=>r!=='apix')){
    const apiType=providerProtocols[runtime][0],key='secret-for-'+runtime,p=save(apiType,{apiKey:key});bind(runtime,p);
    const source={...env,PATH:'keep',OPENAI_API_KEY:'ambient-openai',OPENAI_BASE_URL:'https://ambient.invalid',ANTHROPIC_AUTH_TOKEN:'ambient-claude',APIX_AGENT_TOKEN:'stale',APIX_PROVIDER_KEY:'stale-key'};
    const original=structuredClone(source),prepared=service.prepare(runtime,runtime,source,service.keyNames());assert.deepEqual(source,original);
    assert.equal(prepared.env.PATH,'keep');assert(!JSON.stringify(prepared.args).includes(key));assert(!JSON.stringify(prepared.env).includes('ambient-'));assert(!JSON.stringify(prepared.env).includes('stale'));
    assert(!JSON.stringify(prepared.env).includes('APIX_MANAGER_KEY_'));assert.equal(prepared.provider.id,p.id);
    if(runtime==='codex'){assert.equal(prepared.env.APIX_PROVIDER_KEY,key);assert(prepared.args.includes('model_providers.apix.env_key="APIX_PROVIDER_KEY"'));}
    if(runtime==='claude'){assert.equal(prepared.env.ANTHROPIC_BASE_URL,p.baseUrl);const settings=JSON.parse(readFileSync(prepared.args[prepared.args.indexOf('--settings')+1],'utf8'));assert.equal(settings.env.ANTHROPIC_API_KEY,key);assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,'');assert.equal(JSON.parse(readFileSync(prepared.consultSettings,'utf8')).disableAllHooks,true);}
    if(runtime==='pi'){const file=readFileSync(join(prepared.env.PI_CODING_AGENT_DIR,'models.json'),'utf8');assert(!file.includes(key));assert.equal(JSON.parse(file).providers.apix.models[0].id,p.model);}
    if(runtime==='kimi')assert.equal(prepared.env.KIMI_MODEL_NAME,p.model);
  }
}));
test('official Codex login clears API routes and explicitly pins official provider and ChatGPT authentication',()=>fixture(({service,save,bind,env})=>{
  const p=save('codex-login',{apiKey:'',baseUrl:''});bind('codex',p);assert.equal(p.hasKey,false);
  const config=service.prepare('codex','codex',{...env,OPENAI_API_KEY:'ambient-key',OPENAI_BASE_URL:'https://heyroute.invalid',CODEX_API_KEY:'old'},[]);
  assert(!JSON.stringify(config.env).includes('ambient-key'));assert(!JSON.stringify(config.env).includes('heyroute'));assert(config.args.includes('forced_login_method="chatgpt"'));assert(config.args.includes('model_provider="openai"'));
}));
test('ApiX binding uses existing model settings and tracks profile edits without silently changing conversation snapshots',()=>fixture(({service,save,bind,deps})=>{
  const p=save('openai-completions');bind('apix',p);assert.equal(service.list().agents[0].providerId,p.id);assert.equal(deps.managerSettings().baseUrl,p.baseUrl);
  const edited=service.save({...p,model:'new-model'});assert.equal(deps.managerSettings().model,'new-model');assert.equal(service.list().agents[0].providerId,p.id);assert.throws(()=>service.remove(edited),/正在使用/);
  assert.throws(()=>bind('apix',save('codex-login',{apiKey:''})),/不兼容/);
}));
test('existing ApiX settings are adopted once and loopback providers work without a key',()=>fixture(({service,deps,save,bind,env})=>{
  deps.saveManager({provider:'apix-custom',model:'legacy-local',baseUrl:'http://127.0.0.1:11434/v1',apiType:'openai-completions',apiKeyEnv:''});
  const adopted=service.adopt();assert.equal(adopted.providers.length,1);assert.equal(adopted.agents[0].providerId,adopted.providers[0].id);assert.equal(adopted.providers[0].hasKey,false);assert.equal(adopted.agents[0].adoptable,false);
  assert.equal(service.adopt().providers.length,1);assert.throws(()=>service.remove(adopted.providers[0]),/正在使用/);
  const local=save('openai-responses',{baseUrl:'http://127.0.0.1:11434/v1',apiKey:''});bind('codex',local);
  const prepared=service.prepare('codex','codex',{PATH:'keep'},service.keyNames());assert.equal(prepared.env.APIX_PROVIDER_KEY,'');
  assert.throws(()=>save('openai-completions',{apiKey:''}),/API Key/);
}));
test('invalid URLs, keys and unsupported protocols cannot alter existing settings',()=>fixture(({save})=>{
  for(const baseUrl of ['file:///secret','https://user:pass@example.com','https://example.com?api_key=secret','bad'])assert.throws(()=>save('openai-responses',{baseUrl}));
  assert.throws(()=>save('openai-responses',{apiKey:'bad\nkey'}));assert.throws(()=>save('openai-responses',{apiKey:''}));assert.throws(()=>save('unknown'));
}));
test('deleted employees do not permanently pin unused providers, while uncertain processes still prevent rebinding',()=>fixture(({db,service,save,bind})=>{
  const p=save();bind('codex',p);db.exec("INSERT INTO tasks VALUES ('t','codex','failed');INSERT INTO runs VALUES ('r','t','failed',NULL)");assert.throws(()=>bind('codex',null),/任务/);
  db.exec("UPDATE runs SET ended_at='ended';UPDATE employees SET deleted_at='deleted' WHERE id='codex'");service.remove(p);assert.equal(service.list().providers.length,0);
}));
test('Anthropic API key and Claude bearer authentication are explicit and mutually exclusive',()=>fixture(({service,save,bind,env})=>{
  const direct=save('anthropic-messages');bind('claude',direct);let prepared=service.prepare('claude','claude',env,service.keyNames());assert.equal(prepared.env.ANTHROPIC_API_KEY,'fixture-secret-only');assert.equal(prepared.env.ANTHROPIC_AUTH_TOKEN,undefined);
  const relay=save('anthropic-messages',{authHeader:'bearer'});bind('claude',relay);prepared=service.prepare('claude','claude',env,service.keyNames());assert.equal(prepared.env.ANTHROPIC_AUTH_TOKEN,'fixture-secret-only');assert.equal(prepared.env.ANTHROPIC_API_KEY,undefined);
  assert.throws(()=>bind('apix',relay),/不兼容/);assert.throws(()=>bind('pi',relay),/不兼容/);
}));
test('failed multi-employee profile updates roll back previous bindings and model changes',()=>fixture(({db,service,save,bind,deps})=>{
  const p=save();bind('codex',p);bind('pi',p);db.exec("CREATE TRIGGER reject_pi BEFORE UPDATE ON profiles WHEN OLD.id='pi' BEGIN SELECT RAISE(ABORT,'fixture profile conflict'); END");
  assert.throws(()=>service.save({...p,model:'changed-model'}),/fixture profile conflict/);assert.equal(service.list().providers[0].model,p.model);assert.equal(deps.profile('codex').model,p.model);assert.equal(deps.profile('pi').model,p.model);
}));
test('credential rotation updates existing private session files without leaving temporary secrets',()=>fixture(({service,save,bind,env,dir})=>{
  const p=save('anthropic-messages');bind('claude',p);const original=service.prepare('claude','claude',env,service.keyNames());service.save({...p,apiKey:'rotated-fixture-key'});
  const prepared=service.prepare('claude','claude',env,service.keyNames());assert.equal(JSON.parse(readFileSync(prepared.consultSettings,'utf8')).env.ANTHROPIC_API_KEY,'rotated-fixture-key');assert.equal(prepared.provider.version,2);
  assert.notEqual(prepared.consultSettings,original.consultSettings);assert.equal(JSON.parse(readFileSync(original.consultSettings,'utf8')).env.ANTHROPIC_API_KEY,'fixture-secret-only');
  assert(readdirSync(join(dir,'provider-runtimes',p.id,String(prepared.provider.version),'claude')).every(name=>!name.endsWith('.tmp')));assert(!JSON.stringify(prepared.args).includes('rotated-fixture-key'));
}));
