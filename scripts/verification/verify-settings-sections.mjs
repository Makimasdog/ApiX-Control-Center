import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const fixture=await startDeliveryFixture({startupMs:20000}),output=resolve('.tmp/verification/settings-sections');let browser;
try{
  await mkdir(output,{recursive:true});
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await fixture.authorize(page);await page.goto(fixture.origin,{waitUntil:'load'});
  await page.locator('[data-page-target="settings"]').first().click();
  // 分区结构：四个分区、默认供应商分区可见、设置页收起侧栏对话历史。
  const tabs=page.locator('.settings-tabs [role="tab"]');
  assert.equal(await tabs.count(),4,'设置页应有四个分区');
  assert.deepEqual(await tabs.allInnerTexts(),['供应商管理','模型与 Agent 路由','执行与并发','预算与配额']);
  assert.equal(await page.locator('[data-settings-tab="providers"]').getAttribute('aria-selected'),'true');
  assert(await page.locator('[data-provider-add]').isVisible(),'供应商分区默认可见');
  assert.equal(await page.locator('#settings-panel-scheduling').isHidden(),true);
  assert.equal(await page.locator('#sidebar-history').isHidden(),true,'设置页应隐藏侧栏对话历史');
  // 路由事件直达分区；分区选择写入本地并在刷新后恢复。
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('apix:settings-section',{detail:'scheduling'})));
  const policy=page.locator('#settings-panel-scheduling [data-policy]');
  await policy.waitFor();
  assert.equal(await page.locator('[data-settings-tab="scheduling"]').getAttribute('aria-selected'),'true');
  await page.reload({waitUntil:'load'});
  await page.locator('[data-page-target="settings"]').first().click();
  await page.locator('#settings-panel-scheduling [data-policy]').waitFor();
  assert.equal(await page.locator('#settings-panel-scheduling').isVisible(),true,'刷新后应恢复上次分区');
  await policy.locator('[name="budgetEnabled"]').check();
  assert(await policy.locator('[name="limitMinor"]').isEnabled());
  await policy.locator('[name="budgetEnabled"]').uncheck();
  assert(await policy.locator('[name="limitMinor"]').isDisabled());
  const quota=policy.locator('[name="quotaMaxAgeMinutes"]');
  const original=Number(await quota.inputValue());
  const dot=page.locator('[data-tab-dirty="scheduling"]');
  const bar=page.locator('[data-unsaved-bar]');
  // 未存：修改后出现脏点与统一未保存条。
  await quota.fill(String(original+7));
  assert.equal(await dot.isVisible(),true);
  assert.equal(await bar.isVisible(),true);
  assert.match(await page.locator('[data-unsaved-text]').innerText(),/预算与配额/);
  // 切换分区再回来：面板不重建，草稿保留。
  await page.locator('[data-settings-tab="execution"]').click();
  assert.equal(await page.locator('#settings-panel-scheduling').isHidden(),true);
  await page.locator('[data-settings-tab="scheduling"]').click();
  assert.equal(Number(await quota.inputValue()),original+7,'分区切换不得丢失草稿');
  assert.equal(await dot.isVisible(),true);
  await page.screenshot({path:join(output,'settings-unsaved-1440.png')});
  // 放弃当前分区修改：回到基线并清掉未保存条。
  await page.locator('[data-unsaved-discard]').click();
  assert.equal(Number(await quota.inputValue()),original);
  assert.equal(await bar.isHidden(),true);
  assert.equal(await dot.isHidden(),true);
  // 已存：保存当前分区后清除脏标记并写入服务。
  await quota.fill(String(original+9));
  await page.locator('[data-unsaved-save]').click();
  await dot.waitFor({state:'hidden'});
  assert.equal(await bar.isHidden(),true,'保存成功后未保存条应消失');
  assert.equal((await fixture.request(`/api/projects/${fixture.projectId}/scheduling`)).policy.quotaMaxAgeMinutes,original+9);
  // 提交失败：错误进入通知区，脏标记与草稿保留。
  await page.route('**/api/projects/*/scheduling',async route=>{
    if(route.request().method()==='POST')await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'模拟版本冲突，请重试'})});
    else await route.continue();
  });
  await quota.fill(String(original+11));
  await page.locator('[data-unsaved-save]').click();
  await page.waitForFunction(()=>document.querySelector('#settings-notice')?.textContent.includes('模拟版本冲突'));
  assert.equal(await dot.isVisible(),true,'提交失败后应保持脏标记');
  assert.equal(Number(await quota.inputValue()),original+11,'提交失败不得覆盖草稿');
  await page.unroute('**/api/projects/*/scheduling');
  await page.locator('[data-unsaved-save]').click();
  await dot.waitFor({state:'hidden'});
  assert.equal((await fixture.request(`/api/projects/${fixture.projectId}/scheduling`)).policy.quotaMaxAgeMinutes,original+11);
  // 同一分区存在两个独立保存入口，一次点击须按顺序完成两次真实持久化。
  await page.locator('[data-settings-tab="execution"]').click();
  const mode=page.locator('#project-execution [name="mode"]');
  const limit=page.locator('#coord-execution-form [name="projectLimit"]');
  const newMode=(await mode.inputValue())==='read_only'?'ask_approval':'read_only';
  const newLimit=(await limit.inputValue())==='3'?'4':'3';
  await mode.selectOption(newMode);
  await limit.fill(newLimit);
  const writes=[];
  page.on('response',response=>{
    if(response.request().method()==='POST'&&response.ok()&&/\/api\/(permissions|projects\/[^/]+\/execution)$/.test(response.url()))writes.push(new URL(response.url()).pathname);
  });
  await page.locator('[data-unsaved-save]').click();
  await page.locator('[data-tab-dirty="execution"]').waitFor({state:'hidden'});
  assert.deepEqual(writes,['/api/permissions',`/api/projects/${fixture.projectId}/execution`]);
  assert.equal((await fixture.request(`/api/projects/${fixture.projectId}/execution`)).projectLimit,Number(newLimit));
  // 供应商列表 + 右侧抽屉：关闭时草稿暂存，重新打开恢复。
  await page.locator('[data-settings-tab="providers"]').click();
  await page.locator('[data-provider-add]').click();
  await page.locator('[data-provider-template="custom"]').click();
  const drawer=page.locator('[data-provider-drawer]');
  await drawer.waitFor();
  const box=await drawer.boundingBox();
  assert(box&&Math.round(box.x+box.width)===1440,'编辑抽屉应停靠页面右侧 '+JSON.stringify(box));
  await drawer.locator('[name="name"]').fill('抽屉草稿供应商');
  await page.screenshot({path:join(output,'provider-drawer-1440.png')});
  await page.keyboard.press('Escape');
  await drawer.waitFor({state:'hidden'});assert.equal(await drawer.isHidden(),true,'Escape 应关闭抽屉');
  await page.locator('[data-provider-add]').click();
  await page.locator('[data-provider-template="custom"]').click();
  await drawer.waitFor();
  assert.equal(await drawer.locator('[name="name"]').inputValue(),'抽屉草稿供应商','重开抽屉应恢复草稿');
  await page.keyboard.press('Escape');
  // 键盘导航：方向键与 Home/End 切换分区并移动焦点。
  const active=()=>page.evaluate(()=>document.activeElement?.id??'');
  await page.locator('#settings-tab-providers').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await active(),'settings-tab-routing');
  assert.equal(await page.locator('[data-settings-tab="routing"]').getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');
  assert.equal(await active(),'settings-tab-scheduling');
  await page.keyboard.press('Home');
  assert.equal(await active(),'settings-tab-providers');
  assert.equal(await page.locator('[data-settings-tab="providers"]').getAttribute('aria-selected'),'true');
  // 窄屏：不产生横向溢出，抽屉全宽可用。
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'设置页窄屏不得横向溢出');
    await page.locator('[data-provider-add]').click();await page.locator('[data-provider-template="custom"]').click();await drawer.waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'抽屉打开时不得横向溢出');
    if(width===390)assert.equal(Math.round((await drawer.boundingBox())?.width??0),390,'窄屏抽屉应全宽');
    await page.screenshot({path:join(output,`settings-${width}.png`)});
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);
  assert.equal(fixture.calls.length,0,'设置页验收不得触发模型调用');
  console.log(JSON.stringify({passed:true,cases:['four-sections','sidebar-history-hidden','route-event-and-restore','dirty-detection','draft-across-sections','discard','save-clears-dirty','submit-failure-keeps-draft','retry-after-failure','multiple-forms-save-in-order','provider-drawer-escape-and-draft','keyboard-navigation','narrow-viewport'],modelCalls:fixture.calls.length,screenshots:output}));
}finally{await browser?.close();await fixture.close();}
