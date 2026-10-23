import type {Store} from '../coordination/contracts.js';
import {BUILTIN_PROVIDERS,getProviderConfig,validateModelConfig} from './model-providers.js';
import type {ModelSettings} from './model-backend.js';

export function modelCatalog(settings:ModelSettings){
  const preset=getProviderConfig(settings.provider);
  const base=settings.baseUrl||preset?.baseUrl||'';
  let deepseek=false;try{deepseek=new URL(base).hostname==='api.deepseek.com';}catch{}
  const provider=BUILTIN_PROVIDERS.find(p=>p.id===settings.provider||deepseek&&p.id==='deepseek'||p.baseUrl.replace(/\/+$/,'')===base.replace(/\/+$/,''));
  const models=(provider?.models??[]).map(m=>({id:m.id,name:m.name}));
  if(settings.model&&!models.some(m=>m.id===settings.model))models.unshift({id:settings.model,name:settings.model});
  return {providerName:provider?.name??'自定义供应商',models};
}
export function supportedEfforts(settings:ModelSettings):string[]{
  let host='';try{host=new URL(settings.baseUrl||getProviderConfig(settings.provider)?.baseUrl||'').hostname;}catch{}
  if(host==='api.deepseek.com'&&['deepseek-flash','deepseek-v4-pro'].includes(settings.model)&&['openai-completions','openai-responses','anthropic-messages'].includes(settings.apiType))return ['none','low','high','max'];
  // Unknown gateways may expose different capabilities; never guess their parameters from a model name.
  return [];
}
export function reasoningParameters(settings:ModelSettings):Record<string,unknown>{
  const effort=settings.reasoningEffort;if(!effort)return {};
  if(!supportedEfforts(settings).includes(effort))throw new Error('当前供应商或模型不支持此思考强度');
  if(settings.apiType==='openai-responses')return {reasoning:{effort}};
  if(settings.apiType==='anthropic-messages')return {thinking:{type:effort==='none'?'disabled':'enabled'},...(effort==='none'?{}:{output_config:{effort}})};
  return {thinking:{type:effort==='none'?'disabled':'enabled'},...(effort==='none'?{}:{reasoning_effort:effort})};
}
export function createConversationModels(deps:Store,defaults:()=>ModelSettings){
  const {db,row,now}=deps;
  db.exec('CREATE TABLE IF NOT EXISTS conversation_models(kind TEXT NOT NULL,session_id TEXT NOT NULL,settings TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,session_id))');
  function get(kind:string,id:string){let saved=row<{settings:string;version:number}>('SELECT settings,version FROM conversation_models WHERE kind=? AND session_id=?',kind,id);if(!saved){initialize(kind,id);saved=row<{settings:string;version:number}>('SELECT settings,version FROM conversation_models WHERE kind=? AND session_id=?',kind,id);}const settings=saved?JSON.parse(saved.settings) as ModelSettings:defaults();return {settings,version:saved?.version??0,...modelCatalog(settings),efforts:supportedEfforts(settings)};}
  function initialize(kind:string,id:string,settings=defaults()){if(!settings.model)return;db.prepare('INSERT OR IGNORE INTO conversation_models(kind,session_id,settings,version,updated_at) VALUES (?,?,?,1,?)').run(kind,id,JSON.stringify(settings),now());}
  function save(kind:string,id:string,input:Record<string,unknown>){
    const previous=get(kind,id);if(input.version!==previous.version)throw new Error('对话模型配置已变化，请刷新后重试');
    if(input.useGlobal===true){
      const settings=defaults(),validation=validateModelConfig(settings);
      if(!settings.model||(!settings.baseUrl&&!getProviderConfig(settings.provider)?.baseUrl)||!validation.valid)throw new Error('请先保存有效的应用模型配置');
      db.prepare('INSERT INTO conversation_models(kind,session_id,settings,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,session_id) DO UPDATE SET settings=excluded.settings,version=excluded.version,updated_at=excluded.updated_at').run(kind,id,JSON.stringify(settings),previous.version+1,now());
      return get(kind,id);
    }
    if(!previous.settings.baseUrl&&!getProviderConfig(previous.settings.provider)?.baseUrl)throw new Error('请先在模型设置中配置供应商 API，再选择对话模型');
    if(typeof input.model!=='string'||input.reasoningEffort!==undefined&&typeof input.reasoningEffort!=='string')throw new Error('模型与思考强度必须为字符串');
    const model=String(input.model??'').trim(),reasoningEffort=String(input.reasoningEffort??'').trim();
    if(!model||model.length>200||/[\x00-\x1f]/.test(model))throw new Error('模型 ID 无效');
    const settings={...previous.settings,model,reasoningEffort,contextWindow:model===previous.settings.model?previous.settings.contextWindow:null};const validation=validateModelConfig(settings);if(!validation.valid)throw new Error(validation.error);
    reasoningParameters(settings);
    db.prepare('INSERT INTO conversation_models(kind,session_id,settings,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,session_id) DO UPDATE SET settings=excluded.settings,version=excluded.version,updated_at=excluded.updated_at').run(kind,id,JSON.stringify(settings),previous.version+1,now());
    return get(kind,id);
  }
  return {get,save,initialize};
}
