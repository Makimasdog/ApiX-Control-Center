import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareModelRequest} from '../dist/src/models/model-request.js';

const settings={provider:'apix-custom',model:'fixture',apiType:'anthropic-messages',baseUrl:'http://127.0.0.1:9/v1',apiKeyEnv:''};
// 稳定布局：核心帧之后紧跟 CURRENT_STATE 行，切点由提示词自身决定，与诊断描述符无关。
const core='APIX_AGENT_LOOP_JSON\n指令与历史\n'+'a'.repeat(40)+'中文结尾';
const tail='\nCURRENT_STATE {"policy":{"mode":"full_access"}}\n只返回一个对象。\n';
const prompt=core+tail;
const contentOf=(value,index=0)=>JSON.parse(value.bodyText).messages[index].content;

test('anthropic puts one cache breakpoint before CURRENT_STATE and preserves the prompt text',()=>{
  const prepared=prepareModelRequest(settings,prompt),content=contentOf(prepared);
  assert(Array.isArray(content));assert.equal(content.length,2);
  assert.equal(content[0].text,core);assert.equal(content[1].text,tail);
  assert.deepEqual(content[0].cache_control,{type:'ephemeral'});
  assert.equal(content[1].cache_control,undefined);
  assert.equal(content[0].text+content[1].text,prompt);
  assert.equal(prepared.prompt,prompt,'诊断用提示词原文不变');
});

test('anthropic keeps a single string block when the prompt carries no stable boundary',()=>{
  for(const value of ['APIX_AGENT_LOOP_JSON\n当前上下文：{"history":[]}','\nCURRENT_STATE 出现在首字节之前不成立','CURRENT_STATE 没有前置换行']){
    const prepared=prepareModelRequest(settings,value),content=contentOf(prepared);
    assert.equal(typeof content,'string');assert.equal(content,value);assert(!prepared.bodyText.includes('cache_control'));
  }
});

test('cache breakpoints are byte exact for multi-byte cores and stay off other protocols',()=>{
  const bytes=Buffer.from(prompt,'utf8'),prepared=prepareModelRequest(settings,prompt),content=contentOf(prepared);
  assert.equal(Buffer.byteLength(content[0].text,'utf8'),Buffer.byteLength(core,'utf8'));
  assert.equal(Buffer.from(content[0].text+content[1].text,'utf8').compare(bytes),0);
  for(const api of ['openai-completions','openai-responses']){
    const body=JSON.parse(prepareModelRequest({...settings,apiType:api},prompt).bodyText);
    assert(!JSON.stringify(body).includes('cache_control'));
    if(api==='openai-responses')assert.equal(body.input,prompt);
    else assert.equal(body.messages[1].content,prompt);
  }
});
