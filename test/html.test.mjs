import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ESLint} from 'eslint';
import {html} from '../dist/web/html.js';

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

test('knowledge view enforces the innerHTML guard after leaving the legacy exemption',async()=>{
  const eslint=new ESLint();
  assert.equal(await eslint.isPathIgnored('.tmp-review/dist/web/knowledge.js'),true);
  assert.equal(await eslint.isPathIgnored('web/knowledge.ts'),false);
  const [unsafe]=await eslint.lintText('element.innerHTML = `<p>${value}</p>`;',{filePath:'web/knowledge.ts'});
  assert(unsafe.messages.some(message=>message.ruleId==='no-restricted-syntax'&&message.severity===2));
  const [safe]=await eslint.lintText('element.innerHTML = html`<p>${value}</p>`;',{filePath:'web/knowledge.ts'});
  assert.equal(safe.errorCount,0);
});
