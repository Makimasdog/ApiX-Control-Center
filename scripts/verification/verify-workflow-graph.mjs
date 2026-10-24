import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const fixture=await startDeliveryFixture({startupMs:20000}),output=resolve('.tmp-graph-review');let browser;
try{
 await mkdir(output,{recursive:true});
 const people=[];for(const name of ['需求分析员','代码程序员','质量工程师','交付审查员'])people.push(await fixture.request('/api/employees',{name,runtime:'codex',role:name}));
 const session=await fixture.request('/api/coordination/sessions',{projectId:fixture.projectId,goal:'构建 Agent 桌面工作区'});
 // UI-only task fixtures: no real employee is dispatched and no model is invoked.
 let tasks=[
  {id:'graph-a',employee_id:people[0].id,status:'accepted',prompt:'梳理需求与验收边界\n确认桌面窗口、模型通道和任务协作的范围。'},
  {id:'graph-b',employee_id:people[1].id,status:'unknown',prompt:'实现桌面应用核心功能\n保留 IPC 边界、会话历史和中止机制。\n<img src=x onerror="window.graphInjected=true">',result:'上次进程状态无法确定。\nAPI Error: fixture only; inspect original process before retry.'},
  {id:'graph-c',employee_id:people[2].id,status:'completed',prompt:'验证质量与权限边界\n并行检查组件和关键交互。',result:'本地夹具验证结果；尚未获得用户验收。'},
  {id:'graph-d',employee_id:people[3].id,status:'blocked',prompt:'集成审查与打包交付\n等待前置步骤验收。',queue_reason:'代码步骤和质量步骤尚未验收'},
 ];
 const dependencies=[{task_id:'graph-b',depends_on_id:'graph-a'},{task_id:'graph-c',depends_on_id:'graph-a'},{task_id:'graph-d',depends_on_id:'graph-b'},{task_id:'graph-d',depends_on_id:'graph-c'}];
 let holdDelivery=false,releaseDelivery;
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
 await page.route(`**/api/coordination/sessions/${session.id}`,async route=>{const response=await route.fetch();const actual=await response.json();await route.fulfill({response,json:{...actual,tasks,dependencies,derivedStatus:'attention'}});});
 await page.route('**/api/tasks/graph-*/delivery',async route=>{
  if(holdDelivery)await new Promise(resolve=>{releaseDelivery=resolve;});
  const id=new URL(route.request().url()).pathname.split('/')[3],task=tasks.find(t=>t.id===id);
  await route.fulfill({json:{taskId:id,status:task.status,processMayExist:id==='graph-b'?true:false,managedActive:false,recoveryFingerprint:'fixture-recovery',latestRun:{id:'fixture-run',status:task.status,pid:null},inspection:{fingerprint:null,files:[],conflicts:[],preview:'fixture diff only'},workspacePath:'fixture / isolated UI'}});
 });
 await fixture.authorize(page);await page.goto(fixture.origin);await page.locator('.nav-item[data-page-target="settings"]').click();
 await page.locator('.workflow-node').first().waitFor({state:'attached'});
 await page.locator('.nav-item[data-page-target="coordinator"]').click();
 await page.locator('.workflow-node[data-graph-task="graph-a"]').waitFor();
 assert.equal(await page.locator('.workflow-node').count(),5);assert.equal(await page.locator('.workflow-edge').count(),5);
 const y=await page.locator('.workflow-node[data-graph-task="graph-b"]').evaluate(el=>el.style.left);assert.equal(await page.locator('.workflow-node[data-graph-task="graph-c"]').evaluate(el=>el.style.left),y,'并行分支应位于同层');
 await page.screenshot({animations:'disabled',path:join(output,'graph-light-1440.png')});
 await page.waitForFunction(()=>parseInt(document.querySelector('[data-graph-scale]')?.textContent??'100')<100);
 const initialScale=parseInt(await page.locator('[data-graph-scale]').innerText());await page.locator('[data-graph-zoom="out"]').click();assert.equal(parseInt(await page.locator('[data-graph-scale]').innerText()),initialScale-10);
 await page.locator('[data-graph-zoom="fit"]').click();
 await page.locator('.workflow-node[data-graph-task="graph-b"]').focus();await page.keyboard.press('Enter');
 assert(await page.locator('[data-node-view]').isVisible());assert.equal(await page.locator('[data-node-content] h2').innerText(),'代码程序员');
 assert(await page.locator('[data-node-content]').innerText().then(t=>t.includes('<img src=x')));assert.equal(await page.locator('[data-node-content] img').count(),0);
 assert.equal(await page.evaluate(()=>window.graphInjected),undefined);
 await page.locator('[data-node-content] h2').scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:join(output,'node-hero-light-1440.png')});
 await page.locator('.workflow-report summary').click();assert(await page.locator('.workflow-report pre').innerText().then(t=>t.includes('API Error')));
 await page.screenshot({animations:'disabled',path:join(output,'node-light-1440.png')});
 await page.locator('[data-graph-inspect="graph-b"]').click();await page.locator('[data-node-inspection] #coord-recovery').waitFor();
 assert(await page.locator('[data-node-inspection] input[name="confirmedStopped"]').evaluate(el=>el.required));assert(await page.locator('[data-node-inspection] input[name="reviewed"]').evaluate(el=>el.required));
 assert.equal(await page.locator('[data-node-view]').isVisible(),true,'检查结果必须在节点详情内');
 tasks=tasks.map(t=>t.id==='graph-b'?{...t,status:'running'}:t);
 await page.waitForFunction(()=>document.querySelector('[data-node-content] .workflow-detail-hero .workflow-badge')?.textContent==='执行中');
 assert(await page.locator('.workflow-report').evaluate(el=>el.open),'实时更新不应收起正在查看的报告');
 assert.equal(await page.locator('#coord-delivery-panel').count(),0,'状态变化应移除过期恢复表单');
 await page.locator('[data-graph-back]').click();await page.locator('.workflow-node[data-graph-task="graph-c"]').click();
 assert.equal(await page.locator('[data-node-content] .workflow-detail-hero .workflow-badge').innerText(),'待验收');
 await page.locator('[data-graph-inspect="graph-c"]').click();await page.locator('[data-coord-accept]').waitFor();assert(await page.locator('[data-coord-accept]').isDisabled(),'无检查指纹不得验收');
 await page.locator('[data-graph-back]').click();await page.locator('.workflow-node[data-graph-task="graph-b"]').click();
 holdDelivery=true;await page.locator('[data-graph-inspect="graph-b"]').click();
 for(let i=0;i<100&&!releaseDelivery;i++)await new Promise(resolve=>setTimeout(resolve,10));assert(releaseDelivery);
 await page.locator('[data-graph-back]').click();await page.locator('.workflow-node[data-graph-task="graph-d"]').click();releaseDelivery();holdDelivery=false;
 await page.waitForFunction(()=>!document.querySelector('#page-coordinator')?.classList.contains('is-busy'));
 assert.equal(await page.locator('[data-node-content] h2').innerText(),'交付审查员');assert.equal(await page.locator('#coord-delivery-panel').count(),0,'旧节点迟到的检查结果不能覆盖当前详情');
 await page.locator('[data-graph-back]').click();await page.locator('[data-graph-goal]').click();
 assert.equal(await page.locator('[data-node-content] h2').innerText(),'构建 Agent 桌面工作区');assert(await page.locator('[data-graph-goal-settings]').isVisible());
 await page.locator('[data-graph-back]').click();
 for(const theme of ['light','dark']){
  await page.emulateMedia({colorScheme:theme});
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1050});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({animations:'disabled',path:join(output,`graph-${theme}-${width}.png`)});
   await page.locator('.workflow-node[data-graph-task="graph-d"]').click();assert(await page.locator('[data-node-content]').isVisible());
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({animations:'disabled',path:join(output,`node-${theme}-${width}.png`)});
   await page.locator('[data-graph-back]').click();
  }
 }
 assert.deepEqual(errors,[]);assert.equal(fixture.calls.length,0);assert.deepEqual(writes,[],'图形浏览、检查与缩放不应发出写操作');
 console.log(JSON.stringify({passed:true,modelCalls:0,writes:0,output,cases:['dependency-layout','parallel-branches','zoom','keyboard-drilldown','escaped-content','report','recovery-guards','live-status','stale-inspection','acceptance-guard','goal-details','back','responsive-themes']}));
}finally{await browser?.close();await fixture.close();}
