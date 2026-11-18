import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {startDeliveryFixture} from './delivery-fixture.mjs';

const base = '/api/personal-memory';
const secret = 'private-memory-marker';
const finish = {action:'finish',outcome:'completed',message:'完成'};

test('personal memory persists locally, recalls across sessions and honors forgetting', {timeout: 90000}, async () => {
  const fixture = await startDeliveryFixture({startupMs: 30000, decide(context) {
    assert(!JSON.stringify(context).includes(secret));
    return finish;
  }});
  try {
    const {origin, request, projectId} = fixture;
    assert.equal((await fetch(origin + base)).status, 401);
    assert.equal((await fetch(origin + base + '/work', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"title":"unauthorized"}',
    })).status, 401);
    assert.deepEqual(await request(base), []);
    await request(base + '/work', [], 400);
    await request(base + '/work', {title:'咖啡',content:'到期日非法',expiresAt:'2026-02-31T00:00:00.000Z'}, 400);
    const work = await request(base + '/work', {title:'咖啡采购',content:secret});
    const long = await request(base + '/long-term', {title:'咖啡偏好',content:'## 研磨\n偏细',recall:false});
    const expired = await request(base + '/work', {title:'咖啡活动',content:'过期计划',expiresAt:'2000-01-01T00:00:00.000Z'});

    const workPath = base + '/work/' + work.id;
    const longPath = base + '/long-term/' + long.id;
    const file = join(fixture.dir, 'data', 'personal-memory', long.id + '.md');
    assert.match(await readFile(file, 'utf8'), /## 研磨\n偏细/);
    await request(base + '/work/' + long.id, undefined, 404);
    await request(base + '/long-term/%2e%2e%2fapix.sqlite', undefined, 404);
    await request(workPath, {title:'咖啡采购',content:'过时的版本',version:2}, 409);
    const stillPrivate = await request(longPath, {title:'咖啡偏好',content:'## 研磨\n偏粗',version:long.version});
    assert.equal(stillPrivate.recall, false);
    assert.deepEqual((await request(base + '/recall', {query:'咖啡'})).map(record => record.id), [work.id]);
    assert.deepEqual(await request(base + '/recall', {query:'无关查询'}), []);
    const enabled = await request(longPath, {...stillPrivate,recall:true});
    await fixture.restart();
    assert.deepEqual(await request(longPath), enabled);
    assert.deepEqual(await request(workPath), work);
    assert.equal((await request(base)).length, 3);

    const sessionIds = [];
    for (let index = 0; index < 2; index++) {
      const session = await request('/api/assistant/sessions', {projectId});
      sessionIds.push(session.id);
      const recallPath = base + '/sessions/' + session.id + '/recall';
      assert.deepEqual(await request(recallPath), []);
      await request('/api/assistant/sessions/' + session.id + '/messages', {content:'咖啡'});
      assert.equal((await fixture.idle(session.id)).status, 'completed');
      const recalled = await request(recallPath);
      assert.deepEqual(new Set(recalled.map(record => record.id)), new Set([work.id, long.id]));
      assert(recalled.every(record => record.score > 0));
    }
    assert.equal(fixture.calls.length, 2);

    await request(longPath + '/delete', {version:long.version}, 409);
    await request(longPath + '/delete', {version:enabled.version});
    await assert.rejects(readFile(file, 'utf8'), {code:'ENOENT'});
    await request(workPath + '/delete', {version:work.version});
    assert.deepEqual(await request(base), [expired]);
    for (const id of sessionIds) assert.deepEqual(await request(base + '/sessions/' + id + '/recall'), []);
    const latest = await request('/api/assistant/sessions/' + sessionIds[0]);
    await request('/api/chat-history/assistant/' + latest.id, {action:'delete',version:latest.version});
    await request(base + '/sessions/' + latest.id + '/recall', undefined, 404);
  } finally {
    await fixture.close();
  }
});
