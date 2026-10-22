export type ModelSettings = { provider: string; model: string; baseUrl: string; apiType: string; apiKeyEnv: string; apiKey?:string };
export type ProviderConfig = { id: string; name: string; baseUrl: string; apiType: string; requiresApiKey: boolean; defaultApiKeyEnv?: string; models: { id: string; name: string }[] };
export type ModelDraft = { provider: string; model: string; customModelName: string; baseUrl: string; customModel: string; apiType: string; apiKeyEnv: string; customApiKeyEnv: string; apiKey?:string; customApiKey?:string };
export function selectProvider(provider: string, providers: ProviderConfig[]): ModelDraft {
  const config = providers.find(p => p.id === provider);
  if (provider && provider !== 'custom' && !config) throw new Error('未知的平台配置');
  return { provider, model: config?.models[0]?.id ?? '', customModelName: '', baseUrl: '', customModel: '', apiType: 'openai-completions', apiKeyEnv: config?.defaultApiKeyEnv ?? '', customApiKeyEnv: '' };
}
export function settingsDraft(settings: ModelSettings, providers: ProviderConfig[]): ModelDraft {
  const config = settings.baseUrl && providers.find(p => p.baseUrl === settings.baseUrl && p.apiType === settings.apiType);
  const draft = selectProvider(config ? config.id : settings.provider || settings.baseUrl || settings.model ? 'custom' : '', providers);
  if (config) {
    if (config.models.some(m => m.id === settings.model)) draft.model = settings.model;
    else draft.customModelName = settings.model;
    draft.apiKeyEnv = settings.apiKeyEnv;
  } else if (draft.provider === 'custom') {
    draft.baseUrl = settings.baseUrl; draft.customModel = settings.model;
    draft.apiType = settings.apiType; draft.customApiKeyEnv = settings.apiKeyEnv;
  }
  return draft;
}
export function settingsPayload(draft: ModelDraft, providers: ProviderConfig[], saved: ModelSettings | null, ready: boolean): ModelSettings {
  if (!ready || !saved) throw new Error('模型配置尚未加载成功，请刷新后再保存');
  if (!draft.provider) return { provider: '', model: '', baseUrl: '', apiType: 'openai-completions', apiKeyEnv: '' };
  const apiKey=(draft.provider==='custom'?draft.customApiKey:draft.apiKey)?.trim();
  const credential=apiKey?{apiKey,apiKeyEnv:''}:{};
  if (draft.provider === 'custom') {
    const legacy = !draft.baseUrl && saved.provider && saved.provider !== 'apix-custom' && !saved.baseUrl;
    if (!draft.baseUrl && !legacy) throw new Error('自定义配置需要 API URL');
    const keyEnv=draft.customApiKeyEnv.trim();
    const changedService=keyEnv.startsWith('APIX_MANAGER_KEY_') && (draft.baseUrl.trim()!==saved.baseUrl || draft.apiType!==saved.apiType);
    return { provider: legacy ? saved.provider : 'apix-custom', model: draft.customModel.trim(), baseUrl: draft.baseUrl.trim(), apiType: draft.apiType, apiKeyEnv:changedService?'':keyEnv, ...credential };
  }
  const config = providers.find(p => p.id === draft.provider);
  if (!config) throw new Error('未知的平台配置，请重新加载目录');
  return { provider: 'apix-custom', model: draft.customModelName.trim() || draft.model, baseUrl: config.baseUrl, apiType: config.apiType, apiKeyEnv: draft.apiKeyEnv.trim(), ...credential };
}

export function localLookupRequest(draft:ModelDraft, providers:ProviderConfig[]): {baseUrl:string;apiKeyEnv:string}|null {
  const config=providers.find(p=>p.id===draft.provider);
  const baseUrl=(draft.provider==='custom'?draft.baseUrl:config?.baseUrl ?? '').trim();
  const apiType=draft.provider==='custom'?draft.apiType:config?.apiType;
  try {
    const url=new URL(baseUrl);
    if(!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || !['openai-completions','openai-responses'].includes(apiType ?? ''))return null;
    return {baseUrl,apiKeyEnv:(draft.provider==='custom'?draft.customApiKeyEnv:draft.apiKeyEnv).trim()};
  } catch { return null; }
}

export function mergeLocalModels(models:{id:string;name:string}[], selected:string):{id:string;name:string}[] {
  return selected && !models.some(m=>m.id===selected)?[{id:selected,name:selected+'（当前填写）'},...models]:models;
}

export function connectionTestRequest(draft:ModelDraft,providers:ProviderConfig[],saved:ModelSettings|null,ready:boolean,projectId:string,approved:boolean) {
  if(!projectId)throw new Error('请先选择项目，连接测试使用该项目的推理预算');
  const settings=settingsPayload(draft,providers,saved,ready);
  if(!saved || Object.entries(settings).some(([key,value])=>saved[key as keyof ModelSettings]!==value))throw new Error('请先保存当前模型配置再测试');
  if(!approved)throw new Error('连接测试可能产生模型费用，请先勾选批准');
  return {projectId,settings,approved:true};
}
