import {html} from './html.js';
import {trackSettingsSave} from './application-settings.js';
type Provider={contextWindow?:number|null;id:string;version:number;name:string;model:string;baseUrl:string;apiType:string;authHeader?:string;hasKey:boolean;lastSuccessAt?:string|null;lastSuccessModel?:string|null};
type Agent={id:string;name:string;runtime:string;providerId:string|null;version:number|string;model:string;baseUrl?:string;source:string;configured?:boolean;adoptable?:boolean};
type Catalog={providers:Provider[];agents:Agent[];protocols:Record<string,string[]>};
type Preset={id:string;name:string;baseUrl:string;apiType:string;requiresApiKey:boolean;models:{id:string;name:string}[]};
type ManagerSettings={provider:string;model:string;baseUrl:string;apiType:string;apiKeyEnv:string};
type Options={project?:()=>string;routes:HTMLElement;showProviders:()=>void};
const protocolNames:Record<string,string>={'openai-completions':'OpenAI Chat Completions','openai-responses':'OpenAI Responses（Codex API）','anthropic-messages':'Anthropic Messages（Claude）','google-generative-ai':'Google Gemini','codex-login':'Codex 官方 ChatGPT 登录（本机已有登录）'};
const protocolTags:Record<string,string>={'openai-completions':'Chat Completions','openai-responses':'Responses','anthropic-messages':'Anthropic','google-generative-ai':'Gemini','codex-login':'Codex 登录'};
const runtimeNames:Record<string,string>={apix:'ApiX',codex:'Codex CLI',claude:'Claude Code',pi:'Pi',gemini:'Gemini CLI',opencode:'OpenCode',kimi:'Kimi CLI'};
function isLoopback(baseUrl:string){try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(baseUrl).hostname.toLowerCase());}catch{return false;}}
// 抽屉草稿：关闭抽屉时暂存表单值，重新打开同一供应商时恢复；仅保存在内存中。
function drawerFormValues(form:HTMLFormElement){return [...form.elements].filter((el): el is HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement=>el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement).map(el=>({t:el.tagName,v:el.value,c:el instanceof HTMLInputElement&&el.checked}));}
function restoreDrawerValues(form:HTMLFormElement,values:{t:string;v:string;c:boolean}[]){const fields=[...form.elements].filter((el): el is HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement=>el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement);values.forEach((value,index)=>{const el=fields[index];if(!el||el.tagName!==value.t)return;if(el instanceof HTMLInputElement&&(el.type==='checkbox'||el.type==='radio'))el.checked=value.c;else el.value=value.v;});}
export function providerCenter(container:HTMLElement,options:Options){
  const root=document.createElement('section');root.className='provider-center surface-card';
  root.innerHTML=html`<div class="provider-heading"><h2>供应商中心</h2><button type="button" class="text-action" data-provider-refresh>刷新</button></div><p role="status" aria-live="polite" data-provider-status>正在读取供应商…</p><div data-provider-content></div><dialog class="provider-drawer" data-provider-drawer aria-label="供应商编辑抽屉"></dialog>`;
  container.prepend(root);const status=root.querySelector<HTMLElement>('[data-provider-status]')!,content=root.querySelector<HTMLElement>('[data-provider-content]')!,drawer=root.querySelector<HTMLDialogElement>('[data-provider-drawer]')!;
  let data:Catalog|null=null;let manager:ManagerSettings|null=null;let presets:Preset[]=[];let editingId='';let applyTarget='';let busy=false;let testPending=false;let restoreControls=()=>{};
  let showEditor=false,showCatalog=false,filter='',editorTrigger='';
  const routeStatus=document.createElement('p');routeStatus.setAttribute('role','status');options.routes.append(routeStatus);
  const routeDrafts=new Map<string,string>();
  let lastConnection:{version:Agent['version'];text:string;ok:boolean}|undefined;
  const announce=(message:string)=>{status.textContent=routeStatus.textContent=message;const local=drawer.querySelector('[data-drawer-status]');if(local)local.textContent=message;};
  const drawerDrafts=new Map<string,{t:string;v:string;c:boolean}[]>();
  async function request(path='/api/agent-providers',body?:unknown){const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error??'供应商请求失败');return result;}
  async function load(){const [catalog,settings]=await Promise.all([request('/api/agent-providers'),request('/api/manager/settings')]);const changed=JSON.stringify(manager)!==JSON.stringify(settings);data=catalog as Catalog;manager=settings as ManagerSettings;if(changed)document.dispatchEvent(new Event('apix:model-default-changed'));}
  async function action(work:()=>Promise<void>,success='员工供应商已应用。'){
    if(busy)return false;
    busy=true;const enabled=[root,options.routes].flatMap(el=>[...el.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button')]).filter(el=>!el.disabled);
    enabled.forEach(el=>el.disabled=true);announce('正在处理…');
    try{await work();await load();render();announce(success);return true;}
    catch(error){announce(error instanceof Error?error.message:String(error));return false;}
    finally{busy=false;enabled.forEach(el=>el.disabled=false);restoreControls();}
  }
  function closeEditor(){
    const form=drawer.querySelector<HTMLFormElement>('[data-provider-form]');
    if(form)drawerDrafts.set(editingId,drawerFormValues(form));
    showEditor=false;drawer.close();drawer.replaceChildren();
    ([...content.querySelectorAll<HTMLButtonElement>('[data-provider-edit]')].find(button=>button.dataset.providerEdit===editorTrigger)??content.querySelector<HTMLButtonElement>('[data-provider-add]'))?.focus();
  }
  drawer.addEventListener('cancel',event=>{event.preventDefault();if(!busy)closeEditor();});
  // 卡片第三行优先用真实推理账本自证；账本里没有成功记录时才说“未验证连接”，本次页面的手动测试只作次要信息。
  function connectionText(provider:Provider,tested?:{text:string;ok:boolean}){
    const time=Date.parse(String(provider.lastSuccessAt??''));
    const ledger=Number.isFinite(time)?`最近一次成功推理：${new Date(time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).replace(/\//g,'-')} · ${provider.lastSuccessModel??provider.model}`:'未验证连接';
    return tested?`${ledger} · 手动测试：${tested.ok?tested.text:'失败'}`:ledger;
  }
  function wireConnectionTest(scope:HTMLElement,agent:Agent,providerId?:string){
    const button=scope.querySelector<HTMLButtonElement>('[data-test-connection]')!;
    const result=scope.querySelector<HTMLElement>('[data-test-status]')!;
    const approved=scope.querySelector<HTMLInputElement>('[data-test-approved]')!;
    button.addEventListener('click',async()=>{
      const project=options.project?.()??'';
      if(!project){result.textContent='请先选择项目，连接测试使用该项目的推理预算。';return;}
      if(!approved.checked){result.textContent='请先批准这一次可能产生费用的连接测试。';return;}
      if(testPending)return;
      testPending=true;button.disabled=true;button.textContent='正在测试…';result.textContent='正在调用已保存的 ApiX 模型…';
      try{
        const value=await request('/api/manager/test',{projectId:project,settings:manager!,approved:true}) as {durationMs:number};
        lastConnection={version:agent.version,text:`连接成功 · ${value.durationMs} ms`,ok:true};
      }catch(error){
        lastConnection={version:agent.version,text:error instanceof Error?error.message:String(error),ok:false};
      }finally{
        testPending=false;approved.checked=false;
        if(button.isConnected){button.disabled=false;button.textContent='测试连接';}
      }
      if(lastConnection){
        result.textContent=lastConnection.text;
        const badge=[...content.querySelectorAll<HTMLElement>('[data-provider-connection]')].find(node=>node.dataset.providerConnection===providerId),tested=data?.providers.find(item=>item.id===providerId);
        if(badge&&tested&&data?.agents.find(item=>item.id==='apix')?.version===agent.version){badge.textContent=connectionText(tested,lastConnection);badge.dataset.connectionState=lastConnection.ok?'ok':'failed';}
      }
    });
  }
  function render(){
    if(!data||!manager)return;
    const apix=data.agents.find(a=>a.id==='apix')!;const bound=data.providers.find(p=>p.id===apix.providerId);
    const editing=data.providers.find(p=>p.id===editingId);
    const apixOptions=data.providers.filter(p=>data!.protocols.apix?.includes(p.apiType)&&p.authHeader!=='bearer').map(p=>html`<option value="${p.id}" ${apix.providerId===p.id?'selected':''}>${p.name} · ${p.model}</option>`).join('');
    const employees=data.agents.filter(a=>a.id!=='apix');
    const current=manager.baseUrl?`${bound?.name??new URL(manager.baseUrl).hostname} · ${manager.model}`:'尚未配置 ApiX 模型通道';
    content.innerHTML=html`
      <div class="provider-toolbar"><input type="search" data-provider-search aria-label="查找供应商" placeholder="查找供应商" value="${filter}" ${showCatalog?'hidden':''}><button type="button" class="primary-button" data-provider-add aria-expanded="${showCatalog}">${showCatalog?'关闭目录':'添加供应商'}</button></div>
      <div class="provider-cards" ${showCatalog?'hidden':''}>` + (data.providers.map(p=>{const users=data!.agents.filter(a=>a.providerId===p.id);const tested=apix.providerId===p.id&&lastConnection?.version===apix.version?lastConnection:undefined;return html`<article class="provider-card"><span class="provider-icon" aria-hidden="true">${p.name.slice(0,1).toUpperCase()}</span><div class="provider-identity"><strong>${p.name}</strong><small>${p.baseUrl?new URL(p.baseUrl).hostname:'本机 Codex 登录'} · ${p.model}</small></div><div class="provider-usage"><span>${users.map(a=>a.id==='apix'?'ApiX 默认':a.name).join('、')||'未绑定'}</span><small>${p.hasKey?'密钥已保存':p.apiType==='codex-login'?'本机登录':'无需密钥'}</small><small data-provider-connection="${p.id}" data-connection-state="${p.lastSuccessAt?'ok':tested?.ok?'ok':tested?'failed':'unknown'}">${connectionText(p,tested)}</small></div><button type="button" class="text-action" data-provider-edit="${p.id}" aria-label="编辑 ${p.name}">编辑</button></article>`;}).join('')) + html`</div>
      <p class="coord-muted" data-provider-empty hidden></p>
      <section class="provider-catalog" ${showCatalog?'':'hidden'} aria-label="添加供应商">
        <div class="provider-heading"><h3>添加供应商</h3><button type="button" class="text-action" data-provider-template="custom">＋ 自定义供应商</button></div>
        <h4>订阅登录</h4><div class="provider-templates"><button type="button" class="outline-button" data-provider-template="codex-login">Codex · 本机登录</button></div>
        <h4>模型 API</h4><div class="provider-templates">` + presets.map(p=>html`<button type="button" class="outline-button" data-provider-template="${p.id}">${p.name}</button>`).join('') + html`</div>
      </section>
      <section class="surface-card provider-bindings"><h2>模型与 Agent 路由</h2><section class="provider-apix">
        <h3>ApiX 模型通道</h3>
        <p class="provider-current">当前：<strong>${current}</strong></p>
        <p class="coord-muted">${bound?`绑定供应商：${bound.name}`:'当前配置尚未绑定到供应商。'}</p>
        ` + (apix.adoptable?html`<div class="provider-adopt" role="note"><p>检测到现有 ApiX 模型配置尚未纳入供应商中心。导入后可在这里统一编辑、切换和测试。</p><button type="button" class="outline-button" data-provider-adopt>导入为供应商</button></div>`:'') + html`
        <form data-agent="apix" data-settings-managed class="provider-agent provider-apix-form"><label>使用供应商<select name="providerId" data-saved-value="${apix.providerId??''}" required ${apixOptions?'':'disabled'}><option value="">选择兼容供应商</option>` + (apixOptions) + html`</select></label><button class="outline-button">应用到 ApiX</button></form>` + (!apixOptions?'<p>暂无兼容供应商。<button type="button" class="text-action" data-show-providers>去供应商管理</button></p>':'') + html`
        ` + (manager.model&&manager.baseUrl?html`<details class="provider-test" open><summary>测试已保存的 ApiX 连接</summary><p class="coord-muted">使用当前项目预算调用一次模型；无项目工具、不启动员工。90 秒后请求终止；结果不证明工具或员工可用。</p><label class="settings-toggle"><input type="checkbox" role="switch" data-test-approved>批准一次连接测试，可能产生模型费用</label><button type="button" class="outline-button" data-test-connection ${testPending?'disabled':''}>${testPending?'正在测试…':'测试连接'}</button><p data-test-status role="status"></p></details>`:'<p class="coord-muted" data-test-unavailable>保存并应用供应商后，可在这里测试已保存的 ApiX 连接。</p>') + html`
      </section>
      <h3>执行 Agent 绑定</h3>
      <p class="coord-muted">Codex API 使用 Responses，Claude Code 使用 Anthropic Messages。员工切换通道后需重新绑定预算账户和费率。</p>
      <div class="provider-agents">` + (employees.map(a=>{const p=data!.providers.find(p=>p.id===a.providerId);return html`<form data-agent="${a.id}" data-settings-managed class="provider-agent"><h4>${a.name} <small>${runtimeNames[a.runtime]??a.runtime}</small></h4><p>${p?'已应用 ApiX 供应商：':'未绑定 ApiX 供应商：'}${p?p.name+' · '+p.model:a.model||'模型沿用 CLI 配置'}</p><div class="provider-protocols" aria-label="支持的协议">` + (data!.protocols[a.runtime]??[]).map(type=>html`<span title="${protocolNames[type]??type}">${protocolTags[type]??type}</span>`).join('') + html`</div><label>使用供应商<select name="providerId" data-saved-value="${a.providerId??''}"><option value="">${a.runtime==='apix'?'选择供应商（当前应用设置保留）':'沿用本机 CLI 配置'}</option>` + (data!.providers.map(p=>{const compatible=data!.protocols[a.runtime]?.includes(p.apiType)&&(p.authHeader!=='bearer'||a.runtime==='claude');return html`<option value="${p.id}" ${a.providerId===p.id?'selected':''} ${compatible?'':'disabled'}>${p.name} · ${protocolNames[p.apiType]??p.apiType}${compatible?'':'（协议或认证不兼容）'}</option>`;}).join('')) + html`</select></label><button class="outline-button">应用到 ${a.name}</button><button type="button" class="text-action" data-provider-create-for="${a.id}">为此员工配置供应商</button></form>`;}).join('')||'<p class="coord-muted">尚未注册执行员工。可在“任务与员工”中注册 Codex、Claude Code 等运行时。</p>') + html`</div>
      </section>`;
    const bindings=content.querySelector<HTMLElement>('.provider-bindings')!;
    options.routes.replaceChildren(bindings,routeStatus);
    const editorVisible=showEditor&&!showCatalog;
    if(!editorVisible&&drawer.open)drawer.close();
    if(editorVisible){
      const authHeader=editing?.apiType==='anthropic-messages'?editing.authHeader??'default':'default';
      drawer.innerHTML=html`
        <div class="provider-drawer-head"><h3>${editing?'编辑供应商':'新建供应商'}</h3><button type="button" class="icon-button" data-provider-close-editor aria-label="关闭编辑抽屉"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div>
        <p role="status" data-drawer-status></p><label>编辑供应商<select data-provider-editor><option value="">新建供应商</option>` + (data.providers.map(p=>html`<option value="${p.id}" ${editingId===p.id?'selected':''}>${p.name} · ${p.model}</option>`).join('')) + html`</select></label>
        <form data-provider-form class="stacked-form">
          <label>从内置预设填充<select data-provider-preset><option value="">手动填写</option>` + (presets.map(p=>html`<option value="${p.id}">${p.name} · ${p.baseUrl}</option>`).join('')) + html`</select></label>
          <label>名称<input name="name" maxlength="100" required value="${editing?.name??''}" placeholder="例如：百炼工作通道"></label>
          <label>接口与认证<select name="apiType">` + (Object.entries(protocolNames).map(([value,label])=>html`<option value="${value}" ${editing?.apiType===value?'selected':''}>${label}</option>`).join('')) + html`</select></label>
          <label data-provider-auth-header ${editing?.apiType==='anthropic-messages'?'':'hidden'}>Anthropic 认证方式<select name="authHeader"><option value="default" ${authHeader==='default'?'selected':''}>API Key（x-api-key，标准协议）</option><option value="bearer" ${authHeader==='bearer'?'selected':''}>Bearer Token（仅 Claude 员工）</option></select></label>
          <label data-provider-url ${editing?.apiType==='codex-login'?'hidden':''}>Base URL<input name="baseUrl" type="url" value="${editing?.baseUrl??''}" placeholder="供应商控制台提供的 API 基础地址"></label>
          <label>声明的上下文窗口 (Token)<input name="contextWindow" type="number" min="4096" max="1000000" value="${editing?.contextWindow??''}" placeholder="留空使用模型目录或全局值"></label>
          <label>模型 ID<input name="model" maxlength="200" required list="provider-local-models" value="${editing?.model??''}" placeholder="该通道支持的完整模型 ID"></label>
          <label data-provider-key ${editing?.apiType==='codex-login'?'hidden':''}>API Key<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${editing?.hasKey?'留空保留已保存的密钥':'本地回环服务可留空'}"><small>${editing?.hasKey?'密钥仅保存在本机应用数据目录，不回显；更换地址或协议需要重新填写。':'远程服务必须填写；本地回环服务可留空。'}</small></label>
          <button type="button" class="text-action" data-provider-discover hidden>读取本地模型</button><datalist id="provider-local-models"></datalist>
          <p data-provider-discovery-status class="coord-muted" role="status"></p>
          <p data-provider-auth-hint class="coord-muted">${editing?.apiType==='codex-login'?'仅供 Codex 员工使用，读取已有 ChatGPT 登录；请填写该订阅支持的模型。不会执行登录、充值或更改本机配置。':''}</p>
          <label>应用目标（点击“保存并应用”生效）<select name="applyTarget"><option value="">仅保存，不应用</option>` + (data.agents.map(a=>html`<option value="${a.id}" ${applyTarget===a.id?'selected':''}>${a.name} · ${runtimeNames[a.runtime]??a.runtime}</option>`).join('')) + html`</select></label><p data-provider-target-hint class="coord-muted" role="status"></p><div class="provider-actions"><button class="primary-button">保存供应商</button><button type="button" class="text-action" data-provider-discard>放弃修改</button><button type="submit" class="outline-button" data-provider-save-apply>保存并应用</button><button class="outline-button" type="button" data-provider-delete ${editing?'':'hidden'}>删除未使用的供应商</button></div>
        </form>` + (editing&&bound?.id===editing.id&&manager.model&&manager.baseUrl?html`<details class="provider-test"><summary>测试已保存的连接</summary><p class="coord-muted">使用当前项目预算调用一次已保存的默认模型。</p><label class="settings-toggle"><input type="checkbox" role="switch" data-test-approved>批准一次连接测试，可能产生模型费用</label><button type="button" class="outline-button" data-test-connection>测试连接</button><p data-test-status role="status"></p></details>`:'');
      if(!drawer.open)drawer.showModal();
      const draft=drawerDrafts.get(editingId);
      if(draft){const form=drawer.querySelector<HTMLFormElement>('[data-provider-form]')!;restoreDrawerValues(form,draft);drawerDrafts.delete(editingId);}
    }
    const updateTestControl=()=>{const test=bindings.querySelector<HTMLButtonElement>('[data-test-connection]');if(test)test.disabled=!manager!.model||!manager!.baseUrl||testPending;};
    restoreControls=updateTestControl;
    const search=content.querySelector<HTMLInputElement>('[data-provider-search]')!,empty=content.querySelector<HTMLElement>('[data-provider-empty]')!;
    const searchProviders=()=>{
      filter=search.value;
      const rows=[...content.querySelectorAll<HTMLElement>('.provider-card')];
      for(const row of rows)row.hidden=!row.textContent!.toLowerCase().includes(filter.trim().toLowerCase());
      empty.hidden=showCatalog||rows.some(row=>!row.hidden);
      empty.textContent=rows.length?'没有匹配的供应商。':'尚未添加供应商。';
    };
    search.addEventListener('input',searchProviders);searchProviders();
    content.querySelector('[data-provider-add]')!.addEventListener('click',()=>{showCatalog=!showCatalog;render();content.querySelector<HTMLButtonElement>(showCatalog?'[data-provider-template="custom"]':'[data-provider-add]')?.focus();});
    for(const button of content.querySelectorAll<HTMLButtonElement>('[data-provider-template]'))button.addEventListener('click',()=>{
      editorTrigger='';editingId='';applyTarget='';showCatalog=false;showEditor=true;
      // 选择具体模板视为重新开始；仅“自定义供应商”沿用上次未保存的新建草稿。
      if(button.dataset.providerTemplate!=='custom')drawerDrafts.delete('');
      render();
      const form=drawer.querySelector<HTMLFormElement>('[data-provider-form]')!;
      if(button.dataset.providerTemplate==='codex-login'){
        (form.elements.namedItem('name') as HTMLInputElement).value='Codex';
        const protocol=form.elements.namedItem('apiType') as HTMLSelectElement;
        protocol.value='codex-login';protocol.dispatchEvent(new Event('change'));
      }else if(button.dataset.providerTemplate!=='custom'){
        const preset=drawer.querySelector<HTMLSelectElement>('[data-provider-preset]')!;
        preset.value=button.dataset.providerTemplate!;preset.dispatchEvent(new Event('change'));
      }
      (form.elements.namedItem('name') as HTMLInputElement).focus();
    });
    for(const button of content.querySelectorAll<HTMLButtonElement>('[data-provider-edit]'))button.addEventListener('click',()=>{
      editorTrigger=editingId=button.dataset.providerEdit!;applyTarget='';showEditor=true;showCatalog=false;render();
      const name=drawer.querySelector<HTMLInputElement>('[data-provider-form] [name="name"]')!;
      name.focus();name.scrollIntoView({block:'nearest'});
    });
    for(const button of bindings.querySelectorAll<HTMLButtonElement>('[data-provider-create-for]'))button.addEventListener('click',()=>{editorTrigger='';applyTarget=button.dataset.providerCreateFor!;editingId='';showEditor=true;showCatalog=false;options.showProviders();render();const agent=data!.agents.find(a=>a.id===applyTarget)!;const select=drawer.querySelector<HTMLSelectElement>('[data-provider-form] [name="apiType"]')!;select.value=data!.protocols[agent.runtime]?.[0]??'';select.dispatchEvent(new Event('change'));const name=drawer.querySelector<HTMLInputElement>('[data-provider-form] [name="name"]')!;name.value=agent.name+' 供应商';name.focus();name.scrollIntoView({block:'nearest'});});
    wireRouting(bindings,apix);
    if(!editorVisible)return;
    if(drawer.querySelector('[data-test-connection]'))wireConnectionTest(drawer,apix,apix.providerId??undefined);
    const form=drawer.querySelector<HTMLFormElement>('[data-provider-form]')!,editor=drawer.querySelector<HTMLSelectElement>('[data-provider-editor]')!;
    drawer.querySelector('[data-provider-close-editor]')!.addEventListener('click',closeEditor);
    drawer.querySelector('[data-provider-discard]')!.addEventListener('click',()=>{
      drawerDrafts.delete(editingId);applyTarget='';render();
      drawer.querySelector<HTMLInputElement>('[name="name"]')?.focus();
    });
    form.addEventListener('invalid',event=>{const input=event.target as HTMLInputElement;announce('请检查供应商表单：'+(input.closest('label')?.childNodes[0]?.textContent?.trim()??input.name)+' — '+input.validationMessage);},true);
    const field=(name:string)=>form.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement;
    const discover=drawer.querySelector<HTMLButtonElement>('[data-provider-discover]')!;
    const syncDiscovery=()=>{const url=field('baseUrl').value.trim(),type=field('apiType').value;discover.hidden=field('baseUrl').disabled||!isLoopback(url)||!['openai-completions','openai-responses'].includes(type);};
    const auth=()=>{const login=field('apiType').value==='codex-login';drawer.querySelector<HTMLElement>('[data-provider-auth-header]')!.hidden=field('apiType').value!=='anthropic-messages';drawer.querySelector<HTMLElement>('[data-provider-url]')!.hidden=login;drawer.querySelector<HTMLElement>('[data-provider-key]')!.hidden=login;field('baseUrl').required=!login;field('baseUrl').disabled=login;field('apiKey').disabled=login;field('authHeader').disabled=field('apiType').value!=='anthropic-messages';drawer.querySelector<HTMLElement>('[data-provider-auth-hint]')!.textContent=login?'仅供 Codex 员工使用，读取已有 ChatGPT 登录；请填写该订阅支持的模型。不会执行登录、充值或更改本机配置。':'';syncDiscovery();};
    const restoreBase=restoreControls;
    restoreControls=()=>{restoreBase();auth();};
    editor.addEventListener('change',()=>{drawerDrafts.set(editingId,drawerFormValues(form));editingId=editor.value;render();drawer.querySelector<HTMLSelectElement>('[data-provider-editor]')?.focus();});
    const syncTarget=()=>{applyTarget=field('applyTarget').value;const agent=data!.agents.find(a=>a.id===applyTarget),compatible=!!agent&&!!data!.protocols[agent.runtime]?.includes(field('apiType').value)&&(field('authHeader').value!=='bearer'||field('apiType').value!=='anthropic-messages'||agent.runtime==='claude');drawer.querySelector<HTMLButtonElement>('[data-provider-save-apply]')!.disabled=busy||!compatible;drawer.querySelector<HTMLElement>('[data-provider-target-hint]')!.textContent=agent?(compatible?'保存后应用到 '+agent.name+'，后续新执行生效。':'当前接口或认证与 '+agent.name+' 不兼容；请使用该 CLI 支持的接口。'):'仅保存不会改变任何 Agent 的通道。';};
    field('applyTarget').addEventListener('change',syncTarget);field('apiType').addEventListener('change',syncTarget);field('authHeader').addEventListener('change',syncTarget);syncTarget();const restoreAuth=restoreControls;restoreControls=()=>{restoreAuth();syncTarget();};
    field('apiType').addEventListener('change',auth);field('baseUrl').addEventListener('input',syncDiscovery);auth();
    drawer.querySelector<HTMLSelectElement>('[data-provider-preset]')!.addEventListener('change',event=>{
      const preset=presets.find(p=>p.id===(event.target as HTMLSelectElement).value);if(!preset)return;
      field('name').value=preset.name;field('baseUrl').value=preset.baseUrl;field('model').value=preset.models[0]?.id??'';
      drawer.querySelector<HTMLElement>('#provider-local-models')!.innerHTML=preset.models.map(m=>html`<option value="${m.id}">${m.name}</option>`).join('');
      if([...(field('apiType') as HTMLSelectElement).options].some(option=>option.value===preset.apiType))field('apiType').value=preset.apiType;
      field('apiKey').value='';auth();syncTarget();
    });
    discover.addEventListener('click',async()=>{
      const baseUrl=field('baseUrl').value.trim();if(!baseUrl)return;
      const target=drawer.querySelector<HTMLElement>('[data-provider-discovery-status]')!;
      discover.disabled=true;target.textContent='正在读取本地模型目录…';
      try{
        const result=await request('/api/manager/models',{baseUrl,apiKeyEnv:''}) as {models:{id:string;name:string}[]};
        drawer.querySelector<HTMLElement>('#provider-local-models')!.innerHTML=result.models.map(m=>html`<option value="${m.id}">${m.name}</option>`).join('');
        target.textContent=result.models.length?`读取到 ${result.models.length} 个模型；请自行选择并保存。目录不保证模型已加载或能够对话。`:'服务目录为空；请先在本地服务安装或加载模型。';
      }catch(error){target.textContent='读取失败：'+(error instanceof Error?error.message:String(error))+'。可继续手动输入。';}
      finally{discover.disabled=false;}
    });
    form.addEventListener('submit',event=>{event.preventDefault();const values=Object.fromEntries(new FormData(form)),target=(event.submitter as HTMLElement|null)?.hasAttribute('data-provider-save-apply')?data!.agents.find(a=>a.id===values.applyTarget):null;const current=data!.providers.find(p=>p.id===editingId);void action(async()=>{const saved=await request('/api/agent-providers',{...values,id:current?.id,version:current?.version??0});drawerDrafts.delete(current?.id??'');editingId=saved.id;if(target&&target.providerId!==saved.id){try{await request('/api/agent-providers/bind',{agentId:target.id,version:target.version,providerId:saved.id,providerVersion:saved.version});}catch(e){await load();render();throw Error('供应商已保存，但应用失败：'+(e instanceof Error?e.message:String(e))+'。请处理后在员工卡片重新应用。');}}},target?'供应商已保存并应用到 '+target.name+'；后续新执行生效。':'供应商已保存；未绑定的员工仍沿用本机 CLI。请选择员工并应用，或使用“保存并应用”。');});
    drawer.querySelector<HTMLButtonElement>('[data-provider-delete]')?.addEventListener('click',()=>{const current=data!.providers.find(p=>p.id===editingId);if(current&&confirm(`删除未使用的供应商“${current.name}”？`))void action(async()=>{await request('/api/agent-providers/remove',{id:current.id,version:current.version});drawerDrafts.delete(current.id);editingId='';},'供应商已删除。');});
  }
  function wireRouting(bindings:HTMLElement,apix:Agent){
    bindings.querySelector('[data-show-providers]')?.addEventListener('click',options.showProviders);
    bindings.querySelector<HTMLButtonElement>('[data-provider-adopt]')?.addEventListener('click',()=>{void action(async()=>{await request('/api/agent-providers/adopt',{});},'已导入为供应商，ApiX 继续使用当前配置；可在这里编辑、切换或测试。');});
    for(const row of bindings.querySelectorAll<HTMLFormElement>('[data-agent]')){
      const agent=data!.agents.find(item=>item.id===row.dataset.agent)!;
      const select=row.querySelector('select')!;
      const draft=routeDrafts.get(agent.id);
      if(draft!==undefined&&[...select.options].some(option=>option.value===draft&&!option.disabled))select.value=draft;
      select.addEventListener('change',()=>{
        if(select.value===(agent.providerId??''))routeDrafts.delete(agent.id);
        else routeDrafts.set(agent.id,select.value);
      });
      row.addEventListener('submit',event=>{
        event.preventDefault();const id=select.value,p=data!.providers.find(item=>item.id===id);
        trackSettingsSave(row,action(async()=>{
          await request('/api/agent-providers/bind',{agentId:agent.id,version:agent.version,providerId:id||null,providerVersion:p?.version});
          routeDrafts.delete(agent.id);
          document.dispatchEvent(new CustomEvent('apix:settings-saved',{detail:{form:row}}));
        },agent.id==='apix'?'已设为 ApiX 默认模型。沿用默认配置的对话会自动更新。':undefined));
      });
    }
    if(bindings.querySelector('[data-test-connection]'))wireConnectionTest(bindings,apix,apix.providerId??undefined);
  }
  root.querySelector('[data-provider-refresh]')!.addEventListener('click',()=>{void action(async()=>{},'已刷新供应商与员工。供应商真实余额由各平台提供；ApiX 的预算记录不等同于平台余额。');});

  void Promise.all([load(),request('/api/manager/providers')]).then(([,catalog])=>{presets=(catalog as {providers:Preset[]}).providers;render();status.textContent='';}).catch(error=>{status.textContent='供应商加载失败：'+(error instanceof Error?error.message:String(error));});
}
