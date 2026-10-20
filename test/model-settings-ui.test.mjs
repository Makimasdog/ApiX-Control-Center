import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PROVIDERS } from '../dist/src/models/model-providers.js';
import { selectProvider, settingsDraft, settingsPayload, localLookupRequest, mergeLocalModels, connectionTestRequest } from '../dist/web/model-settings.js';
const providers=BUILTIN_PROVIDERS;
const defaults={provider:'',model:'',baseUrl:'',apiType:'openai-completions',apiKeyEnv:''};
test('connection test requires loaded, saved configuration, project and explicit fee approval',()=>{
  const draft=selectProvider('',providers);
  assert.throws(()=>connectionTestRequest(draft,providers,defaults,false,'p',true),/尚未加载/);
  assert.throws(()=>connectionTestRequest(draft,providers,defaults,true,'',true),/选择项目/);
  assert.throws(()=>connectionTestRequest(draft,providers,defaults,true,'p',false),/费用/);
  assert.throws(()=>connectionTestRequest(selectProvider('deepseek',providers),providers,defaults,true,'p',true),/先保存/);
  assert.deepEqual(connectionTestRequest(draft,providers,defaults,true,'p',true),{projectId:'p',settings:defaults,approved:true});
});
test('provider change clears custom name; actual selected model is saved',()=>{
  const deep=selectProvider('deepseek',providers);deep.customModelName='old';
  const next=selectProvider('dashscope',providers);
  assert.equal(next.customModelName,'');
  assert.equal(settingsPayload(next,providers,defaults,true).model,next.model);
});
test('URL and protocol matching preserves Responses and custom key on round trip',()=>{
  const saved={provider:'apix-custom',model:'custom-model',baseUrl:'https://api.openai.com/v1',apiType:'openai-responses',apiKeyEnv:'CUSTOM_KEY'};
  const draft=settingsDraft(saved,providers);
  assert.equal(draft.provider,'custom');
  assert.deepEqual(settingsPayload(draft,providers,saved,true),saved);
});
test('custom model and key survive preset round trip',()=>{
  const config=providers.find(p=>p.id==='deepseek');
  const saved={provider:'apix-custom',model:'custom-model',baseUrl:config.baseUrl,apiType:config.apiType,apiKeyEnv:'MY_KEY'};
  assert.deepEqual(settingsPayload(settingsDraft(saved,providers),providers,saved,true),saved);
});
test('local draft and saved config use the same provider metadata',()=>{
  const config=providers.find(p=>!p.requiresApiKey);
  assert(config);
  const draft=selectProvider(config.id,providers);const saved=settingsPayload(draft,providers,defaults,true);
  assert.deepEqual(settingsDraft(saved,providers),draft);
  assert.equal(saved.apiKeyEnv,'');
});
test('legacy Pi provider is preserved without inventing a provider from model name',()=>{
  const saved={...defaults,provider:'old-pi-provider',model:'old-model',apiKeyEnv:'OLD_KEY'};
  assert.deepEqual(settingsPayload(settingsDraft(saved,providers),providers,saved,true),saved);
  const invalid=selectProvider('custom',providers);invalid.customModel='some-model';
  assert.throws(()=>settingsPayload(invalid,providers,defaults,true),/需要 API URL/);
});
test('loading failure and unknown provider cannot overwrite settings',()=>{
  assert.throws(()=>settingsPayload(selectProvider('',providers),providers,defaults,false),/尚未加载/);
  assert.throws(()=>settingsPayload(selectProvider('',providers),providers,null,true),/尚未加载/);
  assert.throws(()=>settingsPayload({...selectProvider('',providers),provider:'missing'},providers,defaults,true),/未知/);
});
test('explicit default clears settings and directory changes drive actual selection',()=>{
  assert.deepEqual(settingsPayload(selectProvider('',providers),providers,defaults,true),defaults);
  const extra={...providers[0],id:'test-added-provider',name:'测试目录'};
  const changed=[extra];assert.equal(selectProvider(extra.id,changed).provider,extra.id);
  assert.throws(()=>selectProvider('deepseek',changed),/未知/);
});

test('local lookup uses the current unsaved address and only OpenAI-compatible loopback services',()=>{
  const draft=selectProvider('local-ollama',providers);
  assert.deepEqual(localLookupRequest(draft,providers),{baseUrl:'http://127.0.0.1:11434/v1',apiKeyEnv:''});
  const custom={...selectProvider('custom',providers),baseUrl:'http://[::1]:1234/v1',customApiKeyEnv:'LOCAL_KEY'};
  assert.deepEqual(localLookupRequest(custom,providers),{baseUrl:custom.baseUrl,apiKeyEnv:'LOCAL_KEY'});
  for(const baseUrl of ['https://example.invalid/v1','http://localhost.example.invalid/v1','http://user:secret@localhost/v1','http://localhost/v1?q=x'])assert.equal(localLookupRequest({...custom,baseUrl},providers),null);
  assert.equal(localLookupRequest({...custom,apiType:'anthropic-messages'},providers),null);
});
test('discovery preserves a manually selected model, including when directory is empty',()=>{
  const models=[{id:'actual-model',name:'actual-model'}];
  assert.deepEqual(mergeLocalModels(models,'manual-model').map(m=>m.id),['manual-model','actual-model']);
  assert.equal(mergeLocalModels(models,'actual-model'),models);
  assert.deepEqual(mergeLocalModels([],'manual-model'),[{id:'manual-model',name:'manual-model（当前填写）'}]);
});
