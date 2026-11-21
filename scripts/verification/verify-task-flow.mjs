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
},decide:(context,state)=>{
 const command={action:'tool',tool:'run_command',args:{executable:'node',args:['check.cjs'],timeoutMs:10000},message:'直接运行已有测试，无需配置员工。'};
 // Conversations may share the current task; the read-only case must still attempt the forbidden command.
 if(context.latestUserRequest.content.startsWith('只读检查'))return command;
 return (state.step=(state.step??0)+1)>1?{action:'finish',outcome:'completed',message:'现有测试已通过。'}:command;
}});
// This project deliberately starts in the old per-operation mode.
await fixture.request('/api/permissions',{projectId:fixture.projectId,subject:'apix',mode:'ask_approval',version:1});
let browser;
try {
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await fixture.authorize(page);await page.goto(fixture.origin);await page.waitForSelector('#assistant-input');
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
 const modelOptions=page.locator('#assistant-model summary');
 await modelOptions.click();
 await page.locator('#assistant-model [data-use-global-model]').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-model input')?.value==='updated-local-model');
 const modelInput=page.getByLabel('本对话模型',{exact:true}),effort=page.getByLabel('本对话思考强度');
 const message=page.locator('#assistant-input');await message.fill('保留这条草稿');
 assert.equal(await effort.isDisabled(),true);
 await modelInput.fill('custom-local-model');await modelInput.press('Enter');
 await page.getByRole('status').filter({hasText:'已保存'}).waitFor();
 const saved=await fixture.request('/api/conversation-models/assistant/'+session.id);
 assert.equal(saved.settings.model,'custom-local-model');
 assert.equal(await message.inputValue(),'保留这条草稿');
 assert.equal((await fixture.request('/api/assistant/sessions/'+session.id)).events.length,session.events.length);
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#assistant-model input')?.value==='custom-local-model');
 for(const [width,colorScheme] of [[1440,'light'],[390,'light'],[390,'dark'],[320,'light']]){
   await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});
   const layout=await page.locator('#assistant-form').evaluate(form=>{
     const box=form.getBoundingClientRect(), model=form.querySelector('#assistant-model input').getBoundingClientRect();
     const effort=form.querySelector('#assistant-model select'), effortBox=effort.getBoundingClientRect();
     const send=form.querySelector('button[type="submit"]').getBoundingClientRect();
     const aligned=model.left>=box.left&&model.right<=effortBox.left&&effortBox.right<=send.left
       &&send.right<=box.right&&Math.abs(effortBox.bottom-send.bottom)<1;
     const isLight=Number(getComputedStyle(effort).backgroundColor.match(/\d+/)?.[0])>128;
     return {aligned,isLight};
   });
   assert.deepEqual(layout,{aligned:true,isLight:colorScheme==='light'},`${width}px ${colorScheme} composer alignment and theme`);
   await page.locator('#assistant-form').screenshot({path:join(output,`composer-${width}-${colorScheme}.png`)});
 }
 await page.setViewportSize({width:1440,height:960});await page.emulateMedia({colorScheme:'light'});
 await page.locator('.nav-item[data-page-target=settings]').click();
 // 设置页分区化后 #project-execution 在执行分区面板内，需先切换分区；供应商面板默认就续。
 await page.waitForSelector('#page-settings.active-page');await page.locator('[data-settings-tab="execution"]').click();await page.waitForSelector('#project-execution');await page.locator('[data-settings-tab="providers"]').click();await page.waitForSelector('.provider-center [data-provider-refresh]',{state:'attached'});
 assert(await page.locator('.provider-center [data-provider-add]').isVisible());assert.equal(await page.locator('#coord-model').count(),0);assert(!await page.locator('#assistant-input').isVisible());assert(!await page.locator('#desktop-start textarea').isVisible());
 await page.screenshot({path:join(output,'settings.png')});assert.deepEqual(errors,[]);
 await page.locator('.nav-item[data-page-target=assistant]').click();await page.locator('#assistant-new-chat').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='等待消息');
 await page.locator('#assistant-execution-mode').selectOption('read_only');await page.locator('#assistant-input').fill('只读检查，不允许运行命令');await page.locator('#assistant-form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='需要检查');
 const readonly=(await fixture.request('/api/assistant/sessions?projectId='+fixture.projectId)).find(s=>s.id!==session.id);
 const blocked=await fixture.request('/api/assistant/sessions/'+readonly.id);assert.equal(blocked.policy.mode,'read_only');assert(!blocked.events.some(e=>e.kind==='command_intent'));
 await fixture.request('/api/manager/settings',{...global,provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',apiKeyEnv:'DEEPSEEK_API_KEY'});
 await page.locator('#assistant-new-chat').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-model input')?.value==='deepseek-flash');
 await effort.selectOption('high');
 const feedback=page.locator('#assistant-model [role=status]');await feedback.waitFor();
 assert.equal(await feedback.innerText(),'已保存');
 const newest=(await fixture.request('/api/assistant/sessions?projectId='+fixture.projectId)).find(s=>s.id!==session.id&&s.id!==readonly.id);
 assert.equal((await fixture.request('/api/conversation-models/assistant/'+newest.id)).settings.reasoningEffort,'high');
 console.log(JSON.stringify({passed:true,projectBytes:9*1024*1024,approvalRequests:0,employees:0,automaticWorkflow:false,modelCalls:fixture.calls.length,paidCalls:0,output}));
} finally {await browser?.close();await fixture.close();}
