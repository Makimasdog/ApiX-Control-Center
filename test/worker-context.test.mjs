import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workerPrompt, MANDATORY_PRESSURE_RATIO} from '../dist/src/agents/worker-context.js';

/**
 * 员工上下文预算：必需资料（用户约束、项目规则）优先于普通资料（前置交付物）。
 * 之前所有参考资料等权分配，用户维护的约束可能被模型生成的背景说明挤掉。
 */

test('必需资料优先获得预算，普通资料使用剩余额度', () => {
  const references = [
    {priority: 'required', text: '项目约束: ' + 'c'.repeat(2000)},
    {priority: 'normal', text: '前置交付: ' + 'd'.repeat(2000)},
  ];
  const {prompt, requiredTruncated} = workerPrompt('任务', '需求', references, 1200);
  assert.match(prompt, /项目约束/);
  assert.equal(requiredTruncated, 1, '必需资料本身仍被截断时应如实计数');
  assert(prompt.length <= 1200);
});

test('普通资料先被牺牲，必需资料保持完整', () => {
  const references = [
    {priority: 'required', text: '项目约束: ' + 'c'.repeat(200)},
    {priority: 'normal', text: '前置交付: ' + 'd'.repeat(5000)},
  ];
  const {prompt, requiredTruncated} = workerPrompt('任务', '需求', references, 1200);
  assert.match(prompt, /项目约束: c{200}/, '必需资料应完整保留');
  assert.equal(requiredTruncated, 0);
  assert(prompt.length <= 1200);
});

test('强制指令占比可被调用方观察，用于提示上下文挤压', () => {
  const {pressure} = workerPrompt('x'.repeat(700), '', [], 1000);
  assert.equal(pressure, MANDATORY_PRESSURE_RATIO);
  assert.equal(workerPrompt('x', '', [], 1000).pressure < MANDATORY_PRESSURE_RATIO, true);
});

test('纯字符串参考资料保持原有等权语义', () => {
  const {prompt, truncated} = workerPrompt('任务', '需求', ['A'.repeat(3000), 'B'.repeat(3000)], 1200);
  assert.match(prompt, /A/);
  assert.match(prompt, /B/);
  assert.equal(truncated, 2);
  assert(prompt.length <= 1200);
});
