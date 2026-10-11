export type ModelSettings = { provider: string; model: string; baseUrl: string; apiType: string; apiKeyEnv: string };
export type ProviderConfig = { id: string; name: string; baseUrl: string; apiType: string; requiresApiKey: boolean; defaultApiKeyEnv?: string; models: { id: string; name: string }[] };
export type ModelDraft = { provider: string; model: string; customModelName: string; baseUrl: string; customModel: string; apiType: string; apiKeyEnv: string; customApiKeyEnv: string };
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
  if (draft.provider === 'custom') {
    const legacy = !draft.baseUrl && saved.provider && saved.provider !== 'apix-custom' && !saved.baseUrl;
    if (!draft.baseUrl && !legacy) throw new Error('自定义配置需要 API URL');
    return { provider: legacy ? saved.provider : 'apix-custom', model: draft.customModel.trim(), baseUrl: draft.baseUrl.trim(), apiType: draft.apiType, apiKeyEnv: draft.customApiKeyEnv.trim() };
  }
  const config = providers.find(p => p.id === draft.provider);
  if (!config) throw new Error('未知的平台配置，请重新加载目录');
  return { provider: 'apix-custom', model: draft.customModelName.trim() || draft.model, baseUrl: config.baseUrl, apiType: config.apiType, apiKeyEnv: draft.apiKeyEnv.trim() };
}
