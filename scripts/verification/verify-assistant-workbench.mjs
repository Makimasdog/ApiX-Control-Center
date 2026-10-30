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
const h=await startDeliveryFixture({startupMs:30000,requestMs:30000,runtimeEntries:{APIX_CODEX_ENTRY:resolve('test/fake-native-runtime.mjs')},plan:()=>({steps:employees.map((employeeId,i)=>({employeeId,prompt:'ask 员工'+(i+1)+'只读核查',dependsOn:[]}))}),setup:async project=>{
  await writeFile(join(project,'README.md'),'只读核查');
  for(const args of [['init'],['config','user.name','Fixture'],['config','user.email','test@example.invalid'],['add','README.md'],['commit','-m','fixture']])execFileSync('git',args,{cwd:project,stdio:'ignore'});
}});
let browser;
const output=resolve(tmpdir(),'apix-assistant-workbench-review');
try{
  for(const name of ['范围核查员','文档核查员']){
    const {id}=await h.request('/api/employees',{name,runtime:'codex',role:'只读核查'});employees.push(id);
    await h.request('/api/employees/'+id+'/runtime-settings',{expectedVersion:0,backend:'codex-app-server',acknowledgeExperimental:true});
    await h.request('/api/permissions',{projectId:h.projectId,subject:id,mode:'full_access',version:0});
  }
  let child=await h.request('/api/coordination/sessions',{projectId:h.projectId,goal:'两位员工并行只读核查来源与范围'});
  const base='/api/coordination/sessions/'+child.id;
  for(const [field,value] of Object.entries({scope:'只读 README',constraints:'不修改文件或访问网络',deliverable:'两份中文事实报告',acceptance:'区分事实与未知，保留来源'}))child=await h.request(base+'/answers',{revision:child.revision,field,value});
  child=await h.request(base+'/confirm',{revision:child.revision});if(child.status==='plan_review')child=await h.request(base+'/dispatch',{planVersion:child.planVersion});
  assert.equal(child.failures.length,0);assert.equal(child.tasks.length,2);
  const parent=await h.request('/api/assistant/sessions',{projectId:h.projectId});
  // Seed only the parent linkage; worker dispatch, events and interactions use the real services.
  const db=new DatabaseSync(join(h.dir,'data','apix.sqlite'));
  db.prepare('UPDATE assistant_sessions SET child_session_id=? WHERE id=?').run(child.id,parent.id);
  const insert=db.prepare('INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES(?,?,?,?,?)');
  for(let i=0;i<20;i++)insert.run(parent.id,'user','message',JSON.stringify({content:'主会话历史 '+i+'\n核查目标与来源\n保留阅读位置'}),new Date().toISOString());db.close();
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await h.authorize(page);
  await page.addInitScript(({project,id})=>{localStorage.setItem('apix.selectedProject',project);localStorage.setItem('apix.assistant.'+project,id);},{project:h.projectId,id:parent.id});
  await page.goto(h.origin);await page.locator('[data-page-target="assistant"]').first().click();
  const rows=page.locator('#assistant-workers [data-worker-run]');await rows.first().waitFor();assert.equal(await rows.count(),2);
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
  await panel.locator('[data-interaction] textarea').fill('只读');await panel.locator('[data-interaction] button').click();
  await page.waitForFunction(()=>document.querySelector('[data-phase]')?.textContent.includes('执行结束'));
  await panel.locator('[data-show-results]').click();await panel.locator('[data-artifacts]').click();await panel.locator('[data-artifact-view] p').waitFor();
  assert((await panel.locator('[data-verification]').innerText()).includes('未验证'));
  assert.equal(await page.locator('[data-worker-run="'+firstRun+'"]').getAttribute('aria-pressed'),'true');
  await panel.locator('[data-show-process]').click();await panel.locator('[data-close]').click();assert.equal(await page.locator('#assistant-transcript').evaluate(e=>e.scrollTop),0);assert.equal(await dock.isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-worker-run')),firstRun);
  await rows.nth(1).click();await panel.locator('[data-interaction]').waitFor();assert.equal(await panel.locator('[data-guidance] textarea').inputValue(),'第二位员工的独立草稿');
  await page.locator('#assistant-new').click();await page.waitForFunction(()=>!document.querySelector('#page-assistant').classList.contains('show-agent-workbench'));
  assert.equal(await page.locator('#assistant-workers [data-worker-run]').count(),0);
  await page.route('**'+base,route=>route.fulfill({status:503,json:{error:'本地夹具模拟暂时读取失败'}}));
  await page.evaluate(id=>document.dispatchEvent(new CustomEvent('apix:open-assistant',{detail:id})),parent.id);
  await page.waitForFunction(()=>document.querySelector('#assistant-workers')?.textContent.includes('加载失败'));
  await page.unroute('**'+base);await rows.first().waitFor();assert.equal(await rows.count(),2);
  assert.equal(await page.locator('#assistant-input').inputValue(),'保留主会话草稿，不发送');
  await page.locator('#assistant-employees').click();assert(await page.locator('#page-missions').evaluate(e=>e.classList.contains('active-page')));
  assert.deepEqual(errors,[]);assert.equal(h.calls.filter(c=>c.phase==='planning').length,1);assert.equal(h.calls.length,1);
  console.log(JSON.stringify({passed:true,paidModelCalls:0,localPlanningCalls:1,localNativeRuns:2,output,cases:['main-workbench','real-child-workers','employee-isolation','guidance-drafts','main-draft','docked-and-drawer','resize-focus','escape-close','light-dark','guidance','question','artifacts','focus-return','thread-reset','worker-list-retry','employee-navigation']}));
}finally{await browser?.close();await h.close();}
