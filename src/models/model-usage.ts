/**
 * 用量追踪 - 记录每次 LLM 调用的 Token 消耗详情
 *
 * 所属层级：模型层（src/models/）
 * 核心功能：
 *   1. 定义 ModelUsage 接口，统一各提供商的 Token 计数口径（输入/输出/缓存/推理）
 *   2. modelUsage() 函数解析不同 API 协议返回的用量字段，合并为统一格式
 *   3. 定义 ModelAttempt 接口，记录单次网络请求尝试的结果
 * 依赖关系：
 *   - 被 model-backend.ts 导入以在每次推理后记录用量
 *   - 无外部依赖，是模型层的基础数据结构
 */

/**
 * ModelUsage - 供应商实际计数的统一口径
 * null 表示未观测到；缓存属于输入、推理属于输出，不能重复相加
 */
export interface ModelUsage {
  /** 输入 Token 数（含缓存读写） */
  inputTokens:number|null;
  /** 输出 Token 数（含推理思考） */
  outputTokens:number|null;
  /** 缓存命中的输入 Token 数 */
  cachedInputTokens:number|null;
  /** 缓存写入的 Token 数 */
  cacheWriteTokens:number|null;
  /** 推理/思考消耗的 Token 数 */
  reasoningTokens:number|null;
}

/**
 * unknownUsage - 创建一个所有字段均为 null 的“未知用量”对象
 * 用于初始化，表示尚未从任何响应中观测到用量数据
 */
export const unknownUsage=():ModelUsage=>({inputTokens:null,outputTokens:null,cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null});

/**
 * count - 安全地将未知值转换为非负整数，无效值返回 null
 * @param v - 待转换的值
 * @returns 有效的非负整数或 null
 */
const count=(v:unknown):number|null=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):null;

/**
 * modelUsage - 解析不同 API 协议返回的用量数据，合并为统一的 ModelUsage
 * 注意：流事件携带的是累计快照，后续计数覆盖前值，逐块相加会重复计算 Token
 * @param api - API 协议类型
 * @param raw - 响应中的 usage 字段原始数据
 * @param previous - 上一次累计的用量，默认为 unknownUsage()
 * @returns 合并后的用量对象
 */
// 流事件携带累计快照，后续计数覆盖前值；逐块相加会重复计算 token。
export function modelUsage(api:string,raw:Record<string,any>,previous=unknownUsage()):ModelUsage {
  const result={...previous};
  // 根据 API 协议提取对应的字段名映射
  const fields=api==='openai-completions'?{
    inputTokens:raw.prompt_tokens,outputTokens:raw.completion_tokens,cachedInputTokens:raw.prompt_tokens_details?.cached_tokens,
    cacheWriteTokens:raw.prompt_tokens_details?.cache_write_tokens,reasoningTokens:raw.completion_tokens_details?.reasoning_tokens,
  }:api==='openai-responses'?{
    inputTokens:raw.input_tokens,outputTokens:raw.output_tokens,cachedInputTokens:raw.input_tokens_details?.cached_tokens,
    cacheWriteTokens:raw.input_tokens_details?.cache_write_tokens,reasoningTokens:raw.output_tokens_details?.reasoning_tokens,
  }:{outputTokens:raw.output_tokens,cachedInputTokens:raw.cache_read_input_tokens,cacheWriteTokens:raw.cache_creation_input_tokens};
  // 将提取到的有效值覆盖到结果中
  for(const [key,value] of Object.entries(fields))if(value!==undefined)result[key as keyof ModelUsage]=count(value);
  if(api==='anthropic-messages'){
    // Anthropic 的 input_tokens 不含缓存读写；三个分量都已知时才能得到总输入，缺失不补零
    const uncached=count(raw.input_tokens);
    if(raw.input_tokens!==undefined)result.inputTokens=uncached!==null&&result.cachedInputTokens!==null&&result.cacheWriteTokens!==null?uncached+result.cachedInputTokens+result.cacheWriteTokens:null;
    if(result.inputTokens!==null&&!Number.isSafeInteger(result.inputTokens))result.inputTokens=null;
  }
  return result;
}

/**
 * ModelAttempt - 一次网络请求尝试的结果记录
 * completed 只表示模型传输完成，不代表任务已验收
 */
export interface ModelAttempt {
  transportObservation?:import('./prompt-diagnostics.js').TransportObservation;
  /** 第几次尝试（从 1 开始） */
  attempt:number;
  /** 尝试状态：成功或失败 */
  status:'completed'|'failed';
  /** 本次尝试耗时（毫秒） */
  durationMs:number;
  /** 本次尝试观测到的 Token 用量 */
  usage:ModelUsage;
  /** 用量数据是否完整（输入+输出均已知） */
  usageComplete:boolean;
}
