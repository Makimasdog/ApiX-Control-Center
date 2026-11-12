import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdir, unlink, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {startDeliveryFixture} from './delivery-fixture.mjs';

async function waitFor(read, predicate) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  assert.fail('Gateway did not reach the expected state');
}

test('standalone Gateway persists Cron and catches up once after a restart', {timeout: 60000}, async () => {
  const h = await startDeliveryFixture({startupMs: 30000, serverArgs: ['--gateway']});
  const base = '/api/projects/' + h.projectId + '/gateway';
  const dbPath = join(h.dir, 'data', 'apix.sqlite');
  const config = {name: '每日待办', trigger: {kind:'cron', expression:'0 8 * * *', timeZone:'Asia/Hong_Kong'}};
  try {
    const status = await h.request('/api/gateway/status');
    assert.equal(status.mode, 'standalone');
    assert.equal(status.running, true);
    assert.equal((await fetch(h.origin + base)).status, 401);
    await h.request(base + '/rules', {...config, trigger: {...config.trigger, timeZone:'Wrong/Timezone'}}, 400);
    const rule = await h.request(base + '/rules', config);
    assert.equal(new Date(rule.nextAt).getUTCHours(), 0);
    assert.equal(new Date(rule.nextAt).getUTCMinutes(), 0);
    await h.request(base + '/rules/' + rule.id, {...config, revision:99}, 409);
    const due = Date.now() - 3 * 86400000;
    await h.restart(() => {
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare('UPDATE assistant_gateway_rules SET next_at=? WHERE id=?').run(due, rule.id);
      } finally {
        db.close();
      }
    });
    const received = await waitFor(() => h.request(base), value => value.runs.length > 0);
    assert.equal(received.runs.length, 1);
    assert.equal(received.runs[0].scheduled_at, due);
    assert.equal(received.runs[0].status, 'delivered');
    assert.match(received.runs[0].message, /待处理事项/);
    assert.equal(received.unread, 1);
    assert(received.rules[0].nextAt > Date.now());
    const paused = await h.request(base + '/rules/' + rule.id, {...config, enabled:false, revision:rule.revision});
    assert.equal(paused.nextAt, null);
    await h.request(base + '/runs/' + received.runs[0].id + '/read', {});
    await h.request(base + '/rules/' + rule.id + '/delete', {revision:paused.revision});
    await h.restart();
    const persisted = await h.request(base);
    assert.deepEqual(persisted.rules, []);
    assert.equal(persisted.runs.length, 1);
    assert.equal(persisted.unread, 0);
    assert.equal(h.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('Heartbeat stays quiet without changes and file, Git and mail events reach the local inbox', {timeout: 120000}, async () => {
  const h = await startDeliveryFixture({startupMs: 30000, serverArgs:['--gateway'], decide: () => ({
    action:'ask', question:'需要确认安排', options:['继续','稍后'], multiple:false,
  })});
  const base = '/api/projects/' + h.projectId + '/gateway';
  let db;
  try {
    db = new DatabaseSync(join(h.dir, 'data', 'apix.sqlite'));
    const heartbeat = await h.request(base + '/rules', {name:'检查待回复',trigger:{kind:'heartbeat',intervalSeconds:60}});
    const read = () => h.request(base);
    const checkHeartbeat = async () => {
      const before = (await read()).rules.find(item => item.id === heartbeat.id).lastCheckedAt ?? 0;
      db.prepare('UPDATE assistant_gateway_rules SET next_at=? WHERE id=?').run(Date.now() - 1, heartbeat.id);
      return waitFor(read, state => state.rules.find(item => item.id === heartbeat.id).lastCheckedAt > before);
    };
    assert.deepEqual((await checkHeartbeat()).runs, []);
    const session = await h.request('/api/assistant/sessions', {projectId:h.projectId});
    await h.request('/api/assistant/sessions/' + session.id + '/messages', {content:'请先确认安排'});
    assert.equal((await h.idle(session.id)).status, 'waiting_user');
    const alerted = await checkHeartbeat();
    assert.equal(alerted.runs.length, 1);
    assert.match(alerted.runs[0].message, /待回复 1 项/);
    assert.equal((await checkHeartbeat()).runs.length, 1);

    await h.request(base + '/rules', {name:'越界文件',trigger:{kind:'file',path:'../outside.txt'}}, 400);
    await h.request(base + '/rules', {name:'受保护文件',trigger:{kind:'file',path:'.env'}}, 400);
    const file = join(h.project,'note.txt');
    const watched = await h.request(base + '/rules', {name:'文件更新',trigger:{kind:'file',path:'note.txt',intervalSeconds:2}});
    await writeFile(file,'first');
    const created = await waitFor(read, state => state.runs.some(run => run.rule_id === watched.id));
    assert.match(created.runs.find(run => run.rule_id === watched.id).message, /已创建/);
    await unlink(file);
    await waitFor(read, state => state.runs.some(run => run.rule_id === watched.id && /已删除/.test(run.message)));

    const git = await h.request(base + '/rules', {name:'Git 提醒',trigger:{kind:'git.push',source:'team/repo'}});
    const mail = await h.request(base + '/rules', {name:'收件提醒',trigger:{kind:'mail.received',source:'inbox'}});
    const push = {kind:'git.push',source:'team/repo',eventId:'push-1',summary:'main 有新提交'};
    const incoming = {kind:'mail.received',source:'inbox',eventId:'mail-1'};
    assert.deepEqual(await h.request(base + '/events', {...push,source:'other/repo'}), {duplicate:false,delivered:0});
    assert.equal((await fetch(h.origin + base + '/events', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(push),
    })).status, 401);
    db.exec("CREATE TRIGGER fail_gateway_delivery BEFORE INSERT ON assistant_gateway_runs WHEN NEW.rule_id='" + git.id +
      "' BEGIN SELECT RAISE(ABORT,'test delivery error'); END");
    await h.request(base + '/events', push, 500);
    db.exec('DROP TRIGGER fail_gateway_delivery');
    assert.deepEqual(await h.request(base + '/events', push), {duplicate:false,delivered:1});
    assert.deepEqual(await h.request(base + '/events', incoming), {duplicate:false,delivered:1});
    db.close();
    db = undefined;
    await h.restart();
    assert.deepEqual(await h.request(base + '/events', push), {duplicate:true,delivered:0});
    const events = (await read()).runs.filter(run => [git.id,mail.id].includes(run.rule_id));
    assert.equal(events.length, 2);
    assert(events.some(run => run.message.includes('main 有新提交')));
    const otherPath = join(h.dir,'other');
    await mkdir(otherPath);
    const other = (await h.request('/api/projects',{name:'另一个项目',path:otherPath})).id;
    const otherBase = '/api/projects/' + other + '/gateway';
    assert.equal((await h.request(otherBase)).runs.length, 0);
    await h.request(otherBase + '/runs/' + events[0].id + '/read', {}, 404);
    assert.equal(h.calls.length, 1);
  } finally {
    db?.close();
    await h.close();
  }
});
