import {reasoningParameters} from './conversation-models.js';
import {getProviderConfig,isLoopbackModelUrl,validateModelConfig} from './model-providers.js';
import {modelEndpoint} from './model-endpoint.js';
import {requestHash} from './prompt-diagnostics.js';
export interface ModelSettings {provider:string;model:string;baseUrl:string;apiType:string;apiKeyEnv:string;reasoningEffort?:string;contextWindow?:number|null}
/** 沿用原适配器配置校验，避免提取请求准备逻辑时改变凭据与端点规则。 */
export function directModelSettings(saved:ModelSettings):ModelSettings {
  const preset=!saved.baseUrl?getProviderConfig(saved.provider):undefined;
  const settings=preset?{...saved,baseUrl:preset.baseUrl,apiType:preset.apiType,apiKeyEnv:saved.apiKeyEnv||preset.defaultApiKeyEnv||''}:saved;
  if(!settings.baseUrl||!settings.model)throw new Error('请先配置 ApiX 的模型 API 地址与模型 ID；Pi、Codex、Claude 是可选执行 Agent，不是推理底座。');
  const check=validateModelConfig(settings);if(!check.valid)throw new Error(check.error);
  if(settings.apiKeyEnv&&!process.env[settings.apiKeyEnv])throw new Error('模型密钥环境变量未设置，请配置后重启 ApiX');
  if(!settings.apiKeyEnv&&!isLoopbackModelUrl(settings.baseUrl))throw new Error('远程模型必须配置 API Key 环境变量');
  return settings;
}


const system='你是 ApiX 的独立模型决策组件。工具、Skills、上下文、委派、权限与验收由 ApiX 宿主管理；模型本身没有本机工具，不得虚构操作或自行启动其他 Agent。遵守输入中的 JSON 契约，只返回一个完整 JSON 对象，不加 Markdown 或前言。公开回复放在契约指定的 question、reply、message 或 summary 字段，不输出隐藏推理过程。';

/** 准备并冻结实际发包字符串；此阶段不创建网络对象。地址、认证仅留在传输内存中。 */
export function prepareModelRequest(saved:ModelSettings,prompt:string){
  const settings=directModelSettings(saved),api=settings.apiType,key=settings.apiKeyEnv?process.env[settings.apiKeyEnv]:undefined;
  if(Buffer.byteLength(prompt)>512*1024)throw new Error('模型上下文超过 512 KiB，请整理或拆分任务');
  const endpoint=modelEndpoint(settings.baseUrl,api);
  // Some Qwen thinking models require streaming even when the caller only needs the final JSON.
  const stream=true;
  const body=api==='openai-responses'?{model:settings.model,instructions:system,input:prompt,stream,store:false}:api==='anthropic-messages'?{model:settings.model,system,messages:[{role:'user',content:prompt}],max_tokens:8192,stream}:{model:settings.model,messages:[{role:'system',content:system},{role:'user',content:prompt}],stream};
  // Chat Completions 的流式用量在额外终端块中返回，需要显式请求。
  if(api==='openai-completions')Object.assign(body,{stream_options:{include_usage:true}});
  Object.assign(body,reasoningParameters(settings));
  const headers:Record<string,string>={'Content-Type':'application/json','Accept':stream?'text/event-stream':'application/json'};
  if(key)headers[api==='anthropic-messages'?'x-api-key':'Authorization']=api==='anthropic-messages'?key:'Bearer '+key;
  if(api==='anthropic-messages')headers['anthropic-version']='2023-06-01';

 const bodyText=JSON.stringify(body);
 const parameterNames=['model','stream','store','max_tokens','stream_options','reasoning','reasoning_effort','thinking','output_config'];
 const parameterHashes=Object.fromEntries(parameterNames.map(name=>[name,requestHash(JSON.stringify([name,(body as Record<string,unknown>)[name]??null]))]));
 return Object.freeze({bodyText,prompt,system,api,endpoint:endpoint.href,headers:Object.freeze(headers),key,settings:Object.freeze({...settings}),parameterHashes:Object.freeze(parameterHashes)});
}
export type PreparedModelRequest=ReturnType<typeof prepareModelRequest>;
