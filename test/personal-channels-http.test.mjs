import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startDeliveryFixture} from './delivery-fixture.mjs';
import {fetch as localFetch} from './local-fetch.mjs';

test('Web adapter keeps legacy idempotence and persists scoped attachments', {timeout: 90000}, async () => {
  const marker = Buffer.from('apix-local-only-media-marker');
  const h = await startDeliveryFixture({startupMs:30000,decide(context) {
    assert(!JSON.stringify(context).includes(marker.toString()));
    assert(!JSON.stringify(context).includes(marker.toString('base64')));
    return {action:'finish',outcome:'completed',message:'收到'};
  }});
  try {
    const session = await h.request('/api/assistant/sessions',{projectId:h.projectId});
    const base = '/api/assistant/sessions/' + session.id;
    const first = {content:'旧版入口',requestId:'web-legacy-001'};
    await h.request(base + '/messages',first);
    await h.idle(session.id);
    await h.request(base + '/channel-messages',first);
    const rich = {content:'**附件说明**',format:'markdown',requestId:'web-media-001',
      attachments:[{name:'report.txt',mime:'text/plain',data:marker.toString('base64')}]};
    await h.request(base + '/channel-messages',rich);
    const completed = await h.idle(session.id);
    assert.equal(completed.status,'completed');
    const event = completed.events.find(item => item.body.requestId === rich.requestId);
    assert.equal(event.body.textFormat,'markdown');
    assert.equal(event.body.attachments.length,1);
    const attachment = event.body.attachments[0];
    assert.equal(attachment.kind,'file');
    assert.equal(attachment.bytes,marker.length);
    assert.equal(attachment.data,undefined);
    await h.request(base + '/channel-messages',rich);
    await h.request(base + '/channel-messages',{...rich,attachments:[{...rich.attachments[0],data:'Yg=='}]},409);
    await h.request(base + '/channel-messages',{attachments:[{name:'bad',mime:'image/png',data:'not valid base64'}]},400);
    assert.equal(h.calls.length,2);
    await h.restart();

    const url = h.origin + base + '/media/' + attachment.id;
    assert.equal((await fetch(url)).status,401);
    const file = await localFetch(url);
    assert.equal(file.status,200);
    assert.equal(file.headers.get('content-type'),'application/octet-stream');
    assert.equal(file.headers.get('x-content-type-options'),'nosniff');
    assert.match(file.headers.get('content-disposition'),/^attachment/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()),marker);
    const other = await h.request('/api/assistant/sessions',{projectId:h.projectId});
    await h.request('/api/assistant/sessions/' + other.id + '/media/' + attachment.id,undefined,404);
    const latest = await h.request(base);
    await h.request('/api/chat-history/assistant/' + session.id,{action:'delete',version:latest.version});
    assert.equal((await localFetch(url)).status,404);
  } finally {
    await h.close();
  }
});
