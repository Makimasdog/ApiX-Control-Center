import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createAssistantLoop} from '../dist/src/assistant/assistant-loop.js';
import {createChannelRelay} from '../dist/src/assistant-core/channels/channel-relay.js';
import {discordAdapter} from '../dist/src/assistant-core/channels/discord-adapter.js';
import {telegramAdapter} from '../dist/src/assistant-core/channels/telegram-adapter.js';
import {wechatAdapter} from '../dist/src/assistant-core/channels/wechat-adapter.js';

const config=(channel,peerId='101',conversationId='202')=>({
  channel, accountId:'test', peerId, conversationId, projectId:'p',
  token:channel==='telegram'?'123:demo_token':'demo-provider-token',
});
const signal=()=>new AbortController().signal;
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const media=new Uint8Array([1,2,3,4]);

test('WeChat iLink uses the cursor, decrypts media and replies only to the configured direct peer',async()=>{
  const key=Buffer.alloc(16,7), cipher=createCipheriv('aes-128-ecb',key,null);
  const encrypted=Buffer.concat([cipher.update(media),cipher.final()]);
  const calls=[];
  const adapter=wechatAdapter(config('wechat','owner','owner'),async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url).includes('/download?'))return new Response(encrypted);
    if(String(url).endsWith('/getupdates'))return json({ret:0,msgs:[],get_updates_buf:'next'});
    return json({ret:0});
  });
  assert.equal((await adapter.poll('before',signal())).cursor,'next');
  assert.equal(JSON.parse(calls[0].init.body).get_updates_buf,'before');
  const message={message_id:45,message_type:1,from_user_id:'owner',context_token:'reply-context',item_list:[
    {type:1,text_item:{text:'hello'}},
    {type:2,image_item:{media:{encrypt_query_param:'p',aes_key:key.toString('base64')}}},
    {type:3,voice_item:{text:'transcription',media:{encrypt_query_param:'p',aes_key:key.toString('base64')}}},
    {type:4,file_item:{file_name:'note.bin',media:{encrypt_query_param:'p',aes_key:key.toString('base64')}}},
  ]};
  assert.equal(await adapter.normalize({...message,group_id:'group'}),null);
  assert.equal(await adapter.normalize({...message,from_user_id:'unlisted'}),null);
  assert.equal(calls.length,1);
  const normalized=await adapter.normalize(message,signal());
  assert.deepEqual(normalized.parts.map(part=>part.kind),['text','image','text','voice','file']);
  assert.deepEqual(new Uint8Array(normalized.parts[1].bytes),media);
  assert(calls.slice(1).every(call=>call.init.headers===undefined&&call.init.redirect==='error'));
  await adapter.send(normalized,'reply',signal());
  const sent=JSON.parse(calls.at(-1).init.body);
  assert.equal(sent.msg.context_token,'reply-context');
  assert.equal(sent.msg.to_user_id,'owner');
  assert.equal(sent.msg.item_list[0].text_item.text,'reply');
});

test('Telegram preserves update offsets, download boundaries and the reply target',async()=>{
  const calls=[];
  const update={update_id:17,message:{message_id:40,from:{id:101},chat:{id:202},caption:'caption',caption_entities:[{type:'bold',offset:0,length:7}],
    photo:[{file_id:'low'},{file_id:'hi'}],voice:{file_id:'voice'},document:{file_id:'doc',mime_type:'text/plain',file_name:'note.txt'}}};
  const adapter=telegramAdapter(config('telegram'),async(url,init)=>{
    const address=String(url), body=init.body?JSON.parse(init.body):null;
    calls.push({address,body});
    if(address.endsWith('/getUpdates'))return json({ok:true,result:[update]});
    if(address.endsWith('/getFile'))return json({ok:true,result:{file_path:'files/'+body.file_id+'.bin'}});
    if(address.includes('/file/'))return new Response(media);
    return json({ok:true,result:{message_id:99}});
  });
  const batch=await adapter.poll('9',signal());
  assert.equal(batch.cursor,'18');
  assert.equal(calls[0].body.offset,9);
  assert.equal(await adapter.normalize({...update,message:{...update.message,from:{id:9}}}),null);
  const normalized=await adapter.normalize(batch.updates[0],signal());
  assert.deepEqual(normalized.parts.map(part=>part.kind),['text','image','voice','file']);
  assert.deepEqual(normalized.parts[0],{kind:'text',format:'markdown',text:'**caption**'});
  assert(calls.some(call=>call.body?.file_id==='hi'));
  assert(!calls.some(call=>call.body?.file_id==='low'));
  await adapter.send(normalized,'reply',signal());
  assert.equal(calls.at(-1).body.chat_id,'202');
  assert.equal(calls.at(-1).body.reply_parameters.message_id,40);
});

