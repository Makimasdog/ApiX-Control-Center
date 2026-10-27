import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const output=resolve('.tmp-token-usage-review');await mkdir(output,{recursive:true});
const fixture=await startDeliveryFixture({startupMs:30000,usage:{prompt_tokens:1200,completion_tokens:80,prompt_tokens_details:{cached_tokens:400},completion_tokens_details:{reasoning_tokens:20}},decide:()=>({action:'finish',outcome:'completed',message:'只读夹具检查完成'})});
let browser;
try{
 let session=await fixture.request('/api/assistant/sessions',{projectId:fixture.projectId});const base='/api/assistant/sessions/'+session.id;
 await fixture.request(base+'/messages',{content:'只读检查当前项目'});session=await fixture.idle(session.id);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({p,s})=>{localStorage.setItem('apix.selectedProject',p);localStorage.setItem('apix.assistant.'+p,s);},{p:fixture.projectId,s:session.id});await fixture.authorize(page);await page.goto(fixture.origin);
 await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='本轮完成');await page.locator('#assistant-details').click();await page.locator('#assistant-usage-refresh').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-usage')?.textContent.includes('1,200'));
 assert.match(await page.locator('#assistant-usage').innerText(),/80 Token/);assert.match(await page.locator('#assistant-usage').innerText(),/400 Token/);assert.match(await page.locator('#assistant-usage').innerText(),/未知/);
 await page.locator('#assistant-optimization select').selectOption('saving');await page.locator('#assistant-optimization button').click();await page.waitForFunction(()=>document.querySelector('#assistant-optimization-status')?.textContent.startsWith('节省模式'));
 assert.equal((await fixture.request(base+'/context')).optimization.mode,'saving');await page.reload();await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='本轮完成');await page.locator('#assistant-details').click();await page.locator('#assistant-usage-refresh').click();await page.waitForFunction(()=>document.querySelector('#assistant-optimization select')?.value==='saving');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.locator('#assistant-usage-refresh').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'tokens-'+width+'.png'),animations:'disabled'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 session=await fixture.request(base);await fixture.request(base+'/tasks',{version:session.version,description:'下一任务：只读检查'});await page.waitForFunction(()=>document.querySelector('#assistant-usage')?.textContent.includes('任务已切换'));await page.locator('#assistant-usage-refresh').click();await page.waitForFunction(()=>document.querySelector('#assistant-usage')?.textContent.includes('0 次请求'));assert.match(await page.locator('#assistant-usage').innerText(),/未知 Token/);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:['provider-usage','unknown-fields','saving-mode','mode-persistence','task-switch','responsive','no-browser-errors'],paidModelCalls:0,localModelCalls:fixture.calls.length,output}));
}finally{await browser?.close();await fixture.close();}
