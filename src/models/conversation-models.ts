/**
 * 对话模型配置 - 管理不同对话场景的模型参数与思考强度
 *
 * 所属层级：模型层（src/models/）
 * 核心功能：
 *   1. modelCatalog() 根据当前设置匹配提供商并列出可用模型
 *   2. supportedEfforts() 判断当前模型支持的思考强度级别
 *   3. reasoningParameters() 将思考强度转换为各协议的请求参数
 *   4. createConversationModels() 创建对话模型的 CRUD 操作，持久化到 SQLite
 * 依赖关系：
 *   - 依赖 model-providers.ts 获取提供商配置和验证逻辑
 *   - 依赖 model-backend.ts 的 ModelSettings 类型
 *   - 被 src/coordination/ 层调用以管理对话级模型设置
 */
import type {Store} from '../coordination/contracts.js';
import {BUILTIN_PROVIDERS,getProviderConfig,validateModelConfig} from './model-providers.js';
import type {ModelSettings} from './model-backend.js';

/**
 * modelCatalog - 根据当前模型设置匹配提供商，返回可用模型列表
 * @param settings - 当前模型配置
 * @returns { providerName, models } - 提供商名称和模型列表
 */
export function modelCatalog(settings:ModelSettings){
  const preset=getProviderConfig(settings.provider);
  const base=settings.baseUrl||preset?.baseUrl||'';
  let deepseek=false;try{deepseek=new URL(base).hostname==='api.deepseek.com';}catch{}
  const provider=BUILTIN_PROVIDERS.find(p=>p.id===settings.provider||deepseek&&p.id==='deepseek'||p.baseUrl.replace(/\/+$/,'')===base.replace(/\/+$/,''));
  const models=(provider?.models??[]).map(m=>({id:m.id,name:m.name}));
  if(settings.model&&!models.some(m=>m.id===settings.model))models.unshift({id:settings.model,name:settings.model});
  return {providerName:provider?.name??'自定义供应商',models};
}
/**
 * supportedEfforts - 返回当前模型支持的思考强度级别列表
 * 目前仅 DeepSeek 的特定模型支持思考强度调节
 * @param settings - 当前模型配置
 * @returns 支持的强度级别数组，如 ['none','low','high','max']；不支持则返回空数组
 */
export function supportedEfforts(settings:ModelSettings):string[]{
  let host='';try{host=new URL(settings.baseUrl||getProviderConfig(settings.provider)?.baseUrl||'').hostname;}catch{}
  if(host==='api.deepseek.com'&&['deepseek-flash','deepseek-v4-pro'].includes(settings.model)&&['openai-completions','openai-responses','anthropic-messages'].includes(settings.apiType))return ['none','low','high','max'];
  // Unknown gateways may expose different capabilities; never guess their parameters from a model name.
  return [];
}
/**
 * reasoningParameters - 将思考强度设置转换为各 API 协议的请求参数
 * @param settings - 当前模型配置（含 reasoningEffort）
 * @returns 需要合并到请求体中的参数对象
 */
export function reasoningParameters(settings:ModelSettings):Record<string,unknown>{
  const effort=settings.reasoningEffort;if(!effort)return {};
  if(!supportedEfforts(settings).includes(effort))throw new Error('当前供应商或模型不支持此思考强度');
  if(settings.apiType==='openai-responses')return {reasoning:{effort}};
  if(settings.apiType==='anthropic-messages')return {thinking:{type:effort==='none'?'disabled':'enabled'},...(effort==='none'?{}:{output_config:{effort}})};
  return {thinking:{type:effort==='none'?'disabled':'enabled'},...(effort==='none'?{}:{reasoning_effort:effort})};
}
/**
 * createConversationModels - 创建对话模型配置的 CRUD 操作集合
 * 将每个对话的模型设置持久化到 SQLite 的 conversation_models 表
 * @param deps - 数据库存储依赖
 * @param defaults - 获取全局默认模型设置的函数
 * @returns { get, save, initialize } 三个操作方法
 */
export function createConversationModels(deps:Store,defaults:()=>ModelSettings){
  const {db,row,now}=deps;
  // 创建对话模型配置表，复合主键为 (kind, session_id)
  db.exec('CREATE TABLE IF NOT EXISTS conversation_models(kind TEXT NOT NULL,session_id TEXT NOT NULL,settings TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,session_id))');

  /**
   * get - 获取指定对话的模型配置，不存在则自动初始化
   * @param kind - 对话类型（如 'session'、'task'）
   * @param id - 会话 ID
   * @returns 模型设置、版本号、提供商名称和可用模型列表
   */
  function get(kind:string,id:string){let saved=row<{settings:string;version:number}>('SELECT settings,version FROM conversation_models WHERE kind=? AND session_id=?',kind,id);if(!saved){initialize(kind,id);saved=row<{settings:string;version:number}>('SELECT settings,version FROM conversation_models WHERE kind=? AND session_id=?',kind,id);}const settings=saved?JSON.parse(saved.settings) as ModelSettings:defaults();return {settings,version:saved?.version??0,...modelCatalog(settings),efforts:supportedEfforts(settings)};}

  /**
   * initialize - 为对话初始化默认模型配置（已存在则跳过）
   * @param kind - 对话类型
   * @param id - 会话 ID
   * @param settings - 初始设置，默认使用全局配置
   */
  function initialize(kind:string,id:string,settings=defaults()){if(!settings.model)return;db.prepare('INSERT OR IGNORE INTO conversation_models(kind,session_id,settings,version,updated_at) VALUES (?,?,?,1,?)').run(kind,id,JSON.stringify(settings),now());}

  /**
   * save - 保存对话的模型配置，支持“沿用全局”和“自定义”两种模式
   * @param kind - 对话类型
   * @param id - 会话 ID
   * @param input - 用户提交的配置变更
   * @returns 更新后的完整配置
   */
  function save(kind:string,id:string,input:Record<string,unknown>){
    const previous=get(kind,id);if(input.version!==previous.version)throw new Error('对话模型配置已变化，请刷新后重试');
    // 模式一：沿用全局配置
    if(input.useGlobal===true){
      const settings=defaults(),validation=validateModelConfig(settings);
      if(!settings.model||(!settings.baseUrl&&!getProviderConfig(settings.provider)?.baseUrl)||!validation.valid)throw new Error('请先保存有效的应用模型配置');
      db.prepare('INSERT INTO conversation_models(kind,session_id,settings,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,session_id) DO UPDATE SET settings=excluded.settings,version=excluded.version,updated_at=excluded.updated_at').run(kind,id,JSON.stringify(settings),previous.version+1,now());
      return get(kind,id);
    }
    // 模式二：自定义模型设置
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
