import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const employees=[];
const h=await startDeliveryFixture({startupMs:30000,requestMs:30000,runtimeEntries:{APIX_CODEX_ENTRY:resolve('test/fake-native-runtime.mjs')},plan:()=>({steps:employees.map((employeeId,i)=>({employeeId,prompt:(i===0?'ask':'approval')+' 员工'+(i+1)+'只读核查',dependsOn:[]}))}),setup:async project=>{
  await writeFile(join(project,'README.md'),'只读核查');
  for(const args of [['init'],['config','user.name','Fixture'],['config','user.email','test@example.invalid'],['add','README.md'],['commit','-m','fixture']])execFileSync('git',args,{cwd:project,stdio:'ignore'});
}});
let browser;
const output=resolve(tmpdir(),'apix-assistant-workbench-review');
try{
  const otherPath=join(h.dir,'other-project');await mkdir(otherPath);
  const otherProject=await h.request('/api/projects',{name:'通知跨项目夹具',path:otherPath});
  const notificationsPath='/api/assistant/worker-notifications';
  assert.equal((await fetch(h.origin+notificationsPath)).status,401);
  assert.deepEqual(await h.request(notificationsPath),[]);
  for(const name of ['范围核查员','文档核查员']){
    const {id}=await h.request('/api/employees',{name,runtime:'codex',role:'只读核查'});employees.push(id);
    await h.request('/api/employees/'+id+'/runtime-settings',{expectedVersion:0,backend:'codex-app-server',acknowledgeExperimental:true});
    await h.request('/api/permissions',{projectId:h.projectId,subject:id,mode:'full_access',version:0});
  }
  let child=await h.request('/api/coordination/sessions',{projectId:h.projectId,goal:'两位员工并行只读核查来源与范围'});
  const base='/api/coordination/sessions/'+child.id;
  for(const [field,value] of Object.entries({scope:'只读 README',constraints:'不修改文件或访问网络',deliverable:'两份中文事实报告',acceptance:'区分事实与未知，保留来源'}))child=await h.request(base+'/answers',{revision:child.revision,field,value});
  const parent=await h.request('/api/assistant/sessions',{projectId:h.projectId});
  assert.deepEqual(parent.workerInteractions,[]);
  // Seed the parent before dispatch so the fixture never writes while Run events are being recorded.
  const db=new DatabaseSync(join(h.dir,'data','apix.sqlite'));
  db.prepare('UPDATE assistant_sessions SET child_session_id=? WHERE id=?').run(child.id,parent.id);
  const insert=db.prepare('INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES(?,?,?,?,?)');
  for(let i=0;i<20;i++)insert.run(parent.id,'user','message',JSON.stringify({content:'主会话历史 '+i+'\n核查目标与来源\n保留阅读位置'}),new Date().toISOString());db.close();
  child=await h.request(base+'/confirm',{revision:child.revision});if(child.status==='plan_review')child=await h.request(base+'/dispatch',{planVersion:child.planVersion});
  assert.equal(child.failures.length,0);assert.equal(child.tasks.length,2);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await h.authorize(page);
  await page.addInitScript(({project,id})=>{
    localStorage.setItem('apix.selectedProject',project);
    localStorage.setItem('apix.assistant.'+project,id);
    window.apixDesktop={onWorkerRequest:callback=>{window.simulateWorkerNotification=callback;}};
  },{project:h.projectId,id:parent.id});
  await page.goto(h.origin);await page.locator('[data-page-target="assistant"]').first().click();
  const rows=page.locator('#assistant-workers [data-worker-run]');await rows.first().waitFor();assert.equal(await rows.count(),2);
  const requests=page.locator('#assistant-worker-interactions');
  const question=requests.locator('form').filter({hasText:'范围核查员 · 员工提问'});
  const approval=requests.locator('form').filter({hasText:'文档核查员 · 操作审批'});
  const openOverview=async()=>{
    const navigation=page.locator('#navigation-toggle');
    if(await navigation.isVisible())await navigation.click();
    await page.locator('.nav-item[data-page-target="overview"]').click();
  };
  const attention=page.locator('#overview-action-list');
  const questionTodo=attention.getByRole('button',{name:/范围核查员 · 员工提问等待回答/});
  const approvalTodo=attention.getByRole('button',{name:/文档核查员 · 员工操作等待审批/});
  await question.waitFor();await approval.waitFor();
  assert.match(await approval.innerText(),/运行命令 · node check\.mjs/);
  await question.locator('textarea').fill('只读');
  await page.waitForResponse(response=>response.url().endsWith('/api/assistant/sessions/'+parent.id));
  assert.equal(await question.locator('textarea').inputValue(),'只读');
  await openOverview();
  await approvalTodo.waitFor();
  assert.equal(await questionTodo.getAttribute('data-overview-interaction'),await question.getAttribute('data-interaction'));
  assert.equal(await approvalTodo.getAttribute('data-overview-interaction'),await approval.getAttribute('data-interaction'));
  await questionTodo.click();
  await question.and(page.locator(':focus')).waitFor();
  assert.equal(await question.locator('textarea').inputValue(),'只读');
  const workerNotifications=await h.request(notificationsPath);
  const questionNotice={projectId:h.projectId,sessionId:parent.id,interactionId:await question.getAttribute('data-interaction'),kind:'question',employee:'范围核查员'};
  const approvalNotice={projectId:h.projectId,sessionId:parent.id,interactionId:await approval.getAttribute('data-interaction'),kind:'approval',employee:'文档核查员'};
  assert.deepEqual(workerNotifications.find(item=>item.kind==='question'),questionNotice);
  assert.deepEqual(workerNotifications.find(item=>item.kind==='approval'),approvalNotice);
  await openOverview();
  await page.locator('#overview-project').selectOption(otherProject.id);
  await questionTodo.waitFor({state:'detached'});
  await page.evaluate(target=>window.simulateWorkerNotification(target),questionNotice);
  await question.and(page.locator(':focus')).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('apix.selectedProject')),h.projectId);
  await question.locator('textarea').fill('只读');
  assert((await rows.first().innerText()).includes('核查员'));
  await page.locator('#assistant-input').fill('保留主会话草稿，不发送');
  await page.locator('#assistant-transcript').evaluate(e=>e.scrollTop=0);
  await rows.first().click();const panel=page.locator('.agent-run-panel'),dock=page.locator('#assistant-run-dock');
  await dock.locator('[data-interaction]').waitFor();assert(await dock.isVisible());assert.equal(await page.locator('.agent-run-dialog').evaluate(d=>d.open),false);
  const firstRun=await rows.first().getAttribute('data-worker-run');
  await panel.locator('[data-guidance] textarea').fill('第一位员工的未发送草稿');
  await rows.nth(1).click();await panel.locator('[data-interaction]').waitFor();assert.equal(await panel.locator('[data-guidance] textarea').inputValue(),'');
  await panel.locator('[data-guidance] textarea').fill('第二位员工的独立草稿');
  await rows.first().click();await panel.locator('[data-interaction]').waitFor();assert.equal(await panel.locator('[data-guidance] textarea').inputValue(),'第一位员工的未发送草稿');
  await mkdir(output,{recursive:true});
  for(const width of [1800,1440,1280,1100,1099,768,390,1440]){
    await page.setViewportSize({width,height:1000});
    await page.waitForFunction(width=>width>=1100?!document.querySelector('.agent-run-dialog').open:document.querySelector('.agent-run-dialog').open,width);
    assert.equal(await panel.locator('[data-guidance] textarea').inputValue(),'第一位员工的未发送草稿');
    assert.equal(await page.locator('#assistant-input').inputValue(),'保留主会话草稿，不发送');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    if(width>=1100){const main=await page.locator('.assistant-main').boundingBox(),side=await dock.boundingBox();assert(main.x+main.width<=side.x+1);assert(await page.locator('#assistant-input').isVisible());}
    else assert(await page.evaluate(()=>document.querySelector('.agent-run-dialog').contains(document.activeElement)));
    await page.screenshot({path:join(output,'workbench-'+width+'.png'),animations:'disabled'});
    if(width===390){await page.keyboard.press('Escape');assert.equal(await page.locator('.agent-run-dialog').evaluate(d=>d.open),false);await rows.first().click();await panel.locator('[data-interaction]').waitFor();assert.equal(await panel.locator('[data-guidance] textarea').inputValue(),'第一位员工的未发送草稿');}
    if(width===1280){await panel.locator('[data-show-results]').click();assert(await panel.locator('[data-artifacts]').isVisible());assert(await page.locator('#assistant-input').isVisible());await page.screenshot({path:join(output,'results-1280.png'),animations:'disabled'});await panel.locator('[data-show-process]').click();}
  }
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:join(output,'workbench-dark.png'),animations:'disabled'});
  await panel.locator('[data-guidance] button').click();await page.waitForFunction(()=>document.querySelector('[data-delivery]')?.textContent.includes('运行时已接收'));
  assert.equal(await panel.locator('[data-guidance] textarea').inputValue(),'');
  await Promise.all([
    page.waitForResponse(response=>response.url().includes('/api/runs/'+firstRun+'/interactions/')&&response.ok()),
    question.getByRole('button',{name:'提交回答'}).click(),
  ]);
  await question.waitFor({state:'detached'});
  assert(await approval.isVisible());
  const answered=await h.request('/api/runs/'+firstRun+'/interactions');
  assert.equal(answered[0].state,'answered');assert.equal(answered[0].answerDelivery,'accepted');
  assert.deepEqual(await h.request(notificationsPath),[approvalNotice]);
  await page.waitForFunction(()=>document.querySelector('[data-phase]')?.textContent.includes('执行结束'));
  await panel.locator('[data-show-results]').click();await panel.locator('[data-artifacts]').click();await panel.locator('[data-artifact-view] p').waitFor();
  assert((await panel.locator('[data-verification]').innerText()).includes('未验证'));
  assert.equal(await page.locator('[data-worker-run="'+firstRun+'"]').getAttribute('aria-pressed'),'true');
  await panel.locator('[data-show-process]').click();await panel.locator('[data-close]').click();assert.equal(await page.locator('#assistant-transcript').evaluate(e=>e.scrollTop),0);assert.equal(await dock.isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-worker-run')),firstRun);
  await rows.nth(1).click();await panel.locator('[data-interaction]').waitFor();assert.equal(await panel.locator('[data-guidance] textarea').inputValue(),'第二位员工的独立草稿');
  await page.route('**/api/assistant/sessions',route=>route.fulfill({status:503,json:{error:'本地夹具模拟创建失败'}}));
  await page.locator('#assistant-new').click();
  await page.locator('#assistant-error').getByText('本地夹具模拟创建失败').waitFor();
  assert.equal(await page.locator('#assistant-input').inputValue(),'保留主会话草稿，不发送');
  assert.equal(await rows.count(),2);
  await page.unroute('**/api/assistant/sessions');
  const created=page.waitForResponse(response=>response.url().endsWith('/api/assistant/sessions')&&response.request().method()==='POST'&&response.ok());
  await page.locator('#assistant-new').click();await page.waitForFunction(()=>!document.querySelector('#page-assistant').classList.contains('show-agent-workbench'));
  const fresh=await (await created).json();
  assert.equal(await page.locator('#assistant-workers [data-worker-run]').count(),0);
  assert.equal(await requests.locator('form').count(),0);
  await page.route('**'+base,route=>route.fulfill({status:503,json:{error:'本地夹具模拟暂时读取失败'}}));
  await page.evaluate(id=>document.dispatchEvent(new CustomEvent('apix:open-assistant',{detail:id})),parent.id);
  await page.waitForFunction(()=>document.querySelector('#assistant-workers')?.textContent.includes('加载失败'));
  await page.unroute('**'+base);await rows.first().waitFor();assert.equal(await rows.count(),2);
  assert.equal(await page.locator('#assistant-input').inputValue(),'保留主会话草稿，不发送');
  // Exercise the failure display contract without failing or retrying an actual user run.
  await page.route('**'+base,async route=>{const response=await route.fetch(),state=await response.json();state.tasks[0]={...state.tasks[0],status:'failed',result:'本地诊断失败 <script>unsafe</script>',recovery:{state:'waiting',automatic:true,attempts:0,maxAttempts:2,reason:'等待可用员工修复'}};await route.fulfill({response,json:state});});
  await page.waitForFunction(()=>document.querySelector('#assistant-workers')?.textContent.includes('等待自动修复'));
  assert((await rows.first().innerText()).includes('本地诊断失败 <script>unsafe</script>'));
  assert.equal(await page.locator('#assistant-workers script').count(),0);
  await page.screenshot({path:join(output,'failure-diagnostics.png'),animations:'disabled'});await page.unroute('**'+base);
  await page.setViewportSize({width:390,height:1000});
  await openOverview();
  await approvalTodo.waitFor();
  assert.equal(await questionTodo.count(),0);
  await approvalTodo.click();
  await approval.and(page.locator(':focus')).waitFor();
  await page.screenshot({path:join(output,'main-approval-390.png'),animations:'disabled'});
  const secondRun=await rows.nth(1).getAttribute('data-worker-run');
  await Promise.all([
    page.waitForResponse(response=>response.url().includes('/api/runs/'+secondRun+'/interactions/')&&response.ok()),
    approval.getByRole('button',{name:'拒绝'}).click(),
  ]);
  await approval.waitFor({state:'detached'});
  const denied=await h.request('/api/runs/'+secondRun+'/interactions');
  assert.equal(denied[0].state,'denied');assert.equal(denied[0].answerDelivery,'accepted');
  assert.deepEqual(await h.request(notificationsPath),[]);
  await Promise.all([
    page.waitForResponse(response=>response.url().includes('view=attention')&&response.ok()),
    openOverview(),
  ]);
  await approvalTodo.waitFor({state:'detached'});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-page-target="assistant"]').first().click();
  const history=page.locator('#assistant-thread-list');
  const openThread=id=>history.locator(`[data-history-open="${id}"]`);
  const input=page.locator('#assistant-input');
  await openThread(fresh.id).click();
  await openThread(fresh.id).and(page.locator('.selected')).waitFor();
  await input.fill('即将归档对话的独立草稿');
  await history.locator(`[data-history-action="archive"][data-history-id="${fresh.id}"]`).click();
  await openThread(parent.id).and(page.locator('.selected')).waitFor();
  assert.equal(await input.inputValue(),'保留主会话草稿，不发送');
  await history.locator('select').selectOption('archived');
  await Promise.all([
    page.waitForResponse(response=>response.url().endsWith('/api/chat-history/assistant/'+fresh.id)&&response.ok()),
    history.locator(`[data-history-action="restore"][data-history-id="${fresh.id}"]`).click(),
  ]);
  await history.locator('select').selectOption('active');
  await openThread(fresh.id).click();
  assert.equal(await input.inputValue(),'即将归档对话的独立草稿');
  await page.locator('#assistant-employees').click();assert(await page.locator('#page-missions').evaluate(e=>e.classList.contains('active-page')));
  assert.deepEqual(errors,[]);assert.equal(h.calls.filter(c=>c.phase==='planning').length,1);assert.equal(h.calls.length,1);
  console.log(JSON.stringify({passed:true,paidModelCalls:0,localPlanningCalls:1,localNativeRuns:2,output,cases:['main-workbench','real-child-workers','employee-isolation','guidance-drafts','main-draft','docked-and-drawer','resize-focus','escape-close','light-dark','guidance','main-question','main-approval-denial','overview-exact-card-focus','overview-processed-removal','notification-owner-boundary','notification-cross-project','notification-pending-removal','artifacts','focus-return','thread-reset','new-thread-failure','archive-restore-draft','worker-list-retry','failure-diagnostics','employee-navigation']}));
}finally{await browser?.close();await h.close();}
