import { isLoopbackModelUrl, validateModelConfig } from './model-providers.js';

export async function readLocalModels(input: Record<string,unknown>): Promise<{ models: {id:string;name:string}[] }> {
  const baseUrl=String(input.baseUrl ?? '').trim();const apiKeyEnv=String(input.apiKeyEnv ?? '').trim();
  const validation=validateModelConfig({provider:'',model:'directory-probe',baseUrl,apiType:'openai-completions',apiKeyEnv});
  if(!validation.valid)throw new Error(validation.error);
  if(!baseUrl || !isLoopbackModelUrl(baseUrl))throw new Error('仅支持读取本机回环地址的模型目录');
  const endpoint=new URL(baseUrl);endpoint.pathname=endpoint.pathname.replace(/\/+$/,'')+'/models';
  const key=apiKeyEnv?process.env[apiKeyEnv]:undefined;
  if(apiKeyEnv && !key)throw new Error('请先设置模型服务的 API Key 环境变量');
  let response:Response;
  try {
    response=await fetch(endpoint,{signal:AbortSignal.timeout(5000),redirect:'error',headers:key?{Authorization:'Bearer '+key}:{}});
  } catch { throw new Error('无法连接本地模型服务，请确认地址与服务状态（5 秒超时；不跟随重定向）'); }
  if(!response.ok){await response.body?.cancel();throw new Error('本地模型服务返回 HTTP '+response.status+'，请检查服务配置与认证');}
  const reader=response.body?.getReader();if(!reader)throw new Error('本地模型服务未返回目录');
  let data:unknown;
  try {
    const decoder=new TextDecoder();let size=0;let raw='';
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024)throw new Error('目录过大');raw+=decoder.decode(value,{stream:true});}
    raw+=decoder.decode();data=JSON.parse(raw);
  } catch { throw new Error('本地模型目录无法读取，请检查响应格式与大小（最大 1MB、5 秒超时）'); }
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(!data || typeof data!=='object' || !('data' in data) || !Array.isArray(data.data))throw new Error('本地模型服务返回了无效的目录格式');
  if(data.data.length>1000)throw new Error('本地模型目录超过 1000 项');
  const ids=new Set<string>();
  for(const model of data.data){
    const id=model && typeof model==='object' && typeof model.id==='string'?model.id.trim():'';
    if(id && id.length<=200 && !id.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(id))ids.add(id);
  }
  if(data.data.length && !ids.size)throw new Error('本地模型目录没有有效的模型 ID');
  return {models:[...ids].map(id=>({id,name:id}))};
}
