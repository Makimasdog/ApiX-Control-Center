import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codingFixture, finish, action} from './coding-harness.mjs';

/**
 * 完成声明的证据判定
 *
 * 此前的缺口：`observe()` 在没有任务、没有项目根、没有基线时都返回
 * `changes: []`，与"观察了，确实没有改动"无法区分。于是"无法核对"
 * 会被当成"确认没有改动"直接完成——模型只要声称完成，什么都不做也能过。
 *
 * 现在 observe() 明确区分 observed:false / true；拿不到基线时不再视为
 * 已确认的空改动，而是要求核对（有契约按契约验，没有则停在 needs_review）。
 */

test('没有可核对基线时，完成声明不能直接通过', () => {
  return codingFixture(async (h) => {
    // 决策前删掉基线事件：模拟基线扫描受限、无法建立对比起点
    h.queue(
      () => {
        h.db.prepare("DELETE FROM assistant_events WHERE session_id=? AND kind='task_baseline'").run(h.id);
        return JSON.stringify(finish);
      },
      finish,
    );
    await h.service.message(h.id, {content: '声称完成但无法核对工作区'});
    const s = await h.idle();

    assert.notEqual(s.status, 'completed', '无法核对时不应直接完成');
    assert.equal(s.status, 'attention');
    assert(s.events.some((e) => e.kind === 'completion_unobserved'), '应记录无法观察的原因');
    assert(s.events.some((e) => e.kind === 'completion_rejected'), '应拒绝缺少证据的完成声明');
  }, {idleMs: 15000});
});

test('能核对且确实没有改动时，普通问答仍可正常完成', () => {
  return codingFixture(async (h) => {
    h.queue(finish);
    await h.service.message(h.id, {content: '解释这个项目'});
    const s = await h.idle();

    assert.equal(s.status, 'completed', JSON.stringify(s.events.slice(-3)));
    assert(!s.events.some((e) => e.kind === 'completion_unobserved'), '有基线时不应触发无法观察的判定');
  }, {idleMs: 15000});
});

test('有改动但没验证时仍然被拦下，与无法核对是两回事', () => {
  return codingFixture(async (h) => {
    h.queue(action('write_file', {path: 'src/changed.txt', content: 'changed'}), finish);
    await h.service.message(h.id, {content: '修改文件'});
    const s = await h.idle();

    assert.equal(s.status, 'attention');
    assert(!s.events.some((e) => e.kind === 'completion_unobserved'), '能观察时不应误报无法核对');
    assert(s.events.some((e) => e.kind === 'completion_rejected' && /证据/.test(e.body.error ?? '')));
  }, {idleMs: 15000});
});
