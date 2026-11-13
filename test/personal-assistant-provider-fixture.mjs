import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';

const upstream=globalThis.fetch;
const media='local-channel-attachment';
const token='fixture-wechat-token';
const reply='local protocol reply';
const wechatText={type:1,text_item:{text:'wechat 咖啡'}};
const discord={id:'301',channel_id:'203',author:{id:'102'},content:'**discord 咖啡**'};
const telegram={update_id:17,message:{message_id:40,from:{id:101},chat:{id:202},
  caption:'telegram 咖啡',caption_entities:[{type:'bold',offset:0,length:8}],
  document:{file_id:'document',file_name:'sample.txt',mime_type:'text/plain'}}};
const json=Response.json.bind(Response);
const audit=(channel,kind)=>appendFileSync(join(process.env.APIX_DATA_DIR,'acceptance-provider.jsonl'),JSON.stringify({channel,kind})+'\n');

globalThis.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:input);
  if(url.hostname==='127.0.0.1')return upstream(input,init);
  const body=init?.body?JSON.parse(init.body):null;
  if(url.hostname==='ilinkai.weixin.qq.com'){
    assert.equal(init.headers.Authorization,'Bearer '+token);
    if(url.pathname.endsWith('/getupdates')){
      audit('wechat',body.get_updates_buf?'poll-resumed':'poll-initial');
      return json({ret:0,get_updates_buf:'cursor-1',msgs:[
        {message_id:44,message_type:1,from_user_id:'unlisted',item_list:[wechatText]},
        {message_id:45,message_type:1,from_user_id:'owner',context_token:'reply-context',item_list:[wechatText]},
      ]});
    }
    if(url.pathname.endsWith('/sendmessage')){
      assert.equal(body.msg.to_user_id,'owner');
      assert.equal(body.msg.context_token,'reply-context');
      assert.equal(body.msg.item_list[0].text_item.text,reply);
      audit('wechat','send');
      return json({ret:0});
    }
  }
  if(url.hostname==='api.telegram.org'){
    assert(url.pathname.includes('123:fixture_telegram_token'));
    if(url.pathname.endsWith('/getUpdates')){
      audit('telegram',body.offset===18?'poll-resumed':'poll-initial');
      return json({ok:true,result:[telegram]});
    }
    if(url.pathname.endsWith('/getFile'))return json({ok:true,result:{file_path:'files/sample.txt'}});
    if(url.pathname.endsWith('/file/bot123:fixture_telegram_token/files/sample.txt'))return new Response(media,{headers:{'Content-Type':'text/plain'}});
    if(url.pathname.endsWith('/sendMessage')){
      assert.equal(body.chat_id,'202');
      assert.equal(body.reply_parameters.message_id,40);
      assert.equal(body.text,reply);
      audit('telegram','send');
      return json({ok:true,result:{message_id:41}});
    }
  }
  if(url.hostname==='discord.com'){
    assert.equal(init.headers.Authorization,'Bot fixture-discord-token');
    assert.equal(url.pathname,'/api/v10/channels/203/messages');
    if(init.method==='POST'){
      assert.equal(body.content,reply);
      assert.equal(body.message_reference.message_id,'301');
      assert.deepEqual(body.allowed_mentions,{parse:[],replied_user:false});
      audit('discord','send');
      return json({id:'302'});
    }
    if(url.searchParams.get('limit')==='1')return json([{id:'300'}]);
    audit('discord',url.searchParams.get('after')==='301'?'poll-resumed':'poll-initial');
    return json([discord]);
  }
  throw new Error('unexpected external fixture request');
};