test('Discord starts after existing history, ignores bots and disables outbound mentions',async()=>{
  const calls=[];
  const message={id:'301',channel_id:'202',author:{id:'101'},content:'**hi**',attachments:[
    {filename:'photo.png',content_type:'image/png',url:'https://cdn.discordapp.com/attachments/photo.png'},
    {filename:'voice.ogg',duration_secs:1,url:'https://media.discordapp.net/attachments/voice.ogg'},
    {filename:'blocked',url:'https://127.0.0.1/file'},
  ]};
  const adapter=discordAdapter(config('discord'),async(url,init)=>{
    const address=String(url);
    calls.push({address,init});
    if(init.method==='POST')return json({id:'401'});
    if(address.endsWith('limit=1'))return json([{id:'300'}]);
    if(address.includes('after=300'))return json([message]);
    return new Response(media,{headers:{'Content-Type':'audio/ogg'}});
  });
  assert.deepEqual(await adapter.poll('',signal()),{updates:[],cursor:'300'});
  const batch=await adapter.poll('300',signal());
  assert.equal(batch.cursor,'301');
  assert.equal(await adapter.normalize({...message,author:{id:'101',bot:true}}),null);
  const normalized=await adapter.normalize(batch.updates[0],signal());
  assert.deepEqual(normalized.parts.map(part=>part.kind),['text','image','voice','text']);
  assert.equal(normalized.parts[0].format,'markdown');
  assert.equal(normalized.parts[2].mime,'audio/ogg');
  assert(!calls.some(call=>call.address.includes('127.0.0.1')));
  await adapter.send(normalized,'@everyone reply',signal());
  const outbound=JSON.parse(calls.at(-1).init.body);
  assert.deepEqual(outbound.allowed_mentions,{parse:[],replied_user:false});
  assert.equal(outbound.message_reference.message_id,'301');
  assert.equal(outbound.enforce_nonce,true);
});

async function until(read,predicate){
  for(let attempt=0;attempt<100;attempt++){
    const value=read();
    if(predicate(value))return value;
    await delay(50);
  }
  assert.fail('channel relay did not reach the expected state');
}

test('relay isolates routes, reuses the inference boundary and avoids resending an uncertain reply', {timeout:20000},async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p');");
  const prompts=[],sent=[],polls=new Map();
  const store={db,row:(sql,...args)=>db.prepare(sql).get(...args),rows:(sql,...args)=>db.prepare(sql).all(...args),now:()=>new Date().toISOString()};
  const assistant=createAssistantLoop({...store,policy:()=>({mode:'full_access',version:0}),
    describe:()=>{throw new Error('project description cannot enter a channel reply');},
    execute:()=>{throw new Error('channel replies cannot call tools');},
    infer:async(_project,prompt)=>{prompts.push(prompt);return 'local reply';},
    fingerprint:()=>{throw new Error('channel replies cannot read project files');},
    child:()=>({status:'idle',complete:false,details:null}),stopChild:()=>{},
  });
  const fetcher=async(url,init)=>{
    const address=String(url), left=address.includes('111:left_token');
    if(address.endsWith('/getUpdates')){
      const key=left?'left':'right';
      polls.set(key,(polls.get(key)??0)+1);
      return json({ok:true,result:[{update_id:99,message:{message_id:3,from:{id:left?101:102},chat:{id:left?201:202},text:key+' private'}}]});
    }
    if(address.endsWith('/sendMessage')){
      sent.push(JSON.parse(init.body).chat_id);
      if(left)throw new Error('delivery result unknown');
      return json({ok:true,result:{message_id:4}});
    }
    assert.fail('unexpected provider path');
  };
  const relay=createChannelRelay(store,assistant,fetcher);
  const accounts=JSON.stringify([
      {channel:'telegram',accountId:'left',projectId:'p',conversationId:'201',peerId:'101',tokenEnv:'APIX_CHANNEL_LEFT_TOKEN'},
      {channel:'telegram',accountId:'right',projectId:'p',conversationId:'202',peerId:'102',tokenEnv:'APIX_CHANNEL_RIGHT_TOKEN'},
  ]);
  const env={APIX_CHANNEL_LEFT_TOKEN:'111:left_token',APIX_CHANNEL_RIGHT_TOKEN:'222:right_token'};
  let restarted;
  try{
    relay.start(accounts,env);
    const state=await until(()=>relay.status(),s=>s.accounts.every(account=>['sent','uncertain'].includes(account.recent[0]?.state)));
    assert.equal(state.accounts.length,2);
    assert.deepEqual(state.accounts.map(account=>account.recent[0].state),['uncertain','sent']);
    assert(!JSON.stringify(state).includes('left_token'));
    assert.equal(prompts.length,2);
    assert(prompts.every(prompt=>prompt.includes('不能读取工作区')&&!(prompt.includes('left private')&&prompt.includes('right private'))));
    const sessions=db.prepare("SELECT id,message_channel FROM assistant_sessions WHERE message_channel='telegram'").all();
    assert.equal(sessions.length,2);
    await assert.rejects(assistant.message(sessions[0].id,{content:'wrong route'}),/原渠道/);
    await until(()=>[...polls.values()], values=>values.length===2&&values.every(count=>count>=2));
    await relay.stop();
    polls.clear();
    restarted=createChannelRelay(store,assistant,fetcher);
    restarted.start(accounts,env);
    await until(()=>restarted.status(),state=>state.accounts.length===2&&state.accounts.every(account=>account.lastPollAt));
    assert.deepEqual(sent.sort(),['201','202']);
    assert.equal(prompts.length,2);
  }finally{
    await relay.stop();
    await restarted?.stop();
    db.close();
  }
});
