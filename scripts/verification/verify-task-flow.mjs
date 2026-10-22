import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const output=resolve('.tmp-task-flow');await mkdir(output,{recursive:true});
const fixture=await startDeliveryFixture({startupMs:20000,setup:async root=>{
 await writeFile(join(root,'large.dat'),Buffer.alloc(9*1024*1024,65));
 await writeFile(join(root,'check.cjs'),'console.log("existing test passed");');
},decide:(_context,state)=>(state.step=(state.step??0)+1)>1?{action:'finish',outcome:'completed',message:'现有测试已通过。'}:{action:'tool',tool:'run_command',args:{executable:'node',args:['check.cjs'],timeoutMs:10000},message:'直接运行已有测试，无需配置员工。'}});
// This project deliberately starts in the old per-operation mode.
await fixture.request('/api/permissions',{projectId:fixture.projectId,subject:'apix',mode:'ask_approval',version:1});
let browser;
try {
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(fixture.origin);await page.waitForSelector('#assistant-input');
 await page.waitForFunction(()=>document.querySelector('.sidebar-project'));
 await page.locator('#assistant-execution-mode').selectOption('full_access');
 await page.locator('#assistant-input').fill('运行项目已有的测试用例，告诉我真实结果');
 await page.locator('#assistant-form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='本轮完成',{},{timeout:60000});
 const sessions=await fixture.request('/api/assistant/sessions?projectId='+fixture.projectId);assert.equal(sessions.length,1);
 const session=await fixture.request('/api/assistant/sessions/'+sessions[0].id);
 assert.equal(session.policy.mode,'full_access');assert(!session.events.some(e=>e.kind==='request'));
 assert(session.events.some(e=>e.kind==='tool_result'&&e.body.tool==='run_command'&&e.body.ok!==false));
 const execution=session.events.find(e=>e.kind==='command_finished')?.body;
 assert.equal(execution?.exitCode,0);assert.equal(execution?.processesEnded,true);assert.equal(execution?.executionComplete,true);
 assert.equal((await fixture.request('/api/projects/'+fixture.projectId+'/workflow')).enabled,false);
 assert.equal((await fixture.request('/api/snapshot')).employees.length,0);
 await page.screenshot({path:join(output,'test-completed.png')});
 const global=await fixture.request('/api/manager/settings');await fixture.request('/api/manager/settings',{...global,model:'updated-local-model'});
 await page.locator('#assistant-model [data-use-global-model]').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-model input')?.value==='updated-local-model');
 await page.locator('.nav-item[data-page-target=settings]').click();
 await page.waitForSelector('#page-settings.active-page');await page.waitForSelector('#project-execution');
 assert(await page.locator('#coord-model').isVisible());assert(!await page.locator('#assistant-input').isVisible());assert(!await page.locator('#desktop-start textarea').isVisible());
 await page.screenshot({path:join(output,'settings.png')});assert.deepEqual(errors,[]);
 await page.locator('.nav-item[data-page-target=assistant]').click();await page.locator('#assistant-new').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='等待消息');
 await page.locator('#assistant-execution-mode').selectOption('read_only');await page.locator('#assistant-input').fill('只读检查，不允许运行命令');await page.locator('#assistant-form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='需要检查');
 const readonly=(await fixture.request('/api/assistant/sessions?projectId='+fixture.projectId)).find(s=>s.id!==session.id);
 const blocked=await fixture.request('/api/assistant/sessions/'+readonly.id);assert.equal(blocked.policy.mode,'read_only');assert(!blocked.events.some(e=>e.kind==='command_intent'));
 console.log(JSON.stringify({passed:true,projectBytes:9*1024*1024,approvalRequests:0,employees:0,automaticWorkflow:false,modelCalls:fixture.calls.length,paidCalls:0,output}));
} finally {await browser?.close();await fixture.close();}
