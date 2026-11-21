import {html} from './html.js';
import {providerCenter} from './provider-center.js';

export type SettingsSectionId='providers'|'routing'|'execution'|'scheduling';
export type SettingsExtras={workflow?:HTMLElement;execution?:HTMLElement;scheduling?:HTMLElement;autonomy?:HTMLElement};
type FieldState={t:string;v:string;c:boolean};
type FormState=FieldState[];
const submissions=new WeakMap<HTMLFormElement,Promise<unknown>>();
export function trackSettingsSave(form:HTMLFormElement|undefined,submission:Promise<unknown>){
  if(form)submissions.set(form,submission);
}
const managedForms=(panel:HTMLElement)=>[...panel.querySelectorAll<HTMLFormElement>('form[data-settings-managed]')];
const sectionTitles:Record<SettingsSectionId,string>={providers:'供应商管理',routing:'模型与 Agent 路由',execution:'执行与并发',scheduling:'预算与配额'};
const sectionOrder:SettingsSectionId[]=['providers','routing','execution','scheduling'];

function controls(form:HTMLFormElement){
  return [...form.elements].filter((el): el is HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement=>el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement);
}
function readField(el:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement):FieldState{
  const checked=el instanceof HTMLInputElement&&(el.type==='checkbox'||el.type==='radio')?el.checked:false;
  return {t:el.tagName,v:el.value,c:checked};
}
function sameFields(a:FormState,b:FormState){return JSON.stringify(a)===JSON.stringify(b);}
function applyState(form:HTMLFormElement,fields:FormState){
  controls(form).forEach((el,index)=>{
    const field=fields[index];if(!field||readField(el).t!==field.t)return;
    if(el instanceof HTMLInputElement&&(el.type==='checkbox'||el.type==='radio'))el.checked=field.c;
    else el.value=field.v;
    el.dispatchEvent(new Event('change',{bubbles:true}));
  });
}

