import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveryForm } from '../dist/web/execution-view.js';

const delivery={status:'queued',latestRun:undefined,processMayExist:null,managedActive:false,recoveryFingerprint:'fp'};
const task={employee_id:'a',queue_reason:'项目暂停'};
const employees=[{id:'a',name:'员工 A',runtime:'codex'},{id:'b',name:'员工 B',runtime:'claude'}];
const render=(overrides={},accepted=true)=>recoveryForm({...delivery,...overrides},task,employees,accepted);
const button=html=>html.match(/<button\b[^>]*>/)[0];

test('never-run queued form shows actual queue reason and dependency precondition',()=>{
  const html=render();
  assert.match(html,/项目暂停/);
  assert.match(html,/前置任务全部验收后才能换员工/);
  assert.match(html,/未启动过，无历史运行记录/);
  assert.match(html,/已检查依赖验收状态、换员工原因与验收要求/);
  assert.match(html,/<option value="a" selected>/);
  assert.match(html,/换员工并重新排队/);
  assert.doesNotMatch(button(html),/disabled/);
});

test('previously-run queued form still requires reviewing code and report',()=>{
  const html=render({latestRun:{id:'run-1',status:'failed',pid:12},processMayExist:false});
  assert.match(html,/最近运行：run-1/);
  assert.match(html,/未发现原 PID/);
  assert.match(html,/检查完整代码和运行报告/);
  assert.match(html,/已检查最新代码、运行报告与验收要求/);
  assert.doesNotMatch(html,/无历史运行记录/);
});

test('recovery stays disabled without accepted dependencies, fingerprint or while managed active',()=>{
  const pending=render({},false);
  assert.match(button(pending),/disabled/);
  assert.match(pending,/请先验收全部前置任务/);
  const noFingerprint=render({recoveryFingerprint:null});
  assert.match(button(noFingerprint),/disabled/);
  assert.match(noFingerprint,/暂时无法取得恢复指纹/);
  const active=render({managedActive:true});
  assert.match(button(active),/disabled/);
  assert.match(active,/任务正在运行/);
});

test('all other recovery statuses keep code review; unknown requires explicit stop confirmation',()=>{
  for(const status of ['failed','cancelled','unknown','needs_revision','blocked']) {
    const html=render({status});
    assert.match(html,/检查后重新批准/);
    assert.match(html,/已检查最新代码、运行报告与验收要求/);
    assert.match(html,/重新批准并排队执行/);
    assert.equal(html.includes('name="confirmedStopped" required'),status==='unknown');
  }
});

test('runtime text and employee metadata are escaped in actual rendered form',()=>{
  const html=recoveryForm({...delivery,latestRun:{id:'<script>',status:'"bad"',pid:null}},{employee_id:'"a',queue_reason:'<img onerror="bad">'},[{id:'"a',name:'<script>',runtime:'a&b'}],true);
  assert.doesNotMatch(html,/<script>|<img/);
  assert.match(html,/&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.match(html,/value="&quot;a" selected/);
  assert.match(html,/a&amp;b/);
});

test('missing queue reason is shown as unknown without inventing a cause',()=>{
  const html=recoveryForm(delivery,{employee_id:'a'},employees,true);
  assert.match(html,/未提供，请核对任务和项目执行状态/);
});
