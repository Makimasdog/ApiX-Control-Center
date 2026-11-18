import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {digest,loadManifest,readManifest} from '../dist/src/assistant-core/skills/manifest.js';
import {sandboxJavaScript} from '../dist/src/assistant-core/skills/sandbox.js';
import {createSkillOperations} from '../dist/src/assistant-core/skills/operations.js';

const sandboxSkill={
  schema:1,id:'custom-code',version:'1.0.0',name:'Custom',description:'Evaluate a small function',
  operation:'code.run',permissions:['sandbox.javascript'],script:'return input.value * 2;',
};
test('manifest loader sees on-disk revisions immediately and validates declared permission',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'apix-agent-skill-'));
  const path=join(dir,'custom-code.json');
  try{
    await writeFile(path,JSON.stringify(sandboxSkill));
    const first=loadManifest(path,'custom-code');
    await writeFile(path,JSON.stringify({...sandboxSkill,script:'return input.value * 3;'}));
    assert.notEqual(digest(loadManifest(path,'custom-code')),digest(first));
    assert.throws(()=>loadManifest(path,'another-skill'),/标识/);
    assert.throws(()=>readManifest({...sandboxSkill,permissions:['workspace.write']}),/权限/);
    assert.throws(()=>readManifest({...sandboxSkill,script:sandboxSkill.script,command:'node'}),/未支持/);
  }finally{
    assert(resolve(dir).startsWith(resolve(tmpdir())+sep));
    await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

test('JavaScript sandbox exposes only guest objects and bounds execution',async()=>{
  const signal=new AbortController().signal;
  const result=await sandboxJavaScript('return [input.n * 2, typeof process, typeof require, typeof fetch]',{n:3},signal);
  assert.deepEqual(result,{value:[6,'undefined','undefined','undefined']});
  await assert.rejects(sandboxJavaScript('while(true){}',null,signal),/资源上限/);
  await assert.rejects(sandboxJavaScript('return "x".repeat(20000)',null,signal),/有界/);
  await assert.rejects(sandboxJavaScript('return Promise.resolve(1)',null,signal),/沙箱代码失败/);
});

test('web search sends only the explicit query to the fixed Brave endpoint',async()=>{
  const db=new DatabaseSync(':memory:');
  const saved=process.env.APIX_SKILL_BRAVE_KEY;
  try{
    process.env.APIX_SKILL_BRAVE_KEY='fixture-secret';
    const run=createSkillOperations({db},()=>{throw new Error('search must not access the project');},async(url,options)=>{
      assert.equal(url.origin,'https://api.search.brave.com');
      assert.equal(url.pathname,'/res/v1/web/search');
      assert.equal(url.searchParams.get('q'),'local calendar');
      assert.equal(url.searchParams.get('count'),'5');
      assert.equal(options.headers['X-Subscription-Token'],'fixture-secret');
      assert.equal(options.redirect,'error');
      return Response.json({web:{results:[{title:'Result',url:'https://example.test',description:'Reference'}]}});
    });
    const skill=readManifest({schema:1,id:'test-search',version:'1.0.0',name:'Search',description:'Search public pages',
      operation:'web.search',permissions:['network.brave-search']});
    assert.deepEqual(await run('project',skill,{query:'local calendar'},new AbortController().signal),
      {authority:'reference_only',results:[{title:'Result',url:'https://example.test',description:'Reference'}]});
  }finally{
    if(saved===undefined)delete process.env.APIX_SKILL_BRAVE_KEY;
    else process.env.APIX_SKILL_BRAVE_KEY=saved;
    db.close();
  }
});
