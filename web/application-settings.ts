import { selectProvider, settingsDraft, settingsPayload, localLookupRequest, mergeLocalModels, connectionTestRequest, type ModelDraft, type ModelSettings, type ProviderConfig } from './model-settings.js';
import {escapeAssistant as esc} from './assistant-view.js';
export function applicationModelSettings(container:HTMLElement,project:()=>string,notice:(message:string,error?:boolean)=>void){
container.insertAdjacentHTML('afterbegin',`<details class="coord-settings"><summary>ApiX 的推理模型</summary><p>应用默认模型供新对话使用；已有对话可在模型栏点击“使用当前应用配置”更新服务地址、模型和密钥引用。ApiX 独立调用模型 API；Pi、Codex、Claude 等是可选执行 Agent。支持 DeepSeek、阿里云百炼、火山引擎豆包等平台。</p><form id="coord-model"><label>模型平台<select name="provider" id="model-provider-select"><option value="">请选择模型 API</option><option value="custom">自定义 URL</option></select></label><div id="model-preset-config" hidden><label>选择模型<select name="model" id="model-select"><option value="">请先选择平台</option></select></label><label>或自定义模型名称 <span class="field-optional">(可选)</span><input name="customModelName" id="custom-model-name-input" placeholder="留空使用上方选中的模型"><small class="field-hint">用于该平台的其他模型，如新版本或特殊模型</small></label><label id="api-key-label">API Key<input type="hidden" name="apiKeyEnv"><input type="password" name="apiKey" id="api-key-input" autocomplete="new-password" spellcheck="false" placeholder="直接粘贴 API Key；留空保留已保存的密钥"><small class="field-hint" id="api-key-hint"></small></label></div><div id="model-custom-config" hidden><label>自定义 API URL<input name="baseUrl" type="url" placeholder="http://127.0.0.1:11434/v1"></label><label>模型 ID<input name="customModel" placeholder="例如 qwen-max"></label><label>API 类型<select name="apiType"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label>API Key<input type="hidden" name="customApiKeyEnv"><input type="password" name="customApiKey" autocomplete="new-password" spellcheck="false" placeholder="直接粘贴 API Key；本地无密钥服务可留空"><small class="field-hint">密钥仅保存在本机应用数据目录，不回显。修改服务地址后请重新填写密钥。</small></label></div><button class="outline-button">保存模型配置</button></form></details>`);
const root=container.querySelector<HTMLDetailsElement>('.coord-settings')!;root.open=true;
const $=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
async function api<T>(path:string,body?:unknown):Promise<T>{const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error??'请求失败');return value as T;}
async function action(work:()=>Promise<void>){try{await work();}catch(error){notice(error instanceof Error?error.message:String(error),true);}}
// Model form uses the same state/payload functions as its regression tests.
const modelForm=$<HTMLFormElement>('#coord-model');
for(const name of ['apiKey','customApiKey']) {
  const input=modelForm.elements.namedItem(name) as HTMLInputElement;
  const toggle=document.createElement('button');toggle.type='button';toggle.className='text-action';toggle.textContent='显示密钥';toggle.setAttribute('aria-pressed','false');
  toggle.addEventListener('click',()=>{const show=input.type==='password';input.type=show?'text':'password';toggle.textContent=show?'隐藏密钥':'显示密钥';toggle.setAttribute('aria-pressed',String(show));});
  input.insertAdjacentElement('afterend',toggle);
}
modelForm.insertAdjacentHTML('beforeend','<button type="button" id="model-discover" class="outline-button" hidden>读取本地模型</button><p id="model-discovery-status" class="coord-muted" role="status"></p><datalist id="local-model-options"></datalist>');
modelForm.insertAdjacentHTML('beforeend','<label><input type="checkbox" id="model-test-approved">批准一次连接测试，可能产生模型费用，使用当前项目的推理预算</label><button type="button" id="model-test" class="outline-button">测试已保存的模型连接</button><p class="coord-muted">无项目工具、不启动员工。90 秒后请求终止；离开页面不会取消调用，结果不证明工具或员工可用。</p><p id="model-test-status" role="status"></p>');
for(const name of ['customModel','customModelName'])(modelForm.elements.namedItem(name) as HTMLInputElement).setAttribute('list','local-model-options');
const providerSelect=$<HTMLSelectElement>('#model-provider-select');
const modelSelect=$<HTMLSelectElement>('#model-select');
let providers:ProviderConfig[]=[];let savedSettings:ModelSettings|null=null;let modelReady=false;
let lookupVersion=0;let lookupSignature='';let lookupPending=false;
let testPending=false;let testSignature='';
function modelDraft(){return Object.fromEntries(new FormData(modelForm)) as ModelDraft;}
function updateLocalLookup() {
  const request=modelReady?localLookupRequest(modelDraft(),providers):null;
  const signature=JSON.stringify([providerSelect.value,request]);
  if(signature!==lookupSignature){lookupSignature=signature;lookupVersion++;lookupPending=false;$('#model-discovery-status').textContent='';$('#local-model-options').innerHTML='';}
  const button=$<HTMLButtonElement>('#model-discover');button.hidden=!request;button.disabled=!request || lookupPending;
  const signatureTest=JSON.stringify([project(),modelDraft(),savedSettings]);
  if(signatureTest!==testSignature){testSignature=signatureTest;$('#model-test-status').textContent='';$<HTMLInputElement>('#model-test-approved').checked=false;}
  $<HTMLButtonElement>('#model-test').disabled=!modelReady || !project() || testPending;
  modelForm.querySelector<HTMLButtonElement>('button:not([type])')!.disabled=!modelReady || testPending;
}
function applyModelDraft(draft:ModelDraft) {
  const config=providers.find(p=>p.id===draft.provider);
  for(const name of ['apiKey','customApiKey']){const input=modelForm.elements.namedItem(name) as HTMLInputElement;input.value='';input.type='password';const toggle=input.nextElementSibling!;toggle.textContent='显示密钥';toggle.setAttribute('aria-pressed','false');}
  modelSelect.innerHTML=config?.models.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>').join('') || '<option value="">请先选择平台</option>';
  for(const [name,value] of Object.entries(draft)) (modelForm.elements.namedItem(name) as HTMLInputElement).value=value;
  $('#model-preset-config').hidden=!config;$('#model-custom-config').hidden=draft.provider!=='custom';
  $('#api-key-label').hidden=!!config && !config.requiresApiKey;
  $('#api-key-hint').textContent=config?.requiresApiKey?'直接填写密钥，保存后立即生效；留空保留原配置。密钥保存在本机，不回显。':'';
  updateLocalLookup();
}
providerSelect.addEventListener('change',()=>{try{applyModelDraft(selectProvider(providerSelect.value,providers));}catch(e){notice(String(e),true);}});
modelForm.addEventListener('input',updateLocalLookup);
modelForm.addEventListener('change',updateLocalLookup);
$('#model-discover').addEventListener('click',async()=>{
  const request=localLookupRequest(modelDraft(),providers);if(!modelReady || !request || lookupPending)return;
  const version=++lookupVersion;lookupPending=true;updateLocalLookup();
  const status=$('#model-discovery-status');status.textContent='正在读取本地模型目录…';
  try {
    const result=await api<{models:{id:string;name:string}[]}>('/api/manager/models',request);
    if(version!==lookupVersion)return;
    $('#local-model-options').innerHTML=result.models.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>').join('');
    if(providerSelect.value!=='custom'){
      const selected=modelSelect.value;
      modelSelect.innerHTML=mergeLocalModels(result.models,selected).map(m=>'<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>').join('');
      modelSelect.value=selected;
    }
    status.textContent=result.models.length?'读取到 '+result.models.length+' 个模型；请自行选择并保存。目录不保证模型已加载或能够对话。':'服务目录为空；已保留当前模型，请先在本地服务安装或加载模型。';
  } catch(e){if(version===lookupVersion)status.textContent='读取失败：'+(e instanceof Error?e.message:String(e))+'。已保留当前配置，可继续手动输入。';}
  finally {if(version===lookupVersion){lookupPending=false;updateLocalLookup();}}
});
$('#model-test').addEventListener('click',async()=>{
  if(testPending)return;
  const status=$('#model-test-status');
  try{
    const request=connectionTestRequest(modelDraft(),providers,savedSettings,modelReady,project(),$<HTMLInputElement>('#model-test-approved').checked);
    testPending=true;updateLocalLookup();const signature=testSignature;
    status.textContent='正在测试已保存的模型…';
    try{
      const result=await api<{projectId:string;durationMs:number}>('/api/manager/test',request);
      if(signature===testSignature)status.textContent=`推理连接成功，用时 ${(result.durationMs/1000).toFixed(1)} 秒；未执行项目工具或员工任务。`;
    }catch(e){if(signature===testSignature)status.textContent=e instanceof Error?e.message:String(e);}
    finally{testPending=false;$<HTMLInputElement>('#model-test-approved').checked=false;updateLocalLookup();}
  }catch(e){status.textContent=e instanceof Error?e.message:String(e);}
});
modelForm.addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
  const draft=Object.fromEntries(new FormData(modelForm)) as ModelDraft;
  const payload=settingsPayload(draft,providers,savedSettings,modelReady);
  savedSettings=await api<ModelSettings>('/api/manager/settings',payload);
  applyModelDraft(settingsDraft(savedSettings,providers));
  notice('应用模型已保存；新对话直接使用，已有对话请点击“使用当前应用配置”更新。');
  updateLocalLookup();
});});
modelForm.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select').forEach(el=>el.disabled=true);
void Promise.all([api<{providers:ProviderConfig[]}>('/api/manager/providers'),api<ModelSettings>('/api/manager/settings')]).then(([catalog,settings])=>{
  providers=catalog.providers;savedSettings=settings;
  providerSelect.innerHTML='<option value="">请选择模型 API</option>'+providers.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('')+'<option value="custom">自定义 API URL</option>';
  applyModelDraft(settingsDraft(settings,providers));modelReady=true;
  modelForm.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select').forEach(el=>el.disabled=false);
  updateLocalLookup();
}).catch(e=>notice('模型目录或设置加载失败，已禁止保存以保护原配置。请刷新重试：'+String(e),true));

return {projectChanged:updateLocalLookup};
}
