export function modelEndpoint(baseUrl:string,apiType:string):URL {
  const endpoint=new URL(baseUrl);
  const suffixes:Record<string,string>={'openai-completions':'/chat/completions','openai-responses':'/responses','anthropic-messages':'/messages'};
  const suffix=suffixes[apiType];if(!suffix)throw new Error('API 类型无效');
  let path=endpoint.pathname.replace(/\/+$/,'');
  const existing=Object.values(suffixes).find(value=>path.endsWith(value));
  if(existing&&existing!==suffix)throw new Error('API URL 中的完整接口与所选协议不一致，请修改 API 类型或填写服务 Base URL');
  if(endpoint.hostname==='api.openai.com'&&!path)path='/v1';
  if(!path.endsWith(suffix))path+=(apiType==='anthropic-messages'&&!path.endsWith('/v1')?'/v1':'')+suffix;
  endpoint.pathname=path;return endpoint;
}
