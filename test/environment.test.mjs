import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('.env loads quoted values, aliases the key and preserves process overrides',()=>{
  const dir=mkdtempSync(join(tmpdir(),'apix-env-'));
  try{
    const path=join(dir,'.env');writeFileSync(path,'ali_api_key="fixture-key"\nAPIX_ENV_TEST_VALUE="model name"\n');
    const script=`const {loadEnvironment}=await import(${JSON.stringify(new URL('../src/environment.mjs',import.meta.url).href)});loadEnvironment(process.argv[1]);console.log(JSON.stringify([process.env.APIX_ALI_API_KEY,process.env.APIX_ENV_TEST_VALUE]));`;
    const env={...process.env};delete env.APIX_ALI_API_KEY;delete env.ali_api_key;delete env.APIX_ENV_TEST_VALUE;
    let result=spawnSync(process.execPath,['--input-type=module','-e',script,path],{env,encoding:'utf8'});
    assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),['fixture-key','model name']);
    env.APIX_ALI_API_KEY='override';env.APIX_ENV_TEST_VALUE='override-model';
    result=spawnSync(process.execPath,['--input-type=module','-e',script,path],{env,encoding:'utf8'});
    assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),['override','override-model']);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
