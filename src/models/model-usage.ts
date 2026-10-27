/** 供应商实际计数的统一口径：null 表示未观测到，缓存属于输入、推理属于输出，不能重复相加。 */
export interface ModelUsage {
  inputTokens:number|null;
  outputTokens:number|null;
  cachedInputTokens:number|null;
  cacheWriteTokens:number|null;
  reasoningTokens:number|null;
}
export const unknownUsage=():ModelUsage=>({inputTokens:null,outputTokens:null,cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null});
const count=(v:unknown):number|null=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):null;
// 流事件携带累计快照，后续计数覆盖前值；逐块相加会重复计算 token。
export function modelUsage(api:string,raw:Record<string,any>,previous=unknownUsage()):ModelUsage {
  const result={...previous};
  const fields=api==='openai-completions'?{
    inputTokens:raw.prompt_tokens,outputTokens:raw.completion_tokens,cachedInputTokens:raw.prompt_tokens_details?.cached_tokens,
    cacheWriteTokens:raw.prompt_tokens_details?.cache_write_tokens,reasoningTokens:raw.completion_tokens_details?.reasoning_tokens,
  }:api==='openai-responses'?{
    inputTokens:raw.input_tokens,outputTokens:raw.output_tokens,cachedInputTokens:raw.input_tokens_details?.cached_tokens,
    cacheWriteTokens:raw.input_tokens_details?.cache_write_tokens,reasoningTokens:raw.output_tokens_details?.reasoning_tokens,
  }:{outputTokens:raw.output_tokens,cachedInputTokens:raw.cache_read_input_tokens,cacheWriteTokens:raw.cache_creation_input_tokens};
  for(const [key,value] of Object.entries(fields))if(value!==undefined)result[key as keyof ModelUsage]=count(value);
  if(api==='anthropic-messages'){
    // Anthropic 的 input_tokens 不含缓存读写；三个分量都已知时才能得到总输入，缺失不补零。
    const uncached=count(raw.input_tokens);
    if(raw.input_tokens!==undefined)result.inputTokens=uncached!==null&&result.cachedInputTokens!==null&&result.cacheWriteTokens!==null?uncached+result.cachedInputTokens+result.cacheWriteTokens:null;
    if(result.inputTokens!==null&&!Number.isSafeInteger(result.inputTokens))result.inputTokens=null;
  }
  return result;
}
/** 一次网络请求尝试的结果；completed 只表示模型传输完成，不代表任务已验收。 */
export interface ModelAttempt {attempt:number;status:'completed'|'failed';durationMs:number;usage:ModelUsage;usageComplete:boolean}
