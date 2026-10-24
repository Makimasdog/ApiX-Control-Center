import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {workerEnvironment} from '../src/infrastructure/environment.mjs';

test('.env loads quoted values, aliases the key and preserves process overrides',()=>{
  const dir=mkdtempSync(join(tmpdir(),'apix-env-'));
  try{
    const path=join(dir,'.env');writeFileSync(path,'ali_api_key="fixture-key"\nAPIX_ENV_TEST_VALUE="model name"\n');
    const script=`const {loadEnvironment}=await import(${JSON.stringify(new URL('../src/infrastructure/environment.mjs',import.meta.url).href)});loadEnvironment(process.argv[1]);console.log(JSON.stringify([process.env.APIX_ALI_API_KEY,process.env.APIX_ENV_TEST_VALUE]));`;
    const env={...process.env};delete env.APIX_ALI_API_KEY;delete env.ali_api_key;delete env.APIX_ENV_TEST_VALUE;
    let result=spawnSync(process.execPath,['--input-type=module','-e',script,path],{env,encoding:'utf8'});
    assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),['fixture-key','model name']);
    env.APIX_ALI_API_KEY='override';env.APIX_ENV_TEST_VALUE='override-model';
    result=spawnSync(process.execPath,['--input-type=module','-e',script,path],{env,encoding:'utf8'});
    assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),['override','override-model']);
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('worker environment removes manager aliases and stale run identity while preserving independent CLI credentials',()=>{
  const source={PATH:'fixture-path',HOME:'fixture-home',APIX_ALI_API_KEY:'manager-secret',ali_api_key:'manager-secret',
    aPiX_mAnAgEr_KeY:'other-manager-secret',KEY_ALIAS:'other-manager-secret',ApiX_DATA_DIR:'private-data',APIX_CUSTOM_ENTRY:'private-entry',
    APIX_AGENT_TOKEN:'old-token',APIX_PROJECT_ID:'old-project',APIX_RUN_ID:'old-run',APIX_MAILBOX_URL:'old-url',
    OPENAI_API_KEY:'worker-secret',CUSTOM_SETTING:'keep',APIX_FIXTURE_HOLD:'1'};
  const env=workerEnvironment(source,'codex','APIX_MANAGER_KEY');
  assert.deepEqual(env,{PATH:'fixture-path',HOME:'fixture-home',OPENAI_API_KEY:'worker-secret',CUSTOM_SETTING:'keep',APIX_FIXTURE_HOLD:'1'});
  assert.equal(source.APIX_AGENT_TOKEN,'old-token');
  assert(!JSON.stringify(env).includes('manager-secret'));
});

test('shared manager and worker authentication fails explicitly, independent login credentials remain available',()=>{
  for(const [runtime,key] of [['claude','ANTHROPIC_API_KEY'],['codex','OPENAI_API_KEY'],['gemini','GEMINI_API_KEY'],['pi','OPENAI_API_KEY']]) {
    assert.throws(()=>workerEnvironment({[key]:'fixture-shared'},runtime,key),/凭据共用/);
    assert.throws(()=>workerEnvironment({APIX_MANAGER_KEY:'fixture-shared',[key]:'fixture-shared'},runtime,'APIX_MANAGER_KEY'),/凭据共用/);
  }
  assert.deepEqual(workerEnvironment({ANTHROPIC_API_KEY:'manager-only',OPENAI_API_KEY:'independent-worker'},'codex','ANTHROPIC_API_KEY'),{OPENAI_API_KEY:'independent-worker'});
  assert.deepEqual(workerEnvironment({APIX_MANAGER_KEY:'manager-only',anthropic_api_key:'worker-only'},'claude','APIX_MANAGER_KEY'),{anthropic_api_key:'worker-only'});
  assert.deepEqual(workerEnvironment({PATH:'fixture'},'constructor',''),{PATH:'fixture'});
});

test('conversation snapshots keep old manager credentials and aliases out of worker environments',()=>{
 const source={PATH:'fixture',OLD_MANAGER_KEY:'old-secret',NEW_MANAGER_KEY:'new-secret',ALIAS:'old-secret',OPENAI_API_KEY:'worker-only'};
 assert.deepEqual(workerEnvironment(source,'codex',['OLD_MANAGER_KEY','NEW_MANAGER_KEY']),{PATH:'fixture',OPENAI_API_KEY:'worker-only'});
 assert.throws(()=>workerEnvironment({...source,OPENAI_API_KEY:'old-secret'},'codex',['OLD_MANAGER_KEY','NEW_MANAGER_KEY']),/凭据共用/);
});
