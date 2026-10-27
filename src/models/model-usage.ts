export interface ModelUsage {
  inputTokens:number|null;
  outputTokens:number|null;
  cachedInputTokens:number|null;
  cacheWriteTokens:number|null;
  reasoningTokens:number|null;
}
export const unknownUsage=():ModelUsage=>({inputTokens:null,outputTokens:null,cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null});
const count=(v:unknown):number|null=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):null;
// Provider counters are cumulative snapshots, never incremental stream deltas.
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
    // Anthropic's input_tokens excludes cache reads and writes. Missing fields stay unknown.
    const uncached=count(raw.input_tokens);
    if(raw.input_tokens!==undefined)result.inputTokens=uncached!==null&&result.cachedInputTokens!==null&&result.cacheWriteTokens!==null?uncached+result.cachedInputTokens+result.cacheWriteTokens:null;
    if(result.inputTokens!==null&&!Number.isSafeInteger(result.inputTokens))result.inputTokens=null;
  }
  return result;
}
export interface ModelAttempt {attempt:number;status:'completed'|'failed';durationMs:number;usage:ModelUsage;usageComplete:boolean}
