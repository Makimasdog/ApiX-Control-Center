import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PROVIDERS } from '../dist/src/model-providers.js';
import { selectProvider, settingsDraft, settingsPayload } from '../dist/web/model-settings.js';
const providers=BUILTIN_PROVIDERS;
const defaults={provider:'',model:'',baseUrl:'',apiType:'openai-completions',apiKeyEnv:''};
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
