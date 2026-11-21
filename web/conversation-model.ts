import {html} from './html.js';
type Config={version:number;settings:{baseUrl?:string;apiType?:string;model:string;reasoningEffort?:string};providerName:string;models:{id:string;name:string}[];efforts:string[];followsManager?:boolean};
const labels:Record<string,string>={none:'关闭思考',low:'低',high:'高',max:'最高'};
export function conversationModelPicker(container:HTMLElement,compact=false){
  let key='',generation=0,config:Config|null=null,saving=false,locked=false;
  async function request(path:string,body?:unknown):Promise<Config>{const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error??'模型配置请求失败');return data;}
  function render(){
    if(!config)return;
    const c=config, disabled=locked||saving?'disabled':'';
    // 紧凑形态无可见顶标签，与执行方式、发送按钮同一基线；可访问名称由 aria-label 保留。
    const model=compact
      ?html`<label class="conversation-model-inline"><svg class="icon" aria-hidden="true"><use href="#icon-spark"/></svg><input list="${container.id}-models" aria-label="本对话模型" title="${c.settings.model}" placeholder="模型 ID" value="${c.settings.model}" maxlength="200" ${disabled}><datalist id="${container.id}-models">`+c.models.map(m=>html`<option value="${m.id}">${m.name}</option>`).join('')+'</datalist></label>'
      :html`<label><span>模型</span><input list="${container.id}-models" aria-label="本对话模型" title="${c.settings.model}" placeholder="选择或输入模型 ID" value="${c.settings.model}" maxlength="200" ${disabled}><datalist id="${container.id}-models">`+c.models.map(m=>html`<option value="${m.id}">${m.name}</option>`).join('')+'</datalist></label>';
    const effort=compact
      ?html`<label class="conversation-model-inline"><svg class="icon" aria-hidden="true"><use href="#icon-activity"/></svg><select aria-label="本对话思考强度" title="${c.efforts.length?'本对话思考强度':'此模型使用供应商默认思考强度'}" ${locked||saving||!c.efforts.length?'disabled':''}><option value="">思考 · 默认</option>`
      :html`<label><span>思考强度</span><select aria-label="本对话思考强度" title="${c.efforts.length?'本对话思考强度':'此模型使用供应商默认思考强度'}" ${locked||saving||!c.efforts.length?'disabled':''}><option value="">供应商默认</option>`;
    const effortOptions=c.efforts.map(e=>html`<option value="${e}" ${c.settings.reasoningEffort===e?'selected':''}>${labels[e]??e}</option>`).join('')+'</select></label>';
    const options=(c.models.length?'':'<button type="button" class="text-action" data-open-provider-center>去供应商中心配置</button>')
      +html`<small>${c.providerName} · ${c.followsManager?'沿用 ApiX 默认模型':'本对话自定义'}</small><button type="button" class="text-action" data-use-global-model ${disabled}>恢复 ApiX 默认模型</button><small>服务：${c.settings.baseUrl||c.providerName}</small>`;
    const actions=compact?'<details class="conversation-model-options"><summary aria-label="更多模型设置" title="更多模型设置">⋯</summary><div>'+options+'</div></details>':options;
    container.innerHTML='<div class="conversation-model-picker">'+model+effort+effortOptions+actions+'<span role="status" class="conversation-model-feedback"></span></div>';
  }
  container.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('[data-open-provider-center]'))document.querySelector<HTMLButtonElement>('[data-page-target="settings"]')?.click();});
  if(compact)container.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&!event.isComposing&&event.target instanceof HTMLInputElement){event.preventDefault();event.target.blur();}
  });
  (container.closest('form')??container.parentElement)?.addEventListener('submit',event=>{if(saving){event.preventDefault();event.stopImmediatePropagation();container.querySelector('[role=status]')!.textContent='正在保存模型选择，请稍后发送';}},true);
  container.addEventListener('click',event=>{if(!(event.target instanceof Element)||!event.target.closest('[data-use-global-model]')||saving||locked||!config)return;const selectedKey=key,version=generation,previous=config;saving=true;render();void request('/api/conversation-models/'+selectedKey,{version:previous.version,useGlobal:true}).then(value=>{if(version===generation){config=value;render();container.querySelector('[role=status]')!.textContent='已使用当前应用的服务地址、模型和凭据配置';}}).catch(error=>{if(version===generation){config=previous;render();container.querySelector('[role=status]')!.textContent=error instanceof Error?error.message:String(error);}}).finally(()=>{if(version===generation){saving=false;container.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=locked||(el instanceof HTMLSelectElement&&!config?.efforts.length));}});});
  container.addEventListener('change',event=>{if(saving||locked||!config||!(event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement))return;const selectedKey=key,version=generation,previous=config;const input=container.querySelector('input')!,select=container.querySelector('select')!;const changedModel=input.value.trim()!==previous.settings.model;saving=true;const payload={version:previous.version,model:input.value.trim(),reasoningEffort:changedModel?'':select.value};render();void request('/api/conversation-models/'+selectedKey,payload).then(value=>{if(version===generation){config=value;render();container.querySelector('[role=status]')!.textContent='已保存';}}).catch(error=>{if(version===generation){config=previous;render();container.querySelector('[role=status]')!.textContent=error instanceof Error?error.message:String(error);}}).finally(()=>{if(version===generation){saving=false;container.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=locked||(el instanceof HTMLSelectElement&&!config?.efforts.length));}});});
  document.addEventListener('apix:model-default-changed',()=>{
    if(!config?.followsManager||saving)return;
    const version=generation;
    void request('/api/conversation-models/'+key).then(value=>{
      if(version===generation&&!saving&&config?.followsManager&&value.version>config.version){config=value;render();}
    }).catch(()=>{});
  });
  return (kind:string,id:string,busy=false)=>{const next=kind+'/'+id;locked=busy;if(next===key){container.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=locked||saving||(el instanceof HTMLSelectElement&&!config?.efforts.length));return;}key=next;const version=++generation;saving=false;config=null;container.textContent='';if(!id)return;container.textContent='正在加载对话模型…';void request('/api/conversation-models/'+next).then(value=>{if(version===generation){config=value;render();}}).catch(error=>{if(version===generation){container.textContent=error instanceof Error?error.message:String(error);key='';}});};
}