export function applicationModelSettings(container:HTMLElement,project:()=>string,extras:SettingsExtras={}){
  const saved=localStorage.getItem('apix.settings.section') as SettingsSectionId|null;
  const active:SettingsSectionId=sectionOrder.includes(saved!)?saved!:'providers';
  container.innerHTML=html`<div class="settings-shell">
    <div class="settings-tabs" role="tablist" aria-label="设置分区">` + (sectionOrder.map(id=>html`<button type="button" role="tab" id="settings-tab-${id}" data-settings-tab="${id}" aria-selected="${id===active}" aria-controls="settings-panel-${id}" tabindex="${id===active?0:-1}">${sectionTitles[id]}<span class="settings-dirty-dot" data-tab-dirty="${id}" hidden aria-hidden="true"></span></button>`).join('')) + html`</div>` + (sectionOrder.map(id=>html`<section class="settings-panel" id="settings-panel-${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" data-settings-panel="${id}" ${id===active?'':'hidden'}></section>`).join('')) + html`</div>
    <div class="settings-unsaved-bar" data-unsaved-bar hidden>
      <p><span role="status" data-unsaved-text></span></p>
      <div class="settings-unsaved-actions"><button type="button" class="primary-button" data-unsaved-save>保存当前分区</button><button type="button" class="outline-button" data-unsaved-discard>放弃当前分区修改</button></div>
    </div>`;
  const panels=new Map(sectionOrder.map(id=>[id,container.querySelector<HTMLElement>(`#settings-panel-${id}`)!]));
  const tabs=new Map(sectionOrder.map(id=>[id,container.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)!]));
  const dots=new Map(sectionOrder.map(id=>[id,container.querySelector<HTMLElement>(`[data-tab-dirty="${id}"]`)!]));
  const bar=container.querySelector<HTMLElement>('[data-unsaved-bar]')!;
  const barText=container.querySelector<HTMLElement>('[data-unsaved-text]')!;
  const baselines=new WeakMap<HTMLFormElement,FormState>();
  const saveButton=bar.querySelector<HTMLButtonElement>('[data-unsaved-save]')!;
  const discardButton=bar.querySelector<HTMLButtonElement>('[data-unsaved-discard]')!;
  let saving=false;
  const dirty=new Set<SettingsSectionId>();
  let current:SettingsSectionId=active;

  providerCenter(panels.get('providers')!,{project,routes:panels.get('routing')!,showProviders:()=>selectSection('providers')});
  if(extras.workflow)panels.get('execution')!.append(extras.workflow);
  if(extras.execution)panels.get('execution')!.append(extras.execution);
  if(extras.scheduling)panels.get('scheduling')!.append(extras.scheduling);
  if(extras.autonomy)panels.get('execution')!.append(extras.autonomy);

  const changed=(id:SettingsSectionId)=>managedForms(panels.get(id)!).filter(form=>{
    const fields=controls(form).map(readField);
    if(!baselines.has(form))baselines.set(form,controls(form).map(el=>({...readField(el),v:el.dataset.savedValue??el.value})));
    const base=baselines.get(form)!;
    return !sameFields(base,fields);
  });
  function updateUi(){
    for(const id of sectionOrder){
      const isDirty=changed(id).length>0;
      if(isDirty)dirty.add(id);else dirty.delete(id);
      dots.get(id)!.hidden=!isDirty;
      panels.get(id)!.dataset.unsaved=isDirty?'true':'false';
    }
    bar.hidden=dirty.size===0;
    if(dirty.size)barText.textContent=`未保存的修改：${sectionOrder.filter(id=>dirty.has(id)).map(id=>sectionTitles[id]).join('、')}`;
    saveButton.disabled=saving||!dirty.has(current);
    discardButton.disabled=saving||!dirty.has(current);
    saveButton.textContent=saving?'正在保存…':'保存当前分区';
  }
  // 分区切换只隐藏面板，不重建 DOM；脏分区由渲染守卫跳过后台重渲染，草稿因此保留。
  function selectSection(id:SettingsSectionId,focusTab=false){
    current=sectionOrder.includes(id)?id:'providers';
    for(const section of sectionOrder){
      const on=section===current;
      panels.get(section)!.hidden=!on;
      const tab=tabs.get(section)!;
      tab.setAttribute('aria-selected',String(on));
      tab.tabIndex=on?0:-1;
    }
    localStorage.setItem('apix.settings.section',current);
    updateUi();
    if(focusTab)tabs.get(current)!.focus();
  }
  container.querySelector<HTMLElement>('.settings-tabs')!.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const index=sectionOrder.indexOf(current);
    const next=event.key==='Home'?0:event.key==='End'?sectionOrder.length-1:(index+(event.key==='ArrowRight'?1:-1)+sectionOrder.length)%sectionOrder.length;
    selectSection(sectionOrder[next]!,true);
  });
  for(const button of container.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'))button.addEventListener('click',()=>selectSection(button.dataset.settingsTab as SettingsSectionId));
  for(const panel of panels.values())new MutationObserver(records=>{
    if(records.some(record=>[...record.addedNodes,...record.removedNodes].some(node=>node instanceof Element&&(node.matches('form,input,select,textarea,option')||node.querySelector('form,input,select,textarea')))))updateUi();
  }).observe(panel,{childList:true,subtree:true});
  container.addEventListener('input',updateUi);
  container.addEventListener('change',updateUi);
  saveButton.addEventListener('click',async()=>{
    if(saving)return;
    const section=current,initialProject=project();
    saving=true;updateUi();
    try{
      // 保存后子视图可能重绘，下一项必须从当前 DOM 重新获取。
      let form=changed(section)[0];
      while(form&&project()===initialProject){
        submissions.delete(form);
        form.requestSubmit();
        const submission=submissions.get(form);if(!submission)break;
        form.inert=true;
        try{if(await submission!==true)break;}finally{form.inert=false;}
        const next=changed(section)[0];if(next===form)break;
        form=next;
      }
    }finally{saving=false;updateUi();}
  });
  discardButton.addEventListener('click',()=>{
    for(const form of changed(current))applyState(form,baselines.get(form)!);
    updateUi();
  });
  document.addEventListener('apix:manager-settings',()=>selectSection('routing'));
  document.addEventListener('apix:settings-section',((event:CustomEvent<SettingsSectionId>)=>selectSection(event.detail)) as EventListener);
  document.addEventListener('apix:settings-saved',((event:CustomEvent<{form:HTMLFormElement}>)=>{
    const {form}=event.detail;
    if(form.isConnected&&container.contains(form))baselines.set(form,controls(form).map(readField));
    updateUi();
  }) as EventListener);
  selectSection(active);
}
