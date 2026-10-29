/**
 * Agent 级提供商 - 每个 Agent 可独立配置模型提供商，支持协议兼容性检查与密钥管理
 *
 * 所属层级：模型层（src/models/）
 * 核心功能：
 *   1. 管理 agent_providers 和 agent_provider_bindings 两张表的 CRUD
 *   2. 支持多种运行时（apix/codex/claude/pi/gemini/opencode/kimi）的协议兼容性检查
 *   3. 为每个运行时生成对应的环境变量和启动参数
 *   4. 密钥通过凭据存储管理，更换地址/协议时必须重新填写
 * 依赖关系：
 *   - 依赖 infrastructure/environment.mjs 构建子进程环境
 *   - 被 src/coordination/ 层调用以管理 Agent 的模型配置
 *   - 与 model-providers.ts 的应用级提供商互补：本文件管理 Agent 级别的覆盖配置
 */
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {workerEnvironment} from '../infrastructure/environment.mjs';

/**
 * loopback - 判断 URL 是否指向本机回环地址
 */
const loopback=baseUrl=>{try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(baseUrl).hostname.toLowerCase());}catch{return false;}};

/**
 * providerProtocols - 各运行时支持的 API 协议映射
 * 用于检查供应商与 Agent 运行时的兼容性
 */
export const providerProtocols={apix:['openai-completions','openai-responses','anthropic-messages'],codex:['openai-responses','codex-login'],claude:['anthropic-messages'],pi:['openai-completions','openai-responses','anthropic-messages','google-generative-ai'],gemini:['google-generative-ai'],opencode:['openai-completions','anthropic-messages','google-generative-ai'],kimi:['openai-completions','anthropic-messages']};

/**
 * routingVariable - 匹配需要被清除的模型路由相关环境变量
 * 当 Agent 绑定了自定义提供商时，这些变量会被过滤掉以防止冲突
 */
const routingVariable=/^(?:OPENAI_|CODEX_API_KEY$|ANTHROPIC_|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_|PROVIDER_MANAGED)|GEMINI_API_KEY$|GOOGLE_(?:API_KEY|GEMINI_BASE_URL|GENAI_USE_)|KIMI_(?:API_KEY|BASE_URL|MODEL_)|MOONSHOT_API_KEY$|OPENCODE_CONFIG(?:_CONTENT)?$|APIX_PROVIDER_KEY$)/i;

/**
 * runtimeConfig - 原子写入运行时配置文件（如 settings.json）
 * 先写临时文件再重命名，避免写入中断导致损坏
 * @param path - 目标文件路径
 * @param value - 要写入的 JSON 值
 */
function runtimeConfig(path,value){
  const content=JSON.stringify(value);try{if(readFileSync(path,'utf8')===content)return;}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temporary,content,{mode:0o600,flag:'wx'});renameSync(temporary,path);}catch(error){try{unlinkSync(temporary);}catch{}throw error;}
}
/**
 * createAgentProviders - 创建 Agent 级提供商管理的完整操作集合
 * @param deps - 依赖注入：数据库、凭据存储、员工配置等
 * @returns 包含 list/save/bind/remove/adopt/prepare 等方法的对象
 */
