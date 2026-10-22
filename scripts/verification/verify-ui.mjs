// Optional Playwright audit: no remote model calls or personal application data.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';

const moduleName = process.env.APIX_PLAYWRIGHT_MODULE ?? 'playwright';
const {chromium} = await import(isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const output = resolve('.tmp-ui-review');
await mkdir(output, {recursive: true});
const fixture = await startDeliveryFixture({name:'ApiX 界面验收项目',startupMs:20000});
let browser;
const report = {cases:[],errors:[],contrasts:{}};
function contrast(a,b) {
  const luminance = hex => {
    const rgb = hex.trim().replace('#','').match(/../g).map(n=>parseInt(n,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  };
  const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);
  return (values[0]+.05)/(values[1]+.05);
}
try {
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const routes = ['assistant','overview','settings','coordinator','missions','memory','models','projects','resources'];
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    for (const width of [1440,1024,768,390]) {
      console.log(`UI audit: ${theme} ${width}px`);
      await page.setViewportSize({width,height:900});
      await page.goto(fixture.origin, {waitUntil:'load'});
      await page.waitForSelector('#assistant-input');
      await page.waitForSelector('.sidebar-project', {state:'attached'});
      await page.waitForFunction(() => document.querySelector('[aria-current="page"]')?.dataset.pageTarget === 'assistant');
      if (width === 1440) {
        const tokens = await page.evaluate(()=>Object.fromEntries(['text-primary','text-secondary','text-muted','surface','app-bg','on-accent','accent','success','success-subtle','warning','warning-subtle','danger','danger-subtle'].map(name=>[name,getComputedStyle(document.documentElement).getPropertyValue('--'+name)])));
        report.contrasts[theme] = Object.fromEntries([['text-primary','surface'],['text-secondary','surface'],['text-muted','app-bg'],['on-accent','accent'],['success','success-subtle'],['warning','warning-subtle'],['danger','danger-subtle']].map(([a,b])=>[a,Math.round(contrast(tokens[a],tokens[b])*100)/100]));
      }
      for (const route of routes) {
        if (width <= 760) await page.locator('#navigation-toggle').click();
        const target = page.locator(`.nav-item[data-page-target="${route}"]`);
        if (await target.evaluate(el=>el.closest('details') && !el.closest('details').open)) await page.locator('.assistant-more > summary').click();
        await target.click();
        await page.waitForSelector(`#page-${route}.active-page`);
        await page.waitForTimeout(150);
        const result = await page.evaluate(() => {
          const active = document.querySelector('.page.active-page');
          const box = active.getBoundingClientRect();
          const overflow = [...active.querySelectorAll('*')].filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.right > innerWidth + 2 && getComputedStyle(el).position !== 'fixed';
          }).slice(0,5).map(el => ({tag:el.tagName,id:el.id,class:el.className}));
          return {documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,pageRight:Math.round(box.right),overflow,
            navigationClosed:!document.body.hasAttribute('data-navigation-open'),
            missingInputNames:[...active.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(el=>el.checkVisibility({visibilityProperty:true}) && !el.disabled &&
              !(el.labels?.length||el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||el.title)).map(el=>el.id||el.name),
            missingButtonNames:[...active.querySelectorAll('button')].filter(el => el.checkVisibility({visibilityProperty:true}) && !el.disabled &&
              !(el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||el.innerText.trim()||el.title)).map(el=>el.id||el.className)};
        });
        const key = `${theme}-${width}-${route}`;
        report.cases.push({key,...result});
        if (width === 1440 || width === 390) await page.screenshot({path:join(output,key+'.png')});
      }
      await page.locator('.nav-item[data-page-target="assistant"]').evaluate(el=>el.click());
      await page.locator('#assistant-details').click();
      assert(await page.locator('#assistant-inspector').isVisible(), '工作详情应可展开');
      await page.locator('#assistant-details').click();
      assert(!await page.locator('#assistant-inspector').isVisible(), '工作详情应可收起');
      if (width <= 760) {
        await page.locator('#navigation-toggle').click();
        await page.screenshot({path:join(output,`${theme}-${width}-navigation.png`)});
        await page.keyboard.press('Shift+Tab');
        const focus = await page.evaluate(()=>({inside:document.querySelector('#main-navigation').contains(document.activeElement),id:document.activeElement?.id,dialogs:[...document.querySelectorAll('dialog[open]')].map(el=>el.id)}));
        assert(focus.inside,JSON.stringify(focus));
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#navigation-toggle').getAttribute('aria-expanded'),'false');
        assert(await page.locator('#main-navigation').evaluate(el=>el.inert));
        assert(await page.locator('#navigation-toggle').evaluate(el=>el===document.activeElement));
      }
    }
  }
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  assert.deepEqual(report.errors,[],'页面存在未处理的 JavaScript 错误');
  const failures = report.cases.filter(c=>c.documentWidth>c.viewport+1 || c.pageRight>c.viewport+1 || !c.navigationClosed || c.missingButtonNames.length || c.missingInputNames.length);
  assert.deepEqual(failures,[], '页面溢出、导航或按钮名称检查失败，详见 .tmp-ui-review/report.json');
  assert.equal(fixture.calls.length,0,'UI 检查不应调用模型');
  assert(Object.values(report.contrasts).every(theme=>Object.values(theme).every(ratio=>ratio>=4.5)), '语义文字配色未达到 4.5:1');
  console.log(JSON.stringify({passed:true,cases:report.cases.length,screenshots:output,modelCalls:fixture.calls.length}));
} finally {
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();
  await fixture.close();
}
