/**
 * API 端点管理 - 根据 Base URL 和 API 协议类型拼接出完整的请求地址
 *
 * 所属层级：模型层（src/models/）
 * 核心功能：
 *   1. 将用户配置的 baseUrl 与 API 协议对应的路径后缀（如 /chat/completions）拼接
 *   2. 检测并拒绝协议冲突（如 baseUrl 已包含其他协议的完整路径）
 *   3. 对 OpenAI 官方地址自动补全 /v1 前缀
 * 依赖关系：
 *   - 被 model-backend.ts 调用以构建 HTTP 请求目标地址
 *   - 依赖 model-providers.ts 中定义的 apiType 枚举
 */

/**
 * modelEndpoint - 根据 Base URL 和 API 类型生成完整的请求端点 URL
 * @param baseUrl - 提供商的 API 基础地址，如 'https://api.openai.com/v1'
 * @param apiType - API 协议类型，决定拼接的路径后缀
 * @returns 完整的请求 URL 对象，如 https://api.openai.com/v1/chat/completions
 */
export function modelEndpoint(baseUrl:string,apiType:string):URL {
  // 解析用户提供的 Base URL
  const endpoint=new URL(baseUrl);
  // 三种协议对应的路径后缀映射
  const suffixes:Record<string,string>={'openai-completions':'/chat/completions','openai-responses':'/responses','anthropic-messages':'/messages'};
  const suffix=suffixes[apiType];if(!suffix)throw new Error('API 类型无效');
  // 去除末尾多余的斜杠
  let path=endpoint.pathname.replace(/\/+$/,'');
  // 检测 URL 中是否已包含其他协议的完整路径，避免拼接错误
  const existing=Object.values(suffixes).find(value=>path.endsWith(value));
  if(existing&&existing!==suffix)throw new Error('API URL 中的完整接口与所选协议不一致，请修改 API 类型或填写服务 Base URL');
  // OpenAI 官方地址特殊处理：如果用户只填了域名没填路径，自动补 /v1
  if(endpoint.hostname==='api.openai.com'&&!path)path='/v1';
  // 拼接最终路径：Anthropic 协议需要额外加 /v1 前缀（如果还没有的话）
  if(!path.endsWith(suffix))path+=(apiType==='anthropic-messages'&&!path.endsWith('/v1')?'/v1':'')+suffix;
  endpoint.pathname=path;return endpoint;
}
