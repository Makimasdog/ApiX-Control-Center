import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {modelCredentials} from '../src/infrastructure/model-credentials.mjs';
import {workerEnvironment} from '../src/infrastructure/environment.mjs';
import {inferModel} from '../dist/src/models/model-backend.js';
import {startDeliveryFixture} from './delivery-fixture.mjs';

test('saved keys survive restart, rotate without breaking old references, and stay out of worker environments',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'apix-key-store-'));
  try {
    const env={},store=modelCredentials(dir,env),first=store.save('fixture-secret-first'),second=store.save('fixture-secret-second');
    assert.notEqual(first,second);assert.equal(env[first],'fixture-secret-first');
    const restarted={};modelCredentials(dir,restarted);assert.deepEqual(restarted,env);
    assert.equal(workerEnvironment(restarted,'codex',second)[first],undefined);
    assert.equal(workerEnvironment(restarted,'codex',second)[second],undefined);
    for(const key of ['', 'bad key', 'bad\nkey', 'bad\0key', 'x'.repeat(8193)])assert.throws(()=>store.save(key),/格式无效/);
  } finally {assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});

test('HTTP settings accept a direct key without echoing it; saved reference authorizes inference',async()=>{
  const fixture=await startDeliveryFixture({startupMs:20000});
  const key='fixture-only-direct-secret';let authorization;
  const model=createServer(async(req,res)=>{authorization=req.headers.authorization;let raw='';for await(const chunk of req)raw+=chunk;const prompt=JSON.parse(raw).messages.at(-1).content;const content=prompt.startsWith('APIX_CONNECTION_TEST')?prompt.split('只返回 JSON：')[1]:'ok';res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));});
  await new Promise(r=>model.listen(0,'127.0.0.1',r));let keyName;
  try {
    const input={provider:'apix-custom',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'direct-key-fixture',apiType:'openai-completions',apiKey:key};
    const saved=await fixture.request('/api/manager/settings',input);keyName=saved.apiKeyEnv;
    assert.match(keyName,/^APIX_MANAGER_KEY_/);assert(!JSON.stringify(saved).includes(key));
    assert(!JSON.stringify(await fixture.request('/api/manager/settings')).includes(key));
    assert(!JSON.stringify(await fixture.request('/api/snapshot')).includes(key));
    const stored=JSON.parse(await readFile(join(fixture.dir,'data','model-credentials.json'),'utf8'));assert.equal(stored[keyName],key);
    await fixture.request('/api/manager/test',{projectId:fixture.projectId,settings:saved,approved:true});assert.equal(authorization,'Bearer '+key);
    process.env[keyName]=stored[keyName];assert.equal(await inferModel(saved,'local test'),'ok');assert.equal(authorization,'Bearer '+key);
    const retained=await fixture.request('/api/manager/settings',{...saved,model:'edited-model',apiKey:''});assert.equal(retained.apiKeyEnv,keyName);
    const invalid=await fixture.request('/api/manager/settings',{...input,apiKey:'bad\nkey'},400);assert(!JSON.stringify(invalid).includes('bad\nkey'));
    assert.equal((await fixture.request('/api/manager/settings')).apiKeyEnv,keyName);
  } finally {if(keyName)delete process.env[keyName];model.closeAllConnections();await new Promise(r=>model.close(r));await fixture.close();}
});
