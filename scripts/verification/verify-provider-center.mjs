import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const fixture=await startDeliveryFixture({startupMs:20000}),out=resolve('.tmp-provider-review');let browser;
try{
  await mkdir(out,{recursive:true});const employee=await fixture.request('/api/employees',{name:'测试需求分析员',runtime:'codex',role:'需求分析'});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(fixture.origin,{waitUntil:'load'});await page.locator('[data-page-target="settings"]').first().click();
  const root=page.locator('.provider-center');await root.locator('[data-agent="'+employee.id+'"]').waitFor();
  const form=root.locator('[data-provider-form]');await form.locator('[name="name"]').fill('独立 Codex API');await form.locator('[name="apiType"]').selectOption('openai-responses');await form.locator('[name="model"]').fill('fixture-model');await form.locator('[name="baseUrl"]').fill('https://provider.invalid/v1');await form.locator('[name="apiKey"]').fill('fixture-ui-private-key');await form.getByRole('button',{name:'保存供应商',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-provider-status]')?.textContent.includes('供应商已保存'));
  const p=(await fixture.request('/api/agent-providers')).providers[0];assert(p);assert.equal(await form.locator('[name="apiKey"]').inputValue(),'');assert(!(await root.innerText()).includes('fixture-ui-private-key'));
  const row=root.locator('[data-agent="'+employee.id+'"]');await row.locator('select').selectOption(p.id);await row.getByRole('button',{name:'应用到 测试需求分析员'}).click();
  await page.waitForFunction(async id=>(await (await fetch('/api/agent-providers')).json()).agents.find(a=>a.id===id)?.providerId,employee.id);
  await page.waitForFunction(()=>document.querySelector('[data-provider-status]')?.textContent.startsWith('已保存'));
  assert.equal((await fixture.request('/api/agent-providers')).agents.find(a=>a.id===employee.id).providerId,p.id);
  await page.locator('[data-provider-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-provider-status]')?.textContent.startsWith('已刷新'));
  assert.equal(await page.locator('[data-provider-refresh]').isEnabled(),true,'刷新按钮应保持可用');
  await root.locator('[data-provider-editor]').selectOption(p.id);assert.equal(await form.locator('[name="apiKey"]').inputValue(),'');await form.locator('[name="baseUrl"]').fill('https://different.invalid/v1');await form.getByRole('button',{name:'保存供应商',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-provider-status]')?.textContent.includes('重新填写密钥'));
  await form.locator('[name="apiType"]').selectOption('codex-login');assert.equal(await form.locator('[name="baseUrl"]').isEnabled(),false);assert.equal(await form.locator('[name="apiKey"]').isEnabled(),false);
  await form.locator('[name="apiType"]').selectOption('anthropic-messages');assert.equal(await form.locator('[name="authHeader"]').isVisible(),true);await form.locator('[name="authHeader"]').selectOption('bearer');
  await root.locator('[data-provider-editor]').selectOption(p.id);
  for(const width of [1440,390]){await page.setViewportSize({width,height:1100});await root.screenshot({path:join(out,`providers-${width}.png`)});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'provider settings overflow');}
  assert.deepEqual(errors,[]);assert.equal(fixture.calls.length,0);console.log(JSON.stringify({passed:true,cases:['create','masked-key','bind','endpoint-change-guard','desktop-layout','mobile-layout'],modelCalls:0,screenshots:out}));
}finally{await browser?.close();await fixture.close();}
