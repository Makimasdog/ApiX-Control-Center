import {escapeAssistant as esc} from './assistant-view.js';
type Provider={contextWindow?:number|null;id:string;version:number;name:string;model:string;baseUrl:string;apiType:string;authHeader?:string;hasKey:boolean};
type Agent={id:string;name:string;runtime:string;providerId:string|null;version:number|string;model:string;baseUrl?:string;source:string;configured?:boolean;adoptable?:boolean};
type Catalog={providers:Provider[];agents:Agent[];protocols:Record<string,string[]>};
type Preset={id:string;name:string;baseUrl:string;apiType:string;requiresApiKey:boolean;models:{id:string;name:string}[]};
type ManagerSettings={provider:string;model:string;baseUrl:string;apiType:string;apiKeyEnv:string};
type Options={project?:()=>string};
const protocolNames:Record<string,string>={'openai-completions':'OpenAI Chat Completions','openai-responses':'OpenAI Responses（Codex API）','anthropic-messages':'Anthropic Messages（Claude）','google-generative-ai':'Google Gemini','codex-login':'Codex 官方 ChatGPT 登录（本机已有登录）'};
const runtimeNames:Record<string,string>={apix:'ApiX',codex:'Codex CLI',claude:'Claude Code',pi:'Pi',gemini:'Gemini CLI',opencode:'OpenCode',kimi:'Kimi CLI'};
function isLoopback(baseUrl:string){try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(baseUrl).hostname.toLowerCase());}catch{return false;}}
export function providerCenter(container:HTMLElement,options:Options={}){
  const root=document.createElement('section');root.className='provider-center surface-card';
  root.innerHTML='<h2>Agent 供应商中心</h2><p>ApiX 推理与执行 Agent 的统一模型配置入口。供应商只写入 ApiX 启动的进程，不改写系统环境或 CLI 全局配置；Codex 官方登录仍使用本机已有账户。</p><button type="button" class="outline-button" data-provider-refresh>刷新供应商与员工</button><p role="status" aria-live="polite" data-provider-status>正在读取供应商…</p><div data-provider-content></div>';
  container.prepend(root);const status=root.querySelector<HTMLElement>('[data-provider-status]')!,content=root.querySelector<HTMLElement>('[data-provider-content]')!;
  let data:Catalog|null=null;let manager:ManagerSettings|null=null;let presets:Preset[]=[];let editingId='';let busy=false;let testPending=false;let restoreControls=()=>{};
  async function request(path='/api/agent-providers',body?:unknown){const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error??'供应商请求失败');return result;}
  async function load(){const [catalog,settings]=await Promise.all([request('/api/agent-providers'),request('/api/manager/settings')]);data=catalog as Catalog;manager=settings as ManagerSettings;}
  async function action(work:()=>Promise<void>,success='已保存。员工切换会清除原账户绑定与模型费率，请按当前通道维护预算；已有 ApiX 对话请使用当前应用配置。'){
    if(busy)return;busy=true;root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(b=>b.disabled=true);status.textContent='正在处理…';
    try{await work();await load();render();status.textContent=success;}
    catch(error){status.textContent=error instanceof Error?error.message:String(error);status.tabIndex=-1;status.focus();}
    finally{busy=false;root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(b=>b.disabled=false);restoreControls();}
  }
  function render(){
    if(!data||!manager)return;
    const apix=data.agents.find(a=>a.id==='apix')!;const bound=data.providers.find(p=>p.id===apix.providerId);
    const editing=data.providers.find(p=>p.id===editingId);
    const apixOptions=data.providers.filter(p=>data!.protocols.apix?.includes(p.apiType)&&p.authHeader!=='bearer').map(p=>`<option value="${esc(p.id)}" ${apix.providerId===p.id?'selected':''}>${esc(p.name)} · ${esc(p.model)}</option>`).join('');
    const employees=data.agents.filter(a=>a.id!=='apix');
    const current=manager.baseUrl?`${esc(manager.model||'未填写模型')} · ${esc(manager.baseUrl)}`:'尚未配置 ApiX 模型通道';
    const authHeader=editing?.apiType==='anthropic-messages'?editing.authHeader??'default':'default';
    content.innerHTML=`
      <section class="provider-apix">
        <h3>ApiX 模型通道</h3>
        <p class="provider-current">当前：<strong>${current}</strong></p>
        <p class="coord-muted">${bound?`绑定供应商：${esc(bound.name)}`:'当前配置尚未绑定到供应商。'}</p>
        ${apix.adoptable?`<div class="provider-adopt" role="note"><p>检测到现有 ApiX 模型配置尚未纳入供应商中心。导入后可在这里统一编辑、切换和测试。</p><button type="button" class="outline-button" data-provider-adopt>导入为供应商</button></div>`:''}
        <form data-agent="apix" class="provider-agent provider-apix-form"><label>使用供应商<select name="providerId" required><option value="">选择兼容供应商</option>${apixOptions}</select></label><button class="outline-button">应用到 ApiX</button></form>
        <details class="provider-test"><summary>测试已保存的 ApiX 连接</summary><p class="coord-muted">使用当前项目预算调用一次模型；无项目工具、不启动员工。90 秒后请求终止；结果不证明工具或员工可用。</p><label><input type="checkbox" data-test-approved>批准一次连接测试，可能产生模型费用</label><button type="button" class="outline-button" data-test-connection ${!manager.model||!manager.baseUrl||testPending?'disabled':''}>${testPending?'正在测试…':'测试连接'}</button><p data-test-status role="status"></p></details>
      </section>
      <h3>执行 Agent 绑定</h3>
      <p>为 Codex、Claude Code 等员工选择兼容供应商。切换后清除原账户绑定与模型费率，防止把旧通道预算误当作新通道余额；切换本身不重跑任务。</p>
      <div class="provider-agents">${employees.map(a=>{const p=data!.providers.find(p=>p.id===a.providerId);return `<form data-agent="${esc(a.id)}" class="provider-agent"><h4>${esc(a.name)} <small>${esc(runtimeNames[a.runtime]??a.runtime)}</small></h4><p>${esc(p?p.name+' · '+p.model:a.model||'模型沿用 CLI 配置')}</p><p class="coord-muted">${esc(p?.baseUrl||(p?.apiType==='codex-login'?'官方订阅登录':a.baseUrl||a.source))}</p><label>使用供应商<select name="providerId"><option value="">${a.runtime==='apix'?'选择供应商（当前应用设置保留）':'沿用本机 CLI 配置'}</option>${data!.providers.filter(p=>data!.protocols[a.runtime]?.includes(p.apiType)&&(p.authHeader!=='bearer'||a.runtime==='claude')).map(p=>`<option value="${esc(p.id)}" ${a.providerId===p.id?'selected':''}>${esc(p.name)} · ${esc(protocolNames[p.apiType]??p.apiType)}</option>`).join('')}</select></label><button class="outline-button">应用到 ${esc(a.name)}</button></form>`;}).join('')||'<p class="coord-muted">尚未注册执行员工。可在“任务与员工”中注册 Codex、Claude Code 等运行时。</p>'}</div>
      <details open class="provider-configs">
        <summary>供应商配置 · ${data.providers.length}</summary>
        <div class="provider-cards">${data.providers.map(p=>`<article class="provider-card"><div><strong>${esc(p.name)}</strong><span class="type-label">${esc(protocolNames[p.apiType]??p.apiType)}</span></div><code>${esc(p.model)}</code><p>${esc(p.baseUrl||'官方登录')}</p><footer><span>${p.hasKey?'密钥已保存':p.apiType==='codex-login'?'本机登录':'无密钥（本地服务）'}</span><button type="button" class="text-action" data-provider-edit="${esc(p.id)}">编辑</button></footer></article>`).join('')||'<div class="empty-card">还没有供应商。填写下方表单创建第一个。</div>'}</div>
        <label>编辑供应商<select data-provider-editor><option value="">新建供应商</option>${data.providers.map(p=>`<option value="${esc(p.id)}" ${editingId===p.id?'selected':''}>${esc(p.name)} · ${esc(p.model)}</option>`).join('')}</select></label>
        <form data-provider-form class="stacked-form">
          <label>从内置预设填充<select data-provider-preset><option value="">手动填写</option>${presets.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.baseUrl)}</option>`).join('')}</select></label>
          <label>名称<input name="name" maxlength="100" required value="${esc(editing?.name??'')}" placeholder="例如：百炼工作通道"></label>
          <label>接口与认证<select name="apiType">${Object.entries(protocolNames).map(([value,label])=>`<option value="${value}" ${editing?.apiType===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>
          <label data-provider-auth-header ${editing?.apiType==='anthropic-messages'?'':'hidden'}>Anthropic 认证方式<select name="authHeader"><option value="default" ${authHeader==='default'?'selected':''}>API Key（x-api-key，标准协议）</option><option value="bearer" ${authHeader==='bearer'?'selected':''}>Bearer Token（仅 Claude 员工）</option></select></label>
          <label data-provider-url ${editing?.apiType==='codex-login'?'hidden':''}>Base URL<input name="baseUrl" type="url" value="${esc(editing?.baseUrl??'')}" placeholder="供应商控制台提供的 API 基础地址"></label>
          <label>声明的上下文窗口 (Token)<input name="contextWindow" type="number" min="4096" max="1000000" value="${editing?.contextWindow??''}" placeholder="留空使用模型目录或全局值"></label>
          <label>模型 ID<input name="model" maxlength="200" required list="provider-local-models" value="${esc(editing?.model??'')}" placeholder="该通道支持的完整模型 ID"></label>
          <label data-provider-key ${editing?.apiType==='codex-login'?'hidden':''}>API Key<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${editing?.hasKey?'留空保留已保存的密钥':'本地回环服务可留空'}"><small>${editing?.hasKey?'密钥仅保存在本机应用数据目录，不回显；更换地址或协议需要重新填写。':'远程服务必须填写；本地回环服务可留空。'}</small></label>
          <button type="button" class="text-action" data-provider-discover hidden>读取本地模型</button><datalist id="provider-local-models"></datalist>
          <p data-provider-discovery-status class="coord-muted" role="status"></p>
          <p data-provider-auth-hint class="coord-muted">${editing?.apiType==='codex-login'?'仅供 Codex 员工使用，读取已有 ChatGPT 登录；请填写该订阅支持的模型。不会执行登录、充值或更改本机配置。':''}</p>
          <div class="provider-actions"><button class="primary-button">保存供应商</button><button class="outline-button" type="button" data-provider-delete ${editing?'':'hidden'}>删除未使用的供应商</button></div>
        </form>
      </details>`;
    const form=content.querySelector<HTMLFormElement>('[data-provider-form]')!,editor=content.querySelector<HTMLSelectElement>('[data-provider-editor]')!;
    const field=(name:string)=>form.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement;
    const discover=content.querySelector<HTMLButtonElement>('[data-provider-discover]')!;
    const syncDiscovery=()=>{const url=field('baseUrl').value.trim(),type=field('apiType').value;discover.hidden=field('baseUrl').disabled||!isLoopback(url)||!['openai-completions','openai-responses'].includes(type);};
    const auth=()=>{const login=field('apiType').value==='codex-login';content.querySelector<HTMLElement>('[data-provider-auth-header]')!.hidden=field('apiType').value!=='anthropic-messages';content.querySelector<HTMLElement>('[data-provider-url]')!.hidden=login;content.querySelector<HTMLElement>('[data-provider-key]')!.hidden=login;field('baseUrl').required=!login;field('baseUrl').disabled=login;field('apiKey').disabled=login;field('authHeader').disabled=field('apiType').value!=='anthropic-messages';content.querySelector<HTMLElement>('[data-provider-auth-hint]')!.textContent=login?'仅供 Codex 员工使用，读取已有 ChatGPT 登录；请填写该订阅支持的模型。不会执行登录、充值或更改本机配置。':'';syncDiscovery();};
    restoreControls=()=>{auth();const test=content.querySelector<HTMLButtonElement>('[data-test-connection]');if(test)test.disabled=!manager!.model||!manager!.baseUrl||testPending;};
    editor.addEventListener('change',()=>{editingId=editor.value;render();});
    for(const button of content.querySelectorAll<HTMLButtonElement>('[data-provider-edit]'))button.addEventListener('click',()=>{
      editingId=button.dataset.providerEdit!;render();
      const name=content.querySelector<HTMLInputElement>('[data-provider-form] [name="name"]')!;
      name.focus();name.scrollIntoView({block:'nearest'});
    });
    field('apiType').addEventListener('change',auth);field('baseUrl').addEventListener('input',syncDiscovery);auth();
    content.querySelector<HTMLSelectElement>('[data-provider-preset]')!.addEventListener('change',event=>{
      const preset=presets.find(p=>p.id===(event.target as HTMLSelectElement).value);if(!preset)return;
      field('name').value=preset.name;field('baseUrl').value=preset.baseUrl;field('model').value=preset.models[0]?.id??'';
      if([...(field('apiType') as HTMLSelectElement).options].some(option=>option.value===preset.apiType))field('apiType').value=preset.apiType;
      field('apiKey').value='';auth();
    });
    discover.addEventListener('click',async()=>{
      const baseUrl=field('baseUrl').value.trim();if(!baseUrl)return;
      const target=content.querySelector<HTMLElement>('[data-provider-discovery-status]')!;
      discover.disabled=true;target.textContent='正在读取本地模型目录…';
      try{
        const result=await request('/api/manager/models',{baseUrl,apiKeyEnv:''}) as {models:{id:string;name:string}[]};
        content.querySelector<HTMLElement>('#provider-local-models')!.innerHTML=result.models.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
        target.textContent=result.models.length?`读取到 ${result.models.length} 个模型；请自行选择并保存。目录不保证模型已加载或能够对话。`:'服务目录为空；请先在本地服务安装或加载模型。';
      }catch(error){target.textContent='读取失败：'+(error instanceof Error?error.message:String(error))+'。可继续手动输入。';}
      finally{discover.disabled=false;}
    });
    form.addEventListener('submit',event=>{event.preventDefault();const values=Object.fromEntries(new FormData(form));const current=data!.providers.find(p=>p.id===editingId);void action(async()=>{const saved=await request('/api/agent-providers',{...values,id:current?.id,version:current?.version??0});editingId=saved.id;},'供应商已保存。已应用该供应商的 ApiX 与员工在后续执行中使用新配置；已有对话保留原连接。');});
    content.querySelector<HTMLButtonElement>('[data-provider-delete]')!.addEventListener('click',()=>{const current=data!.providers.find(p=>p.id===editingId);if(current&&confirm(`删除未使用的供应商“${current.name}”？`))void action(async()=>{await request('/api/agent-providers/remove',{id:current.id,version:current.version});editingId='';},'供应商已删除。');});
    content.querySelector<HTMLButtonElement>('[data-provider-adopt]')?.addEventListener('click',()=>{void action(async()=>{await request('/api/agent-providers/adopt',{});},'已导入为供应商，ApiX 继续使用当前配置；可在这里编辑、切换或测试。');});
    for(const row of content.querySelectorAll<HTMLFormElement>('[data-agent]'))row.addEventListener('submit',event=>{event.preventDefault();const agent=data!.agents.find(a=>a.id===row.dataset.agent)!;const id=String(new FormData(row).get('providerId')??'');const p=data!.providers.find(p=>p.id===id);void action(async()=>{await request('/api/agent-providers/bind',{agentId:agent.id,version:agent.version,providerId:id||null,providerVersion:p?.version});},agent.id==='apix'?'已应用到 ApiX；新建对话使用该配置，已有对话保留原连接。':undefined);});
    content.querySelector<HTMLButtonElement>('[data-test-connection]')?.addEventListener('click',async()=>{
      const button=content.querySelector<HTMLButtonElement>('[data-test-connection]')!,result=content.querySelector<HTMLElement>('[data-test-status]')!,approved=content.querySelector<HTMLInputElement>('[data-test-approved]')!;
      const project=options.project?.()??'';if(!project){result.textContent='请先选择项目，连接测试使用该项目的推理预算。';return;}
      if(!approved.checked){result.textContent='连接测试可能产生模型费用，请先勾选批准。';return;}
      testPending=true;button.disabled=true;button.textContent='正在测试…';result.textContent='正在调用已保存的 ApiX 模型…';
      try{const value=await request('/api/manager/test',{projectId:project,settings:manager!,approved:true}) as {durationMs:number};result.textContent=`推理连接成功，用时 ${(value.durationMs/1000).toFixed(1)} 秒；未执行项目工具或员工任务。`;}
      catch(error){result.textContent=error instanceof Error?error.message:String(error);}
      finally{testPending=false;approved.checked=false;if(button.isConnected){button.disabled=false;button.textContent='测试连接';}}
    });
  }
  root.querySelector('[data-provider-refresh]')!.addEventListener('click',()=>{void action(async()=>{},'已刷新供应商与员工。供应商真实余额由各平台提供；ApiX 的预算记录不等同于平台余额。');});
  document.addEventListener('apix:manager-settings',()=>{root.scrollIntoView({behavior:'smooth',block:'start'});content.querySelector<HTMLSelectElement>('[data-agent="apix"] select')?.focus();});
  void Promise.all([load(),request('/api/manager/providers')]).then(([,catalog])=>{presets=(catalog as {providers:Preset[]}).providers;render();status.textContent='供应商真实余额由各平台提供；ApiX 的预算记录不等同于平台余额。';}).catch(error=>{status.textContent='供应商加载失败：'+(error instanceof Error?error.message:String(error));});
}
