import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const fixture=await startDeliveryFixture({startupMs:20000,decide:(_ctx,state)=>{if(!state.memory){state.memory=true;return {action:'tool',tool:'remember',args:{title:'测试约定',content:'测试必须覆盖边界',kind:'feedback',evidence:'测试约定'},message:'记录明确的测试约定'};}return {action:'finish',outcome:'completed',message:'已记录'};}});
let browser;
try{
  await writeFile(join(fixture.project,'AGENTS.md'),'Keep task boundaries.\n');
  const session=await fixture.request('/api/assistant/sessions',{projectId:fixture.projectId});
  for(let i=0;i<4;i++){await fixture.request('/api/assistant/sessions/'+session.id+'/messages',{content:'请记住测试约定，覆盖边界 '+i});await fixture.idle(session.id);}
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({p,s})=>{localStorage.setItem('apix.selectedProject',p);localStorage.setItem('apix.assistant.'+p,s);},{p:fixture.projectId,s:session.id});await page.goto(fixture.origin);
  await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='本轮完成');
  const initialInfo=await fixture.request('/api/assistant/sessions/'+session.id+'/context');assert.equal(initialInfo.error,undefined,initialInfo.error);
  await page.locator('#assistant-details').click();await page.locator('#assistant-context-refresh').click();await page.locator('#assistant-budget progress').waitFor();assert.match(await page.locator('#assistant-budget').innerText(),/自动记忆索引/);
  await page.locator('#assistant-compact [name="focus"]').fill('保留测试边界与任务约束');await page.locator('#assistant-compact button').click();await page.waitForFunction(()=>document.querySelector('#assistant-budget')?.textContent.includes('压缩历史 (1)'));
  const info=await fixture.request('/api/assistant/sessions/'+session.id+'/context');assert.equal(info.compressions[0].preserve,'保留测试边界与任务约束');assert(info.instructions.some(f=>f.path==='AGENTS.md'));
  await page.locator('.assistant-more summary').click();await page.locator('[data-page-target="memory"]').click();await page.locator('#memory-state-refresh').click();await page.locator('#memory-settings-form').waitFor();
  await page.locator('#memory-status-filter').selectOption('candidate');const card=page.locator('#memory-list .memory-card').filter({hasText:'测试约定'});await card.locator('[data-memory-state]').click();await page.waitForFunction(()=>document.querySelectorAll('#memory-list .memory-card').length===0);
  await page.locator('#memory-status-filter').selectOption('active');await card.waitFor();assert.match(await card.innerText(),/user.*active.*v2/s);
  await page.locator('#memory-settings-form [name="enabled"]').uncheck();await page.locator('#memory-settings-form button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#memory-feedback')?.textContent==='自动记忆已停用');
  await page.locator('#memory-settings-form [name="enabled"]').check();await page.locator('#memory-settings-form [name="autoConfirm"]').check();await page.locator('#memory-settings-form button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#memory-feedback')?.textContent==='自动确认模式已启用');
  const output=resolve('.tmp-memory-review');await mkdir(output,{recursive:true});
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:join(output,'memory-'+width+'.png'),fullPage:true,animations:'disabled'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  assert.deepEqual(errors,[]);assert(fixture.calls.some(c=>c.phase==='compact'));console.log(JSON.stringify({passed:['context-breakdown','manual-focus','instruction-metadata','candidate-confirm','status-filter','project-switches','responsive'],localModelCalls:fixture.calls.length,paidModelCalls:0,output}));
}finally{await browser?.close();await fixture.close();}
