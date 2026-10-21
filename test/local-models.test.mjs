import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readLocalModels} from '../dist/src/models/local-models.js';

async function fixture(handler,work){
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  try{await work('http://127.0.0.1:'+server.address().port+'/v1');}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('local directory uses GET, keeps the base path, normalizes and deduplicates IDs',async()=>fixture((req,res)=>{
  assert.equal(req.method,'GET');assert.equal(req.url,'/v1/models');assert.equal(req.headers.authorization,undefined);
  res.end(JSON.stringify({data:[{id:' qwen:latest '},{id:'qwen:latest'},{id:'llama:local',owned_by:'not returned'},{id:' -bad'},{id:'\u0000bad'},{id:'x'.repeat(201)},{id:12}]}));
},async baseUrl=>{assert.deepEqual(await readLocalModels({baseUrl:baseUrl+'/'}),{models:[{id:'qwen:latest',name:'qwen:latest'},{id:'llama:local',name:'llama:local'}]});}));
test('remote URLs, credentials, queries and invalid environment names are rejected before network access',async()=>{
  for(const input of [{baseUrl:'https://example.invalid/v1',apiKeyEnv:'KEY'},{baseUrl:'http://localhost.example.invalid/v1',apiKeyEnv:'KEY'},{baseUrl:'http://a:b@localhost/v1'},{baseUrl:'http://localhost/v1?key=secret'},{baseUrl:'file:///x'},{baseUrl:''},{baseUrl:'http://localhost/v1',apiKeyEnv:'bad-name'}])await assert.rejects(readLocalModels(input));
});
test('empty directory is valid; malformed bodies, invalid IDs and excessive responses fail safely',async()=>{
  const cases=[['{"data":[]}',null],['not JSON',/格式/],['{}',/格式/],['{"data":[{"id":false}]}',/有效/],[JSON.stringify({data:Array.from({length:1001},(_,i)=>({id:String(i)}))}),/1000/],['x'.repeat(1024*1024+1),/大小/]];
  for(const [body,error] of cases)await fixture((_req,res)=>res.end(body),async baseUrl=>{if(error)await assert.rejects(readLocalModels({baseUrl}),error);else assert.deepEqual(await readLocalModels({baseUrl}),{models:[]});});
});
test('HTTP errors are sanitized and redirects are never followed',async()=>{
  let requests=0;
  await fixture((req,res)=>{requests++;if(req.url==='/redirect/models'){res.writeHead(302,{Location:'/v1/models'});res.end();}else{res.writeHead(401);res.end('secret-upstream-details');}},async baseUrl=>{
    await assert.rejects(readLocalModels({baseUrl}),error=>/HTTP 401/.test(error.message)&&!error.message.includes('secret'));
    await assert.rejects(readLocalModels({baseUrl:baseUrl.replace('/v1','/redirect')}),/重定向/);
    assert.equal(requests,2);
  });
});
test('missing key environment prevents a request and slow bodies obey the deadline',async()=>{
  await assert.rejects(readLocalModels({baseUrl:'http://127.0.0.1:1/v1',apiKeyEnv:'APIX_TEST_DISCOVERY_UNSET_9F3A'}),/环境变量/);
  await fixture((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{"data":[');},async baseUrl=>{
    const start=Date.now();await assert.rejects(readLocalModels({baseUrl}),/超时/);assert(Date.now()-start<7000);
  });
});
