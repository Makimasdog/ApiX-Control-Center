import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
import {startNpmFixture} from '../../test/npm-service-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const output=resolve('.tmp/verification/project-browser');await mkdir(output,{recursive:true});
const reports=[],browser=await chromium.launch({headless:true});
try{
 for(const kind of ['delivery','npm']){
  const h=await(kind==='npm'?startNpmFixture():startDeliveryFixture({startupMs:30000}));
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
   await page.addInitScript(id=>localStorage.setItem('apix.selectedProject',id),h.projectId);await h.authorize(page);await page.goto(h.origin);
   await page.locator('#assistant-input').waitFor();await page.locator('#assistant-new').click();
   await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='等待消息');
   await page.locator('#assistant-execution-mode').selectOption('full_access');
   await page.locator('#assistant-details').click();
   if(kind==='npm'){
    await page.locator('#npm-diagnose').click();await page.waitForFunction(()=>document.querySelector('#npm-diagnosis')?.textContent.includes('需要批准'));
    await page.locator('#npm-proposal input[name=paths]').fill('src');await page.locator('#npm-proposal input[name=network]').uncheck();await page.locator('#npm-proposal button').click();
    await page.locator('#npm-approve').click();await page.waitForFunction(()=>document.querySelector('#npm-plan')?.textContent.startsWith('已批准'));
    assert.equal(h.calls.length,0);
   }
   await page.locator('#assistant-input').fill('修复加法，实际运行检查，保留用户内容并交付');await page.locator('#assistant-form button[type=submit]').click();
   if(kind==='delivery'){await page.locator('#assistant-dialog[open]').waitFor();await page.locator('#assistant-approve').click();}
   await page.waitForFunction(()=>document.querySelector('#assistant-status')?.textContent==='本轮完成',{}, {timeout:120000});
   const current=async()=>{const sessions=await h.request('/api/assistant/sessions?projectId='+h.projectId);return h.request('/api/assistant/sessions/'+sessions[0].id);};
   let s=await current();assert.equal(s.verificationStatus,'verified');assert.equal(s.review.latestDelivery.version,1);
   assert((await page.locator('[data-reviewed-delivery]').innerText()).includes('src/add.cjs'));
   if(kind==='npm'){
    assert(s.events.some(e=>e.kind==='tool_result'&&e.body.tool==='read_output'));
    assert.equal(s.review.latestDelivery.verification.checks[0].npmValidation.status,'passed');
   }
   await page.locator('#delivery-feedback').fill('补充修复注释并再次验证');await page.locator('[data-delivery-action=request_changes]').click();
   await page.locator('#delivery-continue').click();
   await page.waitForFunction(()=>document.querySelector('[data-reviewed-delivery] h4')?.textContent.includes('v2'),{}, {timeout:120000});
   s=await current();assert.equal(s.verificationStatus,'verified');assert.equal(s.review.latestDelivery.version,2);
   const acceptedId=s.review.latestDelivery.id;await page.locator('[data-delivery-action=accept]').click();
   await page.waitForFunction(()=>document.querySelector('[data-reviewed-delivery] h4')?.textContent.includes('已验收'));
   await page.reload();await page.locator('[data-reviewed-delivery]').waitFor({state:'attached'});
   if(!await page.locator('[data-reviewed-delivery]').isVisible())await page.locator('#assistant-details').click();
   assert((await page.locator('[data-reviewed-delivery] h4').innerText()).includes('已验收'));
   if(kind==='delivery'){
    await page.locator('details').filter({has:page.locator('#assistant-task-form')}).locator('summary').click();
    await page.locator('#assistant-task-form [name=description]').fill('下一任务：仅新增说明');await page.locator('#assistant-task-form button').click();
    await page.waitForFunction(()=>document.querySelector('[data-reviewed-delivery]')?.textContent.includes('src/note.md'),{}, {timeout:60000});
    s=await current();assert.deepEqual(s.review.latestDelivery.netChanges.map(f=>f.path),['src/note.md']);
    const history=page.locator('[data-delivery-history="'+acceptedId+'"]');await page.locator('#assistant-delivery details').filter({has:history}).locator('summary').first().click();
    await history.click();await page.waitForFunction(()=>document.querySelector('#delivery-history-view')?.textContent.includes('验收'));
   }
   for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await page.screenshot({path:join(output,kind+'-'+width+'.png'),animations:'disabled'});}
   assert.deepEqual(errors,[]);reports.push({kind,passed:true,checks:['real-browser-submit','verified-delivery','feedback','revision-v2','accept','reload','responsive',...(kind==='delivery'?['second-task-net-diff','historical-acceptance']:['offline-npm-approval','failed-check-log-read','npm-copy-verification'])],paidModelCalls:0,localProtocolCalls:h.calls.length});
  }catch(error){await page.screenshot({path:join(output,kind+'-failed.png')}).catch(()=>{});throw error;}
  finally{await context.close();await h.close();}
 }
 await writeFile(join(output,'report.json'),JSON.stringify({reports},null,2));console.log(JSON.stringify({reports,output}));
}finally{await browser.close();}
