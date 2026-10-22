import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const fixture=await startDeliveryFixture({startupMs:20000}),output=resolve('.tmp-navigation-review');let browser;
try{
  await mkdir(output,{recursive:true});browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(fixture.origin);
  const openBoard=()=>page.locator('.nav-item[data-page-target="coordinator"]').click();
  await openBoard();await page.getByRole('heading',{name:'暂无协作流程'}).waitFor();
  assert.equal(await page.locator('#desktop-start,#coord-create,#desktop-mobile-new,#desktop-new-chat').count(),0);
  assert.equal(await page.locator('#page-coordinator textarea:visible').count(),0);
  assert.equal((await fixture.request('/api/coordination/sessions?projectId='+fixture.projectId)).length,0);
  await page.screenshot({path:join(output,'empty-1440.png')});
  await page.getByRole('button',{name:'前往与 ApiX 对话',exact:true}).click();
  assert(await page.locator('#assistant-input').isVisible());await page.locator('#assistant-input').fill('保留主对话草稿');
  const first=await fixture.request('/api/coordination/sessions',{projectId:fixture.projectId,goal:'已有协作一'});
  const second=await fixture.request('/api/coordination/sessions',{projectId:fixture.projectId,goal:'已有协作二'});
  await openBoard();await page.locator('.coord-process-list summary').click();await page.locator(`.coord-process-list [data-session="${first.id}"]`).waitFor();
  await page.locator(`.coord-process-list [data-session="${first.id}"]`).focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#coord-title')?.textContent==='已有协作一');
  assert.equal(await page.locator(`.coord-process-list [data-session="${first.id}"]`).getAttribute('aria-pressed'),'true');
  assert(await page.locator('.desktop-main #coord-tasks').isVisible(),'员工进度应直接显示在主区域');
  assert.equal(await page.locator('#coord-message textarea').isVisible(),false,'流程补充默认收起');
  await page.locator('.coord-records summary').click();assert(await page.locator('#coord-message textarea').isVisible());
  await page.locator('#coord-message textarea').fill('当前流程的补充草稿');
  await page.locator(`.coord-process-list [data-session="${second.id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#coord-title')?.textContent==='已有协作二');
  await page.locator(`.coord-process-list [data-session="${first.id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#coord-title')?.textContent==='已有协作一');
  assert.equal(await page.locator('#coord-message textarea').inputValue(),'当前流程的补充草稿');
  await page.locator('#desktop-details').click();assert(await page.locator('#coord-confirm').isVisible()===false);
  await page.locator('.desktop-inspector summary').filter({hasText:'需求与验收'}).click();assert(await page.locator('#coord-confirm').isVisible(),'历史需求确认入口应保留');
  await page.locator('.coord-records summary').click();await page.locator('#desktop-close-details').click();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:960});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:join(output,`progress-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:960});await page.locator('#desktop-back-assistant').click();
  assert.equal(await page.locator('#assistant-input').inputValue(),'保留主对话草稿');
  await page.locator('.nav-item[data-page-target="overview"]').click();
  await page.locator('[data-overview-nav="assistant"]').click();assert(await page.locator('#assistant-input').isVisible());
  // Exercise the view contract for a real existing child without dispatching workers.
  const source=await fixture.request('/api/assistant/sessions',{projectId:fixture.projectId});
  await page.route(`**/api/assistant/sessions/${source.id}`,async route=>{
    const response=await route.fetch();const session=await response.json();
    await route.fulfill({response,json:{...session,child_session_id:first.id}});
  });
  await page.evaluate(id=>document.dispatchEvent(new CustomEvent('apix:open-assistant',{detail:id})),source.id);
  await page.waitForFunction(()=>document.querySelector('#assistant-child')?.textContent.includes('已关联子流程'));
  await page.locator('#assistant-advanced').click();await page.waitForFunction(()=>document.querySelector('#page-coordinator.active-page #coord-title')?.textContent==='已有协作一');
  assert.equal((await fixture.request('/api/coordination/sessions?projectId='+fixture.projectId)).length,2,'导航不得另建协作目标');
  assert.equal(fixture.calls.length,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,modelCalls:0,output,cases:['single-entry','empty-board','existing-process-selection','progress-primary','legacy-controls','draft-preservation','overview-route','source-child-route','responsive']}));
}finally{await browser?.close();await fixture.close();}
