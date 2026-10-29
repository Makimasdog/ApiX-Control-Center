import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetch} from './local-fetch.mjs';
import {startDeliveryFixture} from './delivery-fixture.mjs';

test('concurrent document updates publish one version and reject the stale writer without mixing indexes',async()=>{
 const fixture=await startDeliveryFixture();
 try{
  const path='/api/projects/'+fixture.projectId+'/knowledge';
  const space=await fixture.request(path+'/spaces/save',{name:'并发资料',grants:['apix']});
  const encode=text=>Buffer.from(text).toString('base64');
  const doc=await fixture.request(path+'/documents/upload',{spaceId:space.id,filename:'concurrent.txt',base64:encode('Original generation')});
  const responses=await Promise.all(['A','B'].map(winner=>fetch(fixture.origin+path+'/documents/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spaceId:space.id,id:doc.id,version:1,filename:'concurrent.txt',base64:encode('Concurrent winner '+winner)})})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(bodies.find(b=>b.code)?.code,'VERSION_CONFLICT');
  let state;for(let i=0;i<50;i++){state=(await fixture.request(path))[0].documents[0];if(state.state!=='processing')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(state.state,'ready');assert.equal(state.version,2);
  const hits=await fixture.request(path+'/search',{query:'Concurrent'});assert.equal(hits.results.length,1);assert.equal(hits.results[0].version,2);assert.match(hits.results[0].content,/^Concurrent winner [AB]$/);
  assert.equal((await fixture.request(path+'/search',{query:'Original'})).results.length,0);
  await fixture.request(path+'/documents/remove',{id:doc.id,version:1},409);await fixture.request(path+'/documents/remove',{id:doc.id,version:2});assert.equal((await fixture.request(path+'/search',{query:'Concurrent'})).results.length,0);
 }finally{await fixture.close();}
});
