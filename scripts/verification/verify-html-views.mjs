import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
import {rendererFixture} from '../../test/renderer-fixture.mjs';

const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const payload='"><img src=x onerror="window.p9Injected=1"> & quote';
const fixture=await startDeliveryFixture({name:'P9 '+payload,startupMs:20000});
const output=resolve('.tmp-html-views-review'),checks=[],errors=[];let browser;
try{
  await mkdir(output,{recursive:true});
  const employee=await fixture.request('/api/employees',{name:'员工 '+payload,runtime:'codex',role:payload});
  await fixture.request('/api/agent-providers',{name:'供应商 '+payload,apiType:'openai-responses',baseUrl:'http://127.0.0.1:1/v1',model:'fixture-model',apiKey:'',version:0});
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));await fixture.authorize(page);
  await page.goto(fixture.origin);await page.locator('#sidebar-projects [data-select-project]').waitFor();
  assert((await page.locator('#sidebar-projects').innerText()).includes(payload));
  await page.locator('[data-page-target="missions"]').first().click();
  assert.equal(await page.locator('[data-open-employee="'+employee.id+'"]').first().innerText(),'员工 '+payload);
  await page.locator('[data-page-target="settings"]').first().click();
  await page.locator('.provider-card').waitFor();
  assert.equal(await page.locator('.provider-card strong').first().innerText(),'供应商 '+payload);
  await page.locator('[data-provider-edit]').first().click();
  assert.equal(await page.locator('[data-provider-form] [name=name]').inputValue(),'供应商 '+payload);
  assert.equal(await page.locator('#sidebar-projects img, #agent-grid img, .provider-center img').count(),0);
  checks.push('project/employee/provider names render as text and survive form editing');

  // Load exported widgets in an isolated DOM while keeping real module serving and owner authentication.
  await page.route('**/p9-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.goto(fixture.origin+'/p9-harness');
  await page.evaluate(async value=>{
    const mount=id=>{const root=document.createElement('section');root.id=id;document.body.append(root);return root;};
    const {showTaskEvents}=await import('/dist/web/task-events.js');
    showTaskEvents(mount('events'),{prompt:value,result:value,employee_name:value,runtime:'codex',status:'failed'},[{kind:value,created_at:'2026-10-25T00:00:00Z',payload:value}],value);
    const {showEmployeeSettings}=await import('/dist/web/employee-settings.js');
    showEmployeeSettings(mount('employee'),{employee:{id:'fixture',runtime:'codex'},capability:{model:value,reasoningEffort:'high',version:1,accountId:value},accounts:[{id:value,alias:value,type:'api',currency:null,limitMinor:null,remainingPercent:null,reservePercent:10,observedAt:null,resetsAt:null,budgetRemainingMinor:null,committedMinor:0,unknownCount:0,version:1}]});
    const {autonomyView}=await import('/dist/web/autonomy-view.js');
    autonomyView(mount('autonomy'),()=>{}).render('fixture',{enabled:true,version:1,maxRepairs:2,maxMinutes:30,maxRunMinutes:10,checkpointMinutes:5,taskCapMinor:null,autoReassign:true,checks:[{id:value,args:['verify.mjs'],timeoutMs:1000}]},{id:'session',revision:1,autonomy:{state:'attention',reason:value,architecture:{summary:value,digest:value,modules:[]},checks:[],repairs:[]}});
    const {schedulingView}=await import('/dist/web/scheduling-view.js');
    schedulingView(mount('scheduling'),()=>{}).render('fixture',{policy:{version:1,quotaMaxAgeMinutes:60,requireFreshQuota:true,limitMinor:100,currency:'USD',managerAccountId:value,managerEstimateMinor:1},accounts:[{id:value,alias:value,type:'api',currency:'USD',limitMinor:100,remainingPercent:null,reservePercent:10,observedAt:null,resetsAt:null,version:1,quotaState:value,committedMinor:0,pause:null}],profiles:[],committedMinor:0,ledger:[{id:value,amount:10,actual:null,state:'reserved',currency:'USD'}]},[]);
    const {createWorkflowGraph}=await import('/dist/web/workflow-graph.js');
    const graph=createWorkflowGraph(mount('graph'),{inspect(){},overview(){},select(){}});
    graph.update({id:'graph',title:value,derivedStatus:'attention',tasks:[{id:value,prompt:value,employee_id:'employee',employeeName:value,runtime:'codex',status:'completed',result:value}],dependencies:[]});
  },payload);
  assert.equal(await page.locator('#events .task-event-overview > p').innerText(),payload);
  assert.equal(await page.locator('#events select option').last().getAttribute('value'),payload);
  await page.locator('#events input[type=search]').fill('not-present');
  assert.equal(await page.locator('#events .task-event-empty').count(),1);
  assert.equal(await page.locator('#employee [name=model]').inputValue(),payload);
  assert.equal(await page.locator('#employee [name=accountId]').inputValue(),payload);
  assert.equal(await page.locator('#employee [name=reasoningEffort]').inputValue(),'high');
  assert.doesNotMatch(await page.locator('#employee [data-account-summary]').innerText(),/null|undefined/);
  assert.equal(await page.locator('#autonomy [name=autoReassign]').isChecked(),true);
  assert((await page.locator('#autonomy [name=checks]').inputValue()).includes('p9Injected'));
  assert.equal(await page.locator('#autonomy [data-autonomy-resume]').count(),1);
  assert.equal(await page.locator('#scheduling [name=managerAccountId]').inputValue(),payload);
  assert.equal(await page.locator('#scheduling [data-settle] [name=id]').inputValue(),payload);
  assert.equal(await page.locator('#scheduling [name=requireFreshQuota]').isChecked(),true);
  assert.equal(await page.locator('#graph svg path[marker-end]').count(),1);
  await page.locator('#graph [data-graph-task]').last().click();
  assert.equal(await page.locator('#graph [data-node-content] h2').innerText(),payload);
  assert.equal(await page.locator('#graph [data-graph-inspect]').getAttribute('data-graph-inspect'),payload);
  checks.push('event filters, employee model/accounts, autonomy, scheduling and graph retain nested controls and quoted values');

  await page.route('**/api/conversation-models/assistant/p9',route=>route.fulfill({json:{version:1,settings:{model:payload,baseUrl:payload,reasoningEffort:'high'},providerName:payload,models:[{id:payload,name:payload}],efforts:['high']}}));
  await page.evaluate(async()=>{const root=document.createElement('section');root.id='picker';document.body.append(root);(await import('/dist/web/conversation-model.js')).conversationModelPicker(root)('assistant','p9');});
  await page.locator('#picker input').waitFor();
  assert.equal(await page.locator('#picker input').inputValue(),payload);
  assert.equal(await page.locator('#picker datalist option').getAttribute('value'),payload);
  assert.equal(await page.locator('#picker select').inputValue(),'high');
  checks.push('conversation model options preserve values and selected effort');

  await page.route('**/api/projects/p9/mcp',route=>route.fulfill({json:{servers:[{id:payload,name:payload,transport:'stdio',enabled:false,version:1}],tools:[{name:payload,description:payload}]}}));
  await page.evaluate(async()=>{document.body.insertAdjacentHTML('beforeend','<div id="mcp-grid"></div><span id="mcp-tab-count"></span>');await import('/dist/web/mcp-settings.js');document.dispatchEvent(new CustomEvent('apix:snapshot',{detail:{projectId:'p9'}}));});
  await page.locator('[data-mcp-edit]').waitFor();
  assert.equal(await page.locator('[data-mcp-edit]').getAttribute('data-mcp-edit'),payload);
  assert.equal(await page.locator('#mcp-grid strong').innerText(),payload);
  await page.locator('[data-mcp-edit]').click();
  assert.equal(JSON.parse(await page.locator('#mcp-grid [name=config]').inputValue()).name,payload);
  checks.push('MCP names, tools and editable JSON remain escaped and intact');

  const folder={path:payload,home:payload,parent:payload,roots:[payload],directories:[{name:payload,path:payload}]};
  await page.route('**/api/project-folders?*',route=>route.fulfill({json:folder}));
  await page.evaluate(async()=>{document.body.insertAdjacentHTML('beforeend','<form id="editor-form"><input name="path"><input name="name"></form><button data-choose-project-folder>Browse</button>');await import('/dist/web/project-picker.js');});
  await page.locator('[data-choose-project-folder]').click();await page.locator('[data-folder-select]').waitFor();
  assert.equal(await page.locator('[data-folder-select]').getAttribute('data-folder-select'),payload);
  await page.locator('[data-folder-select]').click();
  assert.equal(await page.locator('#editor-form [name=path]').inputValue(),payload);
  checks.push('folder paths round-trip through quoted attributes without injection');

  const renderers=rendererFixture(payload);
  await page.evaluate(async data=>{
    const mount=(id,markup)=>{const root=document.createElement('section');root.id=id;root.innerHTML=markup;document.body.append(root);};
    mount('timeline-renderer',(await import('/dist/web/assistant-view.js')).assistantTimeline(data.timeline));
    mount('delivery-renderer',(await import('/dist/web/delivery-view.js')).deliveryView(data.review,false));
    mount('recovery-renderer',(await import('/dist/web/execution-view.js')).recoveryForm(data.recovery,data.recoveryTask,data.employees,true));
    mount('readiness-renderer',(await import('/dist/web/readiness.js')).readinessView(data.readiness));
  },renderers);
  assert.equal(await page.locator('#timeline-renderer [data-kb-citation]').count(),2);
  assert.equal(await page.locator('#timeline-renderer [data-kb-citation]').first().getAttribute('data-kb-citation'),renderers.citation);
  assert.equal(await page.locator('#timeline-renderer [data-output-reference]').first().getAttribute('data-output-reference'),payload);
  assert((await page.locator('#timeline-renderer .assistant-message').first().innerText()).includes(payload));
  assert.equal(await page.locator('#delivery-renderer [data-delivery-action=accept]').isDisabled(),true);
  assert.equal(await page.locator('#delivery-renderer [data-delivery-file]').first().getAttribute('data-delivery-file'),payload);
  assert.equal(await page.locator('#delivery-renderer [data-delivery-action=accept]').getAttribute('data-delivery-version'),'0');
  assert.equal(await page.locator('#recovery-renderer [name=employeeId]').inputValue(),payload);
  assert.equal(await page.locator('#recovery-renderer [name=confirmedStopped]').getAttribute('required'),'');
  assert.equal(await page.locator('#recovery-renderer button').isDisabled(),false);
  assert.equal(await page.locator('#readiness-renderer [data-setup-action]').count(),1);
  await page.evaluate(async data=>{document.querySelector('#recovery-renderer').innerHTML=(await import('/dist/web/execution-view.js')).recoveryForm({...data.recovery,managedActive:true},data.recoveryTask,data.employees,true);},renderers);
  assert.equal(await page.locator('#recovery-renderer button').isDisabled(),true);
  checks.push('timeline citations, output links, delivery versions and recovery/readiness guards survive renderer migration');

  // These routes supply UI data only; they do not claim backend workflow or history-write acceptance.
  await page.route('**/api/chat-history?*',route=>route.fulfill({json:renderers.threads}));
  await page.route('**/api/employees/p9/details',route=>route.fulfill({json:renderers.employeeDetails}));
  await page.route('**/api/coordination/sessions?*',route=>route.fulfill({json:renderers.goals}));
  await page.evaluate(async data=>{
    document.body.insertAdjacentHTML('beforeend','<div id="assistant-thread-list"></div><main id="page-missions"></main><main id="page-overview"></main>');
    await import('/dist/web/chat-history.js');await import('/dist/web/employee.js');await import('/dist/web/overview.js');
    document.dispatchEvent(new CustomEvent('apix:snapshot',{detail:{projectId:'p9',data:data.snapshot}}));
    document.dispatchEvent(new CustomEvent('apix:open-employee',{detail:'p9'}));
  },renderers);
  await page.locator('#assistant-thread-list .history-row').waitFor();
  assert.equal(await page.locator('#assistant-thread-list .assistant-thread span').innerText(),payload);
  assert.equal(await page.locator('#assistant-thread-list [data-history-open]').getAttribute('data-history-open'),payload);
  assert.equal(await page.locator('#assistant-thread-list [data-history-action=archive]').getAttribute('aria-label'),'归档 '+payload);
  await page.locator('#assistant-thread-list select').selectOption('archived');
  await page.waitForFunction(()=>document.querySelector('#assistant-thread-list [data-history-open]')?.disabled===true);
  assert.equal(await page.locator('#assistant-thread-list [data-history-action=restore]').count(),1);
  await page.locator('#assistant-thread-list select').selectOption('deleted');
  await page.waitForFunction(()=>!document.querySelector('#assistant-thread-list [data-history-action=delete]'));
  await page.locator('#employee-active .employee-task').waitFor();
  assert.equal(await page.locator('#employee-active .employee-task strong').innerText(),payload);
  assert((await page.locator('#employee-history').innerText()).includes('阻塞报告：'+payload));
  await page.locator('#overview-board .overview-task').waitFor();
  assert.equal(await page.locator('#overview-action-list strong').innerText(),payload);
  assert.equal(await page.locator('#overview-team-list strong').innerText(),payload);
  assert.equal(await page.locator('#overview-board .overview-task strong').innerText(),payload);
  assert((await page.locator('#overview-departments').innerText()).includes(payload));
  await page.locator('#overview-search').fill('not-present');
  assert.equal(await page.locator('#overview-board .overview-task').count(),0);
  await page.locator('#overview-search').fill('');
  assert.equal(await page.locator('#overview-board .overview-task').count(),1);
  checks.push('history filters, employee progress and overview cards preserve escaped text and existing controls');

  assert.equal(await page.locator('img, [onerror]').count(),0);
  assert.equal(await page.evaluate(()=>window.p9Injected),undefined);
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks,pageErrors:errors,paidModelCalls:0},null,2));
  console.log(JSON.stringify({passed:true,checks,output}));
}catch(error){
  const page=browser?.contexts()[0]?.pages()[0];
  if(page)await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),pageErrors:errors,html:await page.content()},null,2));
  throw error;
}finally{await browser?.close();await fixture.close();}