export function createAgentProviders({db,row,rows,now,dataDir,credentials,profile,saveProfile,managerSettings,saveManager,environment=process.env}){
  // 创建提供商表和绑定表
  db.exec(`CREATE TABLE IF NOT EXISTS agent_providers(id TEXT PRIMARY KEY,version INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_provider_bindings(employee_id TEXT PRIMARY KEY REFERENCES employees(id),provider_id TEXT REFERENCES agent_providers(id),version INTEGER NOT NULL);`);

  /** get - 根据 ID 获取提供商配置 */
  const get=id=>{const saved=row('SELECT * FROM agent_providers WHERE id=?',id);if(!saved)throw Error('供应商不存在，请刷新');return {id:saved.id,version:saved.version,...JSON.parse(saved.body)};};

  /** publicProfile - 返回不含密钥引用的安全视图 */
  const publicProfile=p=>{const {keyRef,...safe}=p;return {...safe,hasKey:!!keyRef};};

  /** binding - 获取员工与提供商的绑定关系 */
  const binding=id=>row('SELECT * FROM agent_provider_bindings WHERE employee_id=?',id)??{employee_id:id,provider_id:null,version:0};

  /** managerVersion - 计算当前应用级模型设置的哈希版本 */
  const managerVersion=()=>createHash('sha256').update(JSON.stringify(managerSettings())).digest('hex');

  /** idle - 检查员工是否空闲（无运行中/待执行/待验收任务） */
  function idle(id){if(row("SELECT id FROM tasks WHERE employee_id=? AND status IN ('running','starting','stopping','unknown','queued','awaiting_approval','completed') LIMIT 1",id)||row("SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.employee_id=? AND (r.status IN ('running','starting','stopping','unknown') OR r.ended_at IS NULL) LIMIT 1",id))throw Error('该员工有运行中、待执行或待验收任务，请先停止或处理后再切换供应商');}

  /** compatible - 检查供应商协议与运行时是否兼容 */
  function compatible(runtime,p){if(!providerProtocols[runtime]?.includes(p.apiType)||(p.authHeader==='bearer'&&runtime!=='claude'))throw Error(`供应商协议或认证方式与 ${runtime} 不兼容`);}

  /** managerMatch - 检查提供商是否与应用级设置匹配 */
  function managerMatch(p,s){return p.apiType!=='codex-login'&&['custom','apix-custom'].includes(s.provider)&&s.model===p.model&&s.baseUrl===p.baseUrl&&s.apiType===p.apiType&&s.apiKeyEnv===(p.keyRef??'')&&(s.contextWindow??null)===(p.contextWindow??null);}

  /** list - 列出所有提供商、Agent 绑定状态和应用级配置 */
  function list(){const providers=rows('SELECT id FROM agent_providers ORDER BY rowid').map(r=>get(r.id));const current=managerSettings(),matched=providers.find(p=>managerMatch(p,current)),configured=!!(current.model&&current.baseUrl);return {protocols:providerProtocols,providers:providers.map(publicProfile),agents:[{id:'apix',name:'ApiX',runtime:'apix',providerId:matched?.id??null,version:managerVersion(),model:current.model,baseUrl:current.baseUrl,configured,adoptable:configured&&!matched,source:'应用默认；已有对话需使用当前应用配置'},...rows('SELECT id,name,runtime FROM employees WHERE deleted_at IS NULL').map(e=>({...e,providerId:binding(e.id).provider_id,version:binding(e.id).version,model:profile(e.id).model,source:binding(e.id).provider_id?'ApiX 专用覆盖':'沿用本机 CLI 配置（可能包含中转）'}))]};}

  /** transaction - 在 SAVEPOINT 中执行操作，失败时回滚 */
  function transaction(work){db.exec('SAVEPOINT agent_provider');try{const value=work();db.exec('RELEASE agent_provider');return value;}catch(e){db.exec('ROLLBACK TO agent_provider;RELEASE agent_provider');throw e;}}

  /** save - 创建或更新提供商配置 */
  function save(input){
    const previous=input.id?get(input.id):null;if(input.version!==(previous?.version??0))throw Error('供应商配置已变化，请刷新');
    const name=String(input.name??'').trim(),model=String(input.model??'').trim(),apiType=String(input.apiType??'');
    const authHeader=apiType==='anthropic-messages'?String(input.authHeader??previous?.authHeader??'default'):'default';
    if(!['default','bearer'].includes(authHeader))throw Error('认证方式无效');
    if(!name||name.length>100||!model||model.length>200||/[\x00-\x1f]/.test(name+model)||!Object.values(providerProtocols).flat().includes(apiType))throw Error('请填写名称、模型 ID 和受支持的协议');
    let baseUrl=String(input.baseUrl??'').trim();
    if(apiType==='codex-login')baseUrl='';else {if(/[{}<>]|%7[bBdD]|%3[cCeE]/i.test(baseUrl))throw Error('供应商地址仍含占位符，请填写控制台提供的实际 Base URL');let url;try{url=new URL(baseUrl);}catch{throw Error('供应商地址无效');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('地址仅支持 HTTP(S)，不能包含凭据、查询或片段');baseUrl=url.href.replace(/\/$/,'');}
    const bound=previous?rows('SELECT b.employee_id FROM agent_provider_bindings b JOIN employees e ON e.id=b.employee_id WHERE b.provider_id=? AND e.deleted_at IS NULL',previous.id):[];
    for(const e of bound){idle(e.employee_id);compatible(row('SELECT runtime FROM employees WHERE id=?',e.employee_id).runtime,{apiType,authHeader});}
    const managerBound=previous&&managerMatch(previous,managerSettings());if(managerBound)compatible('apix',{apiType,authHeader});
    if(previous && (previous.baseUrl!==baseUrl || previous.apiType!==apiType) && !input.apiKey && apiType!=='codex-login' && (!!previous.keyRef || !loopback(baseUrl)))throw Error('更换地址或协议必须重新填写密钥，防止旧密钥发往其他服务');
    const contextWindow=input.contextWindow===undefined?previous?.contextWindow??null:input.contextWindow===''||input.contextWindow===null?null:Number(input.contextWindow);
    if(contextWindow!==null&&(!Number.isSafeInteger(contextWindow)||contextWindow<4096||contextWindow>1000000))throw Error('上下文窗口应为 4096–1000000 Token');
    let keyRef=apiType==='codex-login'?null:previous?.keyRef??null;
    if(input.apiKey!==undefined && typeof input.apiKey!=='string')throw Error('API Key 必须为文本');
    if(apiType!=='codex-login' && input.apiKey)keyRef=credentials.save(input.apiKey);
    if(apiType!=='codex-login'&&!keyRef&&!loopback(baseUrl))throw Error('请直接填写 API Key；本地回环服务可留空');
    const p={contextWindow,id:previous?.id??randomUUID(),version:(previous?.version??0)+1,name,model,baseUrl,apiType,authHeader,keyRef};
    return transaction(()=>{const {id,version,...body}=p;db.prepare('INSERT INTO agent_providers VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body').run(id,version,JSON.stringify(body));for(const e of bound)updateModel(e.employee_id,p.model);if(managerBound)applyManager(p);return publicProfile(p);});
  }
  /** updateModel - 更新员工的模型 ID */
  function updateModel(id,model){const old=profile(id);saveProfile(id,{...old,model,pricing:null,accountId:null});}

  /** applyManager - 将提供商配置应用到应用级设置 */
  function applyManager(p){compatible('apix',p);saveManager({contextWindow:p.contextWindow??null,provider:'custom',baseUrl:p.baseUrl,model:p.model,apiType:p.apiType,apiKeyEnv:p.keyRef??''});}

  /** adopt - 将当前应用级配置导入为一个新的提供商 */
  function adopt(){
    const current=managerSettings();
    if(!current.model||!current.baseUrl)throw Error('当前没有可导入的 ApiX 模型配置');
    const providers=rows('SELECT id FROM agent_providers').map(r=>get(r.id));
    if(providers.some(p=>managerMatch(p,current)))return list();
    const apiType=String(current.apiType||'openai-completions');compatible('apix',{apiType,authHeader:'default'});
    const p={id:randomUUID(),version:1,name:'ApiX 当前配置',contextWindow:current.contextWindow??null,model:current.model,baseUrl:current.baseUrl,apiType,authHeader:'default',keyRef:current.apiKeyEnv||null};
    db.prepare('INSERT INTO agent_providers VALUES (?,?,?)').run(p.id,p.version,JSON.stringify({contextWindow:p.contextWindow,name:p.name,model:p.model,baseUrl:p.baseUrl,apiType:p.apiType,authHeader:p.authHeader,keyRef:p.keyRef}));
    return list();
  }
  /** bind - 将提供商绑定到指定 Agent 或应用级 */
  function bind(input){
    if(input.agentId==='apix'){if(input.version!==managerVersion())throw Error('ApiX 配置已变化，请刷新');const p=get(input.providerId);if(input.providerVersion!==p.version)throw Error('供应商配置已变化，请刷新');applyManager(p);return list();}
    const employee=row('SELECT * FROM employees WHERE id=? AND deleted_at IS NULL',input.agentId);if(!employee)throw Error('员工不存在');
    idle(employee.id);const old=binding(employee.id);if(input.version!==old.version)throw Error('员工绑定已变化，请刷新');
    const p=input.providerId?get(input.providerId):null;if(p){if(input.providerVersion!==p.version)throw Error('供应商配置已变化，请刷新');compatible(employee.runtime,p);}
    transaction(()=>{updateModel(employee.id,p?.model??'');db.prepare('INSERT INTO agent_provider_bindings VALUES (?,?,?) ON CONFLICT(employee_id) DO UPDATE SET provider_id=excluded.provider_id,version=excluded.version').run(employee.id,p?.id??null,old.version+1);});return list();
  }
  /** remove - 删除提供商（必须先解除所有绑定） */
  function remove(input){const p=get(input.id);if(input.version!==p.version)throw Error('供应商配置已变化，请刷新');if(row('SELECT b.employee_id FROM agent_provider_bindings b JOIN employees e ON e.id=b.employee_id WHERE b.provider_id=? AND e.deleted_at IS NULL',p.id)||managerMatch(p,managerSettings()))throw Error('供应商正在使用，请先切换所有 Agent');transaction(()=>{db.prepare('DELETE FROM agent_provider_bindings WHERE provider_id=?').run(p.id);db.prepare('DELETE FROM agent_providers WHERE id=?').run(p.id);});return list();}

  /**
   * prepare - 为指定员工准备运行时环境变量和启动参数
   * 根据不同的运行时（codex/claude/gemini/opencode/kimi/pi）生成对应的配置
   * @param id - 员工 ID
   * @param runtime - 运行时类型
   * @param source - 源环境变量
   * @param managerKeys - 应用级密钥
   * @returns { env, args, provider, consultSettings? }
   */
  function prepare(id,runtime,source,managerKeys){
    const bound=id?binding(id):null;if(!bound?.provider_id)return {env:workerEnvironment(source,runtime,managerKeys),args:[],provider:null};
    const p=get(bound.provider_id);compatible(runtime,p);if(profile(id).model!==p.model)throw Error('员工模型与供应商绑定不一致，请在供应商中心重新绑定');
    const clean=Object.fromEntries(Object.entries(source).filter(([name])=>!routingVariable.test(name)));
    const env=workerEnvironment(clean,runtime,managerKeys),args=[];
    if(p.apiType==='codex-login'){args.push('-c','model_provider="openai"','-c','forced_login_method="chatgpt"','--model',p.model);return {env,args,provider:publicProfile(p)};}
    const key=p.keyRef?environment[p.keyRef]:'';if(p.keyRef&&!key)throw Error('供应商密钥不可用，请重新保存');
    if(runtime==='codex'){env.APIX_PROVIDER_KEY=key;args.push('-c','model_provider="apix"','-c','forced_login_method="api"','-c',`model_providers.apix.name="ApiX"`,'-c',`model_providers.apix.base_url=${JSON.stringify(p.baseUrl)}`,'-c','model_providers.apix.env_key="APIX_PROVIDER_KEY"','-c','model_providers.apix.wire_api="responses"','-c','model_providers.apix.requires_openai_auth=false','--model',p.model);}
    let consultSettings;
    if(runtime==='claude'){
      const dir=join(dataDir,'provider-runtimes',p.id,String(p.version),'claude');mkdirSync(dir,{recursive:true});
      const overrides={ANTHROPIC_BASE_URL:p.baseUrl,ANTHROPIC_MODEL:p.model,ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CODE_OAUTH_TOKEN:'',CLAUDE_CODE_USE_BEDROCK:'',CLAUDE_CODE_USE_VERTEX:'',CLAUDE_CODE_USE_FOUNDRY:'',[p.authHeader==='bearer'?'ANTHROPIC_AUTH_TOKEN':'ANTHROPIC_API_KEY']:key};
      const settings=join(dir,'settings.json');consultSettings=join(dir,'consultation.json');
      // Older Claude versions also need session settings to override file-based credentials.
      runtimeConfig(settings,{model:p.model,env:overrides});
      runtimeConfig(consultSettings,{model:p.model,env:overrides,disableAllHooks:true});
      Object.assign(env,{ANTHROPIC_BASE_URL:p.baseUrl,[p.authHeader==='bearer'?'ANTHROPIC_AUTH_TOKEN':'ANTHROPIC_API_KEY']:key,ANTHROPIC_MODEL:p.model,CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:'1'});args.push('--settings',settings,'--model',p.model);
    }
    if(runtime==='gemini'){const home=join(dataDir,'provider-runtimes',p.id,String(p.version),'gemini');mkdirSync(join(home,'.gemini'),{recursive:true});runtimeConfig(join(home,'.gemini','settings.json'),{security:{auth:{selectedType:'gemini-api-key'}}});Object.assign(env,{GEMINI_CLI_HOME:home,GEMINI_API_KEY:key,GOOGLE_GEMINI_BASE_URL:p.baseUrl,GOOGLE_GENAI_USE_VERTEXAI:'false'});args.push('--model',p.model);}
    if(runtime==='opencode'){env.APIX_PROVIDER_KEY=key;env.OPENCODE_CONFIG_CONTENT=JSON.stringify({model:'apix/'+p.model,provider:{apix:{npm:p.apiType==='anthropic-messages'?'@ai-sdk/anthropic':p.apiType==='google-generative-ai'?'@ai-sdk/google':'@ai-sdk/openai-compatible',name:'ApiX',options:{baseURL:p.baseUrl,apiKey:'{env:APIX_PROVIDER_KEY}'},models:{[p.model]:{name:p.model}}}}});args.push('--model','apix/'+p.model);}
    if(runtime==='kimi')Object.assign(env,{KIMI_MODEL_NAME:p.model,KIMI_MODEL_API_KEY:key,KIMI_MODEL_BASE_URL:p.baseUrl,KIMI_MODEL_PROVIDER_TYPE:p.apiType==='anthropic-messages'?'anthropic':'openai'});
    if(runtime==='pi'){const dir=join(dataDir,'provider-runtimes',p.id,String(p.version));mkdirSync(dir,{recursive:true});runtimeConfig(join(dir,'models.json'),{providers:{apix:{baseUrl:p.baseUrl,api:p.apiType,apiKey:'$APIX_PROVIDER_KEY',models:[{id:p.model}]}}});env.PI_CODING_AGENT_DIR=dir;env.APIX_PROVIDER_KEY=key;args.push('--provider','apix','--model',p.model);}
    return {env,args,provider:publicProfile(p),consultSettings};
  }
  return {list,save,bind,remove,adopt,prepare,supports:id=>!!(id&&binding(id).provider_id),keyNames:()=>rows('SELECT id FROM agent_providers').map(r=>get(r.id).keyRef).filter(Boolean),assertModel:(id,model)=>{const b=binding(id);if(b.provider_id&&model!==get(b.provider_id).model)throw Error('模型由供应商中心管理，请在那里切换');}};
}
