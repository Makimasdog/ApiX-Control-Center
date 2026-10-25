import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ESLint} from 'eslint';
import {html} from '../dist/web/html.js';
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

test('all migrated views enforce the innerHTML guard without legacy exemptions',async()=>{
  const eslint=new ESLint();
  assert.equal(await eslint.isPathIgnored('.tmp-review/dist/web/knowledge.js'),true);
  for(const file of ['knowledge.ts','agent-os.js','assistant.ts','autonomy-view.ts','conversation-model.ts','coordinator.ts','employee-settings.ts','mcp-settings.ts','project-picker.ts','provider-center.ts','scheduling-view.ts','task-events.ts','workflow-graph.ts']){
    const filePath='web/'+file;
    assert.equal(await eslint.isPathIgnored(filePath),false);
    const [unsafe]=await eslint.lintText('element.innerHTML = `<p>${value}</p>`;',{filePath});
    assert(unsafe.messages.some(message=>message.ruleId==='no-restricted-syntax'&&message.severity===2),filePath);
    const [safe]=await eslint.lintText('element.innerHTML = html`<p>${value}</p>`;',{filePath});
    assert.equal(safe.errorCount,0,filePath);
  }
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
