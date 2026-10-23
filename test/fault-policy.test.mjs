import {test} from 'node:test';import assert from 'node:assert/strict';
import {classifyFault,retryAfter,retryDelay} from '../dist/src/recovery/fault-policy.js';
test('fault categories share conservative recovery decisions',()=>{
 for(const [status,category] of [[400,'validation'],[408,'timeout'],[409,'conflict'],[401,'authentication'],[403,'authentication'],[402,'quota'],[404,'configuration'],[429,'rate_limit'],[503,'transient']]){const f=classifyFault(null,{kind:'model',status,safeToRetry:true});assert.equal(f.category,category);assert.equal(f.retryable,[429,503].includes(status));}
 for(const code of ['COMMAND_LIFECYCLE_UNKNOWN','MODEL_CLEANUP_UNKNOWN','INFERENCE_ACCOUNTING_UNKNOWN','AGENT_UNRESPONSIVE'])assert.equal(classifyFault({code}).strategy,'review');
 assert.equal(classifyFault(Error('version conflict'),{kind:'tool',sideEffects:true}).strategy,'review');assert.equal(classifyFault(Error('参数无效'),{kind:'tool'}).strategy,'repair');
 assert.equal(classifyFault(null,{kind:'model',status:503,safeToRetry:true,outputStarted:true}).retryable,false);
 assert.equal(classifyFault(Error('已配置认证与凭据隔离')).category,'execution');
 assert.equal(retryDelay(1,0,()=>0),375);assert.equal(retryDelay(3,30000,()=>0),30000);assert.equal(retryAfter('2'),2000);assert.equal(retryAfter('invalid'),0);assert.equal(retryAfter(new Date(5000).toUTCString(),1000),4000);assert.equal(classifyFault(null,{kind:'model',status:503,serviceCode:'invalid_api_key',safeToRetry:true}).retryable,false);
});
