import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {test} from 'node:test';
import {startDeliveryFixture} from './delivery-fixture.mjs';

const manifest={schema:1,id:'custom-code',version:'1.0.0',name:'自定义计算',description:'计算结果',
  operation:'code.run',permissions:['sandbox.javascript'],script:'return input.value * 2;'};
const finish={action:'finish',outcome:'completed',message:'执行完成'};

test('AgentSkill grants are project scoped, version-bound, and used by the real assistant loop',{timeout:90000},async()=>{
  const h=await startDeliveryFixture({startupMs:30000,decide(context){
    const run=context.history.find(event=>event.kind==='tool_result'&&event.body.tool==='skill_custom_code');
    if(run){assert.equal(run.body.result.value,9);return finish;}
    return {action:'tool',tool:'skill_custom_code',args:{input:{value:3}},message:'计算'};
  }});
  const base='/api/projects/'+h.projectId+'/agent-skills';
  try{
    assert.equal((await fetch(h.origin+base)).status,401);
    const installed=await h.request(base+'/install',{manifest});
    assert.equal(installed.enabled,false);
    const skill=base+'/'+manifest.id;
    const args={input:{value:3}};
    await h.request(skill+'/run',{revision:installed.revision,args},403);
    await h.request(skill+'/enabled',{enabled:true,revision:installed.revision});
    await h.request(skill+'/run',{revision:installed.revision},400);
    assert.deepEqual(await h.request(skill+'/run',{revision:installed.revision,args}),{value:6});
    const directory=join(h.dir,'data','agent-skills',createHash('sha256').update(h.projectId).digest('hex'));
    await writeFile(join(directory,'custom-code.json'),JSON.stringify({...manifest,version:'1.1.0',script:'return input.value * 3;'}));
    const [newVersion]=await h.request(base);
    assert.equal(newVersion.enabled,false);
    assert.notEqual(newVersion.revision,installed.revision);
    await h.request(skill+'/run',{revision:installed.revision,args},409);
    await h.request(skill+'/enabled',{enabled:true,revision:newVersion.revision});
    const session=await h.request('/api/assistant/sessions',{projectId:h.projectId});
    await h.request('/api/assistant/sessions/'+session.id+'/messages',{content:'用自定义技能计算 3 的结果'});
    assert.equal((await h.idle(session.id)).status,'completed');
    await h.restart();
    assert.deepEqual(await h.request(skill+'/run',{revision:newVersion.revision,args}),{value:9});
    await h.request(skill+'/enabled',{enabled:true,revision:installed.revision},409);
    const otherPath=join(h.dir,'other');
    await mkdir(otherPath);
    const other=(await h.request('/api/projects',{name:'其他',path:otherPath})).id;
    assert.deepEqual(await h.request('/api/projects/'+other+'/agent-skills'),[]);
    await h.request(base+'/install',{manifest,expectedRevision:installed.revision},409);
    const reverted=await h.request(base+'/install',{manifest,expectedRevision:newVersion.revision});
    assert.equal(reverted.revision,installed.revision);
    assert.equal(reverted.enabled,false);
    await h.request(skill+'/enabled',{enabled:true,revision:reverted.revision});
    await h.request(skill+'/enabled',{enabled:false});
    await h.request(skill+'/run',{revision:reverted.revision,args},403);
    await h.request(skill+'/remove',{});
    assert.deepEqual(await h.request(base),[]);
  }finally{await h.close();}
});

test('market installs pinned versions, bounds file access, and keeps calendar records across restart',{timeout:90000},async()=>{
  const h=await startDeliveryFixture({startupMs:30000});
  const base='/api/projects/'+h.projectId+'/agent-skills', market='/api/agent-skills/market';
  try{
    const results=await h.request(market);
    assert(results.some(entry=>entry.id==='calendar-add'));
    assert.equal((await h.request(market+'/file-write/1.0.0')).operation,'file.write');
    await h.request(market+'/file-write/9.0.0',undefined,404);
    const install=async (id,custom)=>{
      const entry=await h.request(base+'/install',custom?{manifest:custom}:{market:{id,version:'1.0.0'}});
      assert.equal(entry.enabled,false);
      await h.request(base+'/'+id+'/enabled',{enabled:true,revision:entry.revision});
      return (args,status)=>h.request(base+'/'+id+'/run',{revision:entry.revision,args},status);
    };
    const file=await install('scoped-write',{schema:1,id:'scoped-write',version:'1.0.0',name:'范围写入',description:'仅写 src',
      operation:'file.write',permissions:['workspace.write'],directory:'src'});
    await file({path:'outside.txt',content:'denied'},400);
    const linkType=process.platform==='win32'?'junction':'dir';
    await symlink(h.project,join(h.project,'src','outside'),linkType);
    await file({path:'src/outside/outside.txt',content:'denied'},400);
    await symlink(h.project,join(h.project,'scope-alias'),linkType);
    const aliased=await install('aliased-write',{schema:1,id:'aliased-write',version:'1.0.0',name:'链接范围',description:'链接指向根目录',
      operation:'file.write',permissions:['workspace.write'],directory:'scope-alias'});
    await aliased({path:'outside.txt',content:'denied'},400);
    await file({path:'src/note.txt',content:'ok'});
    assert.equal(await readFile(join(h.project,'src','note.txt'),'utf8'),'ok');
    await h.request('/api/permissions',{projectId:h.projectId,subject:'apix',mode:'read_only',version:1});
    await file({path:'src/note.txt',content:'denied'},403);
    assert.equal(await readFile(join(h.project,'src','note.txt'),'utf8'),'ok');
    await h.request('/api/permissions',{projectId:h.projectId,subject:'apix',mode:'full_access',version:2});
    const add=await install('calendar-add'),list=await install('calendar-list'),remove=await install('calendar-remove');
    const saved=await add({title:'本地会议',startsAt:'2026-11-12T09:00:00+08:00',endsAt:'2026-11-12T10:00:00+08:00'});
    await h.restart();
    assert.equal((await list({from:'2026-11-12T00:00:00Z'})).events[0].id,saved.id);
    assert.deepEqual(await remove({eventId:saved.id}),{deleted:true});
    assert.deepEqual(await list({}),{events:[]});
  }finally{await h.close();}
});
