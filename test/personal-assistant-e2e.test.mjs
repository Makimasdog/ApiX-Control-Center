import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {startDeliveryFixture} from './delivery-fixture.mjs';
import {fetch as ownerFetch} from './local-fetch.mjs';

async function until(read,predicate,label){
  let value;
  for(let attempt=0;attempt<100;attempt++){
    value=await read();
    if(predicate(value))return value;
    await delay(100);
  }
  assert.fail(label + ': ' + JSON.stringify(value));
}

test('standalone Gateway links Web skill writes, local recall and isolated external conversations across restart',{timeout:120000},async()=>{
  const serverEnv={APIX_MESSAGE_CHANNELS:'[]'};
  const workMarker='work-memory-private-marker';
  const longMarker='long-memory-private-marker';
  const media='local-channel-attachment';
  const tool='skill_file_write';
  const filename='src/gateway-acceptance.txt';
  const h=await startDeliveryFixture({
    startupMs:30000,nodeArgs:['--import','./test/personal-assistant-provider-fixture.mjs'],serverArgs:['--gateway'],serverEnv,
    decide(context){
      const value=JSON.stringify(context);
      for(const marker of [workMarker,longMarker,media])assert(!value.includes(marker));
      if(context.currentTask.description.includes('写入')){
        const result=context.history.find(event=>event.kind==='tool_result'&&event.body.tool===tool);
        if(!result)return {action:'tool',tool,args:{path:filename,content:'skill artifact'},message:'写入验收文件'};
        assert.equal(result.body.ok,true);
        assert.equal(result.body.result.path,filename);
        return {action:'ask',question:'请确认提醒是否已送达',options:['已收到','稍后查看'],multiple:false};
      }
      return {action:'finish',outcome:'completed',message:'查看提醒'};
    },
    channelReply(prompt){
      assert.equal(['wechat','telegram','discord'].filter(channel=>prompt.includes(channel)).length,1);
      assert.match(prompt,/不能读取工作区、其他会话或使用工具/);
      for(const marker of [workMarker,longMarker,media,tool,filename])assert(!prompt.includes(marker));
      return 'local protocol reply';
    },
  });
  const {projectId,request}=h;
  const project='/api/projects/'+projectId;
  const gateway=project+'/gateway';
  const memory='/api/personal-memory';
  const sessions='/api/assistant/sessions';
  const web=(id)=>sessions+'/'+id+'/channel-messages';
  const recall=(id)=>request(memory+'/sessions/'+id+'/recall');
  try{
    assert.equal((await request('/api/gateway/status')).mode,'standalone');
    const work=await request(memory+'/work',{title:'咖啡验收记录',content:workMarker});
    const long=await request(memory+'/long-term',{title:'咖啡验收偏好',content:longMarker});
    const installed=await request(project+'/agent-skills/install',{market:{id:'file-write',version:'1.0.0'}});
    await request(project+'/agent-skills/file-write/enabled',{enabled:true,revision:installed.revision});
    const rule=await request(gateway+'/rules',{name:'技能产物变化',trigger:{kind:'file',path:filename,intervalSeconds:2}});
    const heartbeat=await request(gateway+'/rules',{name:'会话待回复',trigger:{kind:'heartbeat',intervalSeconds:60}});
    assert.equal((await request(gateway)).unread,0);

    const first=await request(sessions,{projectId});
    const rich={content:'**咖啡验收** 写入文件',format:'markdown',requestId:'acceptance-web-first',
      attachments:[{name:'sample.txt',mime:'text/plain',data:Buffer.from(media).toString('base64')}]};
    await request(web(first.id),rich);
    const completed=await h.idle(first.id);
    assert.equal(completed.status,'waiting_user');
    const write=completed.events.find(event=>event.kind==='tool_result'&&event.body.tool===tool);
    assert.equal(write.body.ok,true);
    assert(completed.events.some(event=>event.kind==='file_edit_result'));
    const message=completed.events.find(event=>event.body.requestId===rich.requestId);
    assert.equal(message.body.textFormat,'markdown');
    assert.equal(message.body.attachments.length,1);
    assert.equal(await readFile(join(h.project,filename),'utf8'),'skill artifact');
    assert.deepEqual(new Set((await recall(first.id)).map(item=>item.id)),new Set([work.id,long.id]));
    await request(web(first.id),rich);
    assert.equal(h.calls.length,2);

    const state=await until(()=>request(gateway),value=>value.runs.some(run=>run.rule_id===rule.id),'skill write did not trigger file reminder');
    const run=state.runs.find(item=>item.rule_id===rule.id);
    assert.match(run.message,/已创建/);
    assert.equal(state.unread,1);
    await request(gateway+'/runs/'+run.id+'/read',{});

    // Advance the persisted deadline while leaving the real Gateway tick in charge of delivery.
    const db=new DatabaseSync(join(h.dir,'data','apix.sqlite'));
    try{
      db.prepare('UPDATE assistant_gateway_rules SET next_at=? WHERE id=?').run(Date.now()-1,heartbeat.id);
    }finally{db.close();}
    const pending=await until(()=>request(gateway),value=>value.runs.some(item=>item.rule_id===heartbeat.id),'waiting conversation did not trigger heartbeat');
    const heartbeatRun=pending.runs.find(item=>item.rule_id===heartbeat.id);
    assert.match(heartbeatRun.message,/待回复 1 项/);
    await request(gateway+'/runs/'+heartbeatRun.id+'/read',{});
    assert.equal(h.calls.length,2);

    const accounts=[
      {channel:'wechat',accountId:'wechat',peerId:'owner',tokenEnv:'APIX_CHANNEL_WECHAT_TOKEN'},
      {channel:'telegram',accountId:'telegram',peerId:'101',conversationId:'202',tokenEnv:'APIX_CHANNEL_TELEGRAM_TOKEN'},
      {channel:'discord',accountId:'discord',peerId:'102',conversationId:'203',tokenEnv:'APIX_CHANNEL_DISCORD_TOKEN'},
    ];
    Object.assign(serverEnv,{
      APIX_MESSAGE_CHANNELS:JSON.stringify(accounts.map(account=>({...account,projectId}))),
      APIX_CHANNEL_WECHAT_TOKEN:'fixture-wechat-token',APIX_CHANNEL_TELEGRAM_TOKEN:'123:fixture_telegram_token',
      APIX_CHANNEL_DISCORD_TOKEN:'fixture-discord-token',
    });
    await h.restart();
    const channels=()=>request('/api/assistant/channels');
    const delivered=await until(channels,value=>value.accounts.length===3&&value.accounts.every(account=>account.recent[0]?.state==='sent'),'external channel delivery did not complete');
    assert.equal(delivered.configurationError,false);
    assert(!JSON.stringify(delivered).includes('fixture-'));
    assert.equal((await request(project+'/agent-skills'))[0].enabled,true);
    assert.equal((await request(gateway)).unread,0);
    const second=await request(sessions,{projectId});
    await request(web(second.id),{content:'咖啡验收 查看文件提醒',requestId:'acceptance-web-second'});
    assert.equal((await h.idle(second.id)).status,'completed');
    assert.deepEqual(new Set((await recall(second.id)).map(item=>item.id)),new Set([work.id,long.id]));
    await request(memory+'/work/'+work.id+'/delete',{version:work.version});
    assert.deepEqual((await recall(second.id)).map(item=>item.id),[long.id]);

    const all=await request(sessions+'?projectId='+projectId);
    const channelSessions=await Promise.all(all.filter(session=>![first.id,second.id].includes(session.id)).map(session=>request(sessions+'/'+session.id)));
    assert.deepEqual(channelSessions.map(session=>session.message_channel).sort(),['discord','telegram','wechat']);
    for(const session of channelSessions){
      const incoming=session.events.filter(event=>event.kind==='message'&&event.role==='user');
      assert.equal(incoming.length,1);
      assert.equal(incoming[0].body.channel,session.message_channel);
      assert.equal(session.events.filter(event=>event.kind==='tool_result').length,0);
      await request(web(session.id),{content:'不应改道'},403);
    }
    const telegram=channelSessions.find(session=>session.message_channel==='telegram');
    const attachment=telegram.events.find(event=>event.body.attachments).body.attachments[0];
    const mediaPath=(id)=>h.origin+sessions+'/'+id+'/media/'+attachment.id;
    assert.equal((await fetch(mediaPath(telegram.id))).status,401);
    assert.equal(await (await ownerFetch(mediaPath(telegram.id))).text(),media);
    assert.equal((await ownerFetch(mediaPath(second.id))).status,404);

    const providerLog=async()=> (await readFile(join(h.dir,'data','acceptance-provider.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const prior=await providerLog();
    await h.restart();
    await until(providerLog,entries=>accounts.every(({channel})=>entries.slice(prior.length).some(entry=>entry.channel===channel&&entry.kind==='poll-resumed')),'channels did not restore saved cursors');
    await until(channels,value=>value.accounts.length===3&&value.accounts.every(account=>account.lastPollAt),'restored channel polls did not complete');
    const restored=await request(gateway);
    assert.equal(restored.runs.filter(item=>item.rule_id===rule.id).length,1);
    assert.equal(restored.runs.filter(item=>item.rule_id===heartbeat.id).length,1);
    assert.equal(restored.unread,0);
    assert.deepEqual((await recall(second.id)).map(item=>item.id),[long.id]);
    assert.equal(h.calls.filter(call=>call.phase==='channel').length,3);
    assert.deepEqual((await providerLog()).filter(entry=>entry.kind==='send').map(entry=>entry.channel).sort(),['discord','telegram','wechat']);
  }finally{
    await h.close();
  }
});
