import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelEndpoint} from '../dist/src/models/model-endpoint.js';
test('endpoint preserves gateway paths, accepts complete URLs and rejects mismatched protocols',()=>{
 assert.equal(modelEndpoint('https://api.openai.com','openai-completions').pathname,'/v1/chat/completions');
 for(const prefix of ['/compatible-mode/v1','/proxy/v1','/v1'])assert.equal(modelEndpoint('https://gateway.invalid'+prefix+'/','openai-completions').pathname,prefix+'/chat/completions');
 assert.equal(modelEndpoint('https://gateway.invalid/v1/chat/completions','openai-completions').pathname,'/v1/chat/completions');
 assert.equal(modelEndpoint('https://gateway.invalid/apps/anthropic','anthropic-messages').pathname,'/apps/anthropic/v1/messages');
 assert.throws(()=>modelEndpoint('https://gateway.invalid/v1/responses','openai-completions'),/协议不一致/);
});
