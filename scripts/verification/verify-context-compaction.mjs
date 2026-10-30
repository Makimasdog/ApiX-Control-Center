import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
let response={summary:'中'.repeat(6000)},browser,db;
const fixture=await startDeliveryFixture({startupMs:30000,usage:{prompt_tokens:1000,completion_tokens:50},summarize:()=>response,decide:()=>({action:'finish',outcome:'completed',message:'本地只读回归完成'})});
try{
 let s=await fixture.request('/api/assistant/sessions',{projectId:fixture.projectId});const base='/api/assistant/sessions/'+s.id;
 s=await fixture.request(base+'/optimization',{version:s.version,mode:'saving',promptStrategy:'stable-prefix-v1',promptSettingsVersion:0});s=await fixture.request(base+'/tasks',{version:s.version,description:'只读约束回归'});
 db=new DatabaseSync(join(fixture.dir,'data','apix.sqlite'));
 for(let i=0;i<6;i++)db.prepare('INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,?,?,?,?)').run(s.id,'user','message',JSON.stringify({content:'保留约束'+i+'x'.repeat(1000)}),new Date().toISOString());
 await fixture.request(base+'/messages',{content:'只读完成'});s=await fixture.idle(s.id);assert.equal(s.status,'completed');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({p,s})=>{localStorage.setItem('apix.selectedProject',p);localStorage.setItem('apix.assistant.'+p,s);},{p:fixture.projectId,s:s.id});await fixture.authorize(page);await page.goto(fixture.origin);await page.locator('#assistant-details').click();
 await page.locator('#assistant-compact [name=focus]').fill('保留用户只读约束');await page.locator('#assistant-compact button').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-budget')?.textContent.includes('上次压缩没有缩小上下文'));assert.equal(fixture.calls.filter(c=>c.phase==='compact').length,1);
 for(let i=0;i<2;i++){await page.locator('#assistant-context-refresh').click();await page.waitForFunction(()=>document.querySelector('#assistant-budget')?.textContent.includes('自动压缩已暂停'));}assert.equal(fixture.calls.filter(c=>c.phase==='compact').length,1);
 await fixture.restart();await page.reload();await page.locator('#assistant-details').click();await page.locator('#assistant-context-refresh').click();await page.waitForFunction(()=>document.querySelector('#assistant-budget')?.textContent.includes('上次压缩没有缩小上下文'));
 const settings=JSON.parse(db.prepare("SELECT settings FROM conversation_models WHERE kind='assistant' AND session_id=?").get(s.id).settings);
 settings.contextWindow=4096;db.prepare("UPDATE conversation_models SET settings=?,version=version+1 WHERE kind='assistant' AND session_id=?").run(JSON.stringify(settings),s.id);await fixture.request(base+'/stop',{});await page.locator('#assistant-resume').waitFor({state:'visible'});page.once('dialog',d=>d.accept());const resumed=page.waitForResponse(r=>r.url().endsWith(base+'/resume')&&r.request().method()==='POST');await page.locator('#assistant-resume').click();assert.equal((await resumed).status(),200);s=await fixture.idle(s.id);assert.equal(s.status,'attention');assert.equal(fixture.calls.filter(c=>c.phase==='compact').length,1);
 await page.locator('#assistant-context-refresh').click();await page.waitForFunction(()=>document.querySelector('#assistant-budget')?.textContent.includes('自动压缩已暂停'));
 const output=resolve('.tmp-context-compaction-review');await mkdir(output,{recursive:true});
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.locator('#assistant-budget').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'suppressed-'+width+'.png'),animations:'disabled'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 settings.contextWindow=131072;db.prepare("UPDATE conversation_models SET settings=?,version=version+1 WHERE kind='assistant' AND session_id=?").run(JSON.stringify(settings),s.id);response={summary:'保留用户只读约束与已确认事实'};await page.reload();await page.locator('#assistant-details').click();await page.locator('#assistant-compact button').click();await page.waitForFunction(()=>document.querySelector('#assistant-budget')?.textContent.includes('压缩历史 (1)'));
 assert.equal((await fixture.request(base+'/context')).compaction,null);assert.equal(fixture.calls.filter(c=>c.phase==='compact').length,2);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:['no-gain-visible','refresh-no-retry','server-restart-persistence','resume-no-retry','manual-retry','atomic-clear','responsive','no-browser-errors'],localModelCalls:fixture.calls.length,paidModelCalls:0,output}));
}finally{db?.close();await browser?.close();await fixture.close();}
