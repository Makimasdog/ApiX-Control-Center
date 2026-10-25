import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ESLint} from 'eslint';
import {html,escapeHtml} from '../dist/web/html.js';
import {assistantTimeline,escapeAssistant} from '../dist/web/assistant-view.js';
import {deliveryView} from '../dist/web/delivery-view.js';
import {recoveryForm} from '../dist/web/execution-view.js';
import {readinessView} from '../dist/web/readiness.js';
import {rendererFixture} from './renderer-fixture.mjs';
import {autonomySummary} from '../dist/web/autonomy-view.js';
import {taskEventList} from '../dist/web/task-events.js';

test('html escapes text and quoted attributes, including markup-looking input',()=>{
  const payload='"><img src=x onerror="window.pwned=1"> & \'text\'';
  const escaped='&quot;&gt;&lt;img src=x onerror=&quot;window.pwned=1&quot;&gt; &amp; &#39;text&#39;';
  assert.equal(html`<p title="${payload}">${payload}</p>`,`<p title="${escaped}">${escaped}</p>`);
  assert.equal(html`<p>${'&lt;script&gt;'}</p>`,'<p>&amp;lt;script&amp;gt;</p>');
});

test('html preserves false and zero, handles absent values and composes escaped fragments',()=>{
  assert.equal(html`${null}|${undefined}|${0}|${false}`,'||0|false');
  const items=['<first>','second & third'].map(value=>html`<li>${value}</li>`).join('');
  assert.equal('<ul>'+items+'</ul>','<ul><li>&lt;first&gt;</li><li>second &amp; third</li></ul>');
  // An already rendered string stays untrusted when interpolated again.
  assert.equal(html`${html`<b>${'hello'}</b>`}`,'&lt;b&gt;hello&lt;/b&gt;');
});

test('the legacy escapeAssistant export uses the shared leaf implementation',()=>{
  assert.equal(escapeAssistant,escapeHtml);
  for(const value of [null,undefined,false,0,'<>&"\''])assert.equal(escapeAssistant(value),html`${value}`);
});

test('all migrated views enforce the innerHTML guard without legacy exemptions',async()=>{
  const eslint=new ESLint();
  assert.equal(await eslint.isPathIgnored('.tmp-review/dist/web/knowledge.js'),true);
  for(const file of ['knowledge.ts','agent-os.js','assistant.ts','autonomy-view.ts','conversation-model.ts','coordinator.ts','employee-settings.ts','mcp-settings.ts','project-picker.ts','provider-center.ts','scheduling-view.ts','task-events.ts','workflow-graph.ts','assistant-view.ts','delivery-view.ts','execution-view.ts','readiness.ts','chat-history.ts','employee.ts','overview.ts']){
    const filePath='web/'+file;
    assert.equal(await eslint.isPathIgnored(filePath),false);
    const [unsafe]=await eslint.lintText('element.innerHTML = `<p>${value}</p>`;',{filePath});
    assert(unsafe.messages.some(message=>message.ruleId==='no-restricted-syntax'&&message.severity===2),filePath);
    const [safe]=await eslint.lintText('element.innerHTML = html`<p>${value}</p>`;',{filePath});
    assert.equal(safe.errorCount,0,filePath);
  }
});

test('timeline keeps real citation and evidence controls without turning surrounding data into markup',()=>{
  const f=rendererFixture('"><img src=x onerror="window.p9Injected=1"> & quote');
  const output=assistantTimeline(f.timeline);
  assert.equal((output.match(/data-kb-citation=/g)??[]).length,2);
  assert(output.includes('data-kb-citation="'+f.citation+'"'));
  assert(output.includes('data-output-reference="&quot;&gt;&lt;img'));
  assert(output.includes('data-command-log="&quot;&gt;&lt;img'));
  assert(output.includes('日志不完整：未采集'));
  assert(output.includes('+0 / −'));
  assert(!output.includes('&amp;lt;img'));
  assert(!output.includes('<img'));
  assert.equal(assistantTimeline([{id:1,role:'system',kind:'message',body:{content:'.'}}]),'');
  assert(assistantTimeline([{id:1,role:'user',kind:'message',body:{content:'.'}}]).includes('<div>.</div>'));
});

test('delivery, recovery and readiness keep controls, guards and escaped detail branches',()=>{
  const f=rendererFixture('"><img src=x onerror="window.p9Injected=1"> & quote');
  const outputs=[deliveryView(f.review,false),recoveryForm(f.recovery,f.recoveryTask,f.employees,true),readinessView(f.readiness)];
  for(const output of outputs){assert(!output.includes('<img'));assert(!output.includes('&amp;lt;img'));assert(output.includes('&lt;img'));}
  assert(outputs[0].includes('data-delivery-version="0"'));
  assert(outputs[0].includes('源码快照、依赖准备与本次产物'));
  assert(outputs[0].includes('<blockquote>'));
  assert.match(outputs[0],/data-delivery-action="accept"[^>]* disabled/);
  assert(outputs[1].includes('name="confirmedStopped" required'));
  assert(outputs[1].includes('name="reviewed" required'));
  assert(outputs[2].includes('data-setup-action="model"'));
  assert.equal((outputs[2].match(/data-setup-action=/g)??[]).length,1);
});

test('autonomy and event fragments preserve nested markup while escaping every data field',()=>{
  const payload='"><img src=x onerror="window.pwned=1"> & quote';
  const output=autonomySummary({state:'attention',reason:payload,architecture:{summary:payload,digest:payload,modules:[{name:payload,difficulty:3,risk:'high',paths:[payload],dependsOn:[],acceptance:[payload],checkIds:[],interfaces:{},dataStructures:{},workload:{}}]},checks:[{status:'failed',task_id:payload,fingerprint:payload,body:{text:payload}}],repairs:[{attempt:1,status:'blocked',employee_id:payload,instruction:payload}]});
  assert(output.includes('<details><summary>'));
  assert(output.includes('<p role="alert">&quot;&gt;&lt;img'));
  assert(!output.includes('<img'));
  assert(!output.includes('&amp;lt;img'));
  const events=taskEventList([{kind:payload,created_at:'2026-10-25T00:00:00Z',payload}]);
  assert(events.includes('<details class="task-event-card">'));
  assert(events.includes('&lt;img'));
  assert(!events.includes('<img'));
});
