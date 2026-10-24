import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {readFile,mkdir} from 'node:fs/promises';import {resolve,join,isAbsolute} from 'node:path';import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const fixture=await startDeliveryFixture({startupMs:20000,idleMs:40000});let browser,attempts=0;
const server=createServer(async(req,res)=>{for await(const _ of req){}attempts++;if(attempts<=2){res.writeHead(503,{'Retry-After':'0'});res.end('{}');return;}
 const decision=attempts<=4?{action:'tool',tool:'run_command',args:{executable:'node',args:['-e',"require('node:fs').appendFileSync('marker.txt','once\\n')"]},message:'执行一次本地副作用夹具'}:{action:'finish',outcome:'blocked',message:'恢复夹具结束；没有调用真实模型。'};
 res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision)}}]}));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 await fixture.request('/api/manager/settings',{baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',model:'recovery-fixture',apiType:'openai-completions',apiKeyEnv:''});const session=await fixture.request('/api/assistant/sessions',{projectId:fixture.projectId});
 await fixture.request('/api/assistant/sessions/'+session.id+'/messages',{content:'只执行一次夹具命令'});const done=await fixture.idle(session.id);
 assert.equal(done.events.filter(e=>e.kind==='model_retry').length,2);assert.equal(done.events.filter(e=>e.kind==='tool_result'&&e.body.reused).length,1);assert.equal(attempts,5);assert.equal(await readFile(join(fixture.project,'marker.txt'),'utf8'),'once\n');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(({p,s})=>{localStorage.setItem('apix.selectedProject',p);localStorage.setItem('apix.assistant.'+p,s);},{p:fixture.projectId,s:session.id});await fixture.authorize(page);await page.goto(fixture.origin);await page.getByText('模型临时故障',{exact:false}).first().waitFor();assert.deepEqual(errors,[]);
 const out=resolve('.tmp-recovery-review');await mkdir(out,{recursive:true});await page.screenshot({path:join(out,'retry-and-receipt.png')});console.log(JSON.stringify({passed:true,modelHttpRequests:attempts,backoffRetries:2,sideEffectExecutions:1,paidModelCalls:0,browserErrors:0,out}));
}finally{await browser?.close();await fixture.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
