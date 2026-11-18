import {html} from './html.js';
import type {AgentSkill} from '../src/assistant-core/skills/manifest.js';

interface Installed {id:string;manifest:AgentSkill|null;revision:string|null;enabled:boolean;error?:string}
const root=document.querySelector<HTMLElement>('#skills-panel')!;
const open=root.querySelector<HTMLButtonElement>('#manage-agent-skills')!;
const dialog=document.createElement('dialog');
dialog.className='assistant-dialog agent-skill-dialog';
dialog.setAttribute('aria-labelledby','agent-skill-title');
dialog.innerHTML=html`
  <form method="dialog"><h2 id="agent-skill-title">AgentSkill 管理</h2><button class="text-action">关闭</button></form>
  <form class="stacked-form" data-skill-market>
    <label>内置技能<select name="candidate"></select></label>
    <button class="outline-button" type="submit">安装目录版本</button>
  </form>
  <form class="stacked-form" data-skill-import>
    <label>导入 AgentSkill JSON 清单<textarea name="manifest" rows="4" maxlength="48000" required></textarea></label>
    <button class="outline-button" type="submit">安装清单</button>
  </form>
  <section>
    <label>已安装技能<select data-skill-installed></select></label>
    <p data-skill-details></p>
    <button class="outline-button" type="button" data-skill-enable hidden>启用</button>
    <button class="text-action" type="button" data-skill-remove hidden>卸载</button>
    <button class="text-action" type="button" data-skill-refresh>刷新</button>
  </section>
  <p role="status" data-skill-status></p>`;
root.append(dialog);

const market=dialog.querySelector<HTMLFormElement>('[data-skill-market]')!;
const importing=dialog.querySelector<HTMLFormElement>('[data-skill-import]')!;
const candidates=market.elements.namedItem('candidate') as HTMLSelectElement;
const select=dialog.querySelector<HTMLSelectElement>('[data-skill-installed]')!;
const details=dialog.querySelector<HTMLElement>('[data-skill-details]')!;
const feedback=dialog.querySelector<HTMLElement>('[data-skill-status]')!;
const enable=dialog.querySelector<HTMLButtonElement>('[data-skill-enable]')!;
const remove=dialog.querySelector<HTMLButtonElement>('[data-skill-remove]')!;
let projectId='', busy=false, items:Installed[]=[], library:AgentSkill[]=[];
const path=(project:string)=>'/api/projects/'+encodeURIComponent(project)+'/agent-skills';

async function api<T>(url:string,body?:unknown):Promise<T>{
  const response=await fetch(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error??'技能请求失败');
  return result as T;
}

function selected(){return items.find(item=>item.id===select.value);}
function selection(){
  const current=selected();
  enable.hidden=!current?.manifest;
  remove.hidden=!current;
  enable.textContent=current?.enabled?'禁用':'启用';
  const manifest=current?.manifest;
  details.textContent=manifest
    ? [manifest.version,current?.enabled?'已启用':'未启用',manifest.permissions.join('、'),manifest.directory,manifest.description].filter(Boolean).join(' · ')
    : current?.error??'暂无已安装技能';
}

async function load(project:string,id=select.value){
  const found=await api<Installed[]>(path(project));
  if(projectId!==project||!dialog.open)return;
  items=found;
  select.replaceChildren(...items.map(item=>new Option(item.manifest?.name??item.id,item.id)));
  if(items.some(item=>item.id===id))select.value=id;
  selection();
}

async function perform(action:(project:string)=>Promise<void>){
  if(busy||!projectId)return;
  busy=true;
  const project=projectId;
  const controls=[...dialog.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input, textarea, select, button')];
  controls.forEach(control=>{control.disabled=true;});
  feedback.textContent='正在处理…';
  try{await action(project);feedback.textContent='';}
  catch(error){feedback.textContent=error instanceof Error?error.message:String(error);}
  finally{busy=false;controls.forEach(control=>{control.disabled=false;});}
}

open.addEventListener('click',()=>{
  if(!projectId||dialog.open)return;
  items=[];select.replaceChildren();selection();
  dialog.showModal();
  void perform(async project=>{
    library=await api<AgentSkill[]>('/api/agent-skills/market');
    candidates.replaceChildren(...library.map(item=>new Option(item.name+' '+item.version,item.id)));
    await load(project,'');
  });
});
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
select.addEventListener('change',selection);
dialog.querySelector('[data-skill-refresh]')!.addEventListener('click',()=>void perform(project=>load(project)));

async function install(project:string,id:string,body:Record<string,unknown>){
  const previous=items.find(item=>item.id===id);
  if(previous&&!window.confirm('安装此版本并替换当前清单？'))return;
  const result=await api<Installed>(path(project)+'/install',{...body,expectedRevision:previous?.revision});
  await load(project,result.id);
}
market.addEventListener('submit',event=>{
  event.preventDefault();
  const candidate=library.find(item=>item.id===candidates.value);
  if(candidate)void perform(project=>install(project,candidate.id,{market:{id:candidate.id,version:candidate.version}}));
});
importing.addEventListener('submit',event=>{
  event.preventDefault();
  void perform(async project=>{
    const field=importing.elements.namedItem('manifest') as HTMLTextAreaElement;
    const manifest=JSON.parse(field.value) as AgentSkill|null;
    if(!manifest||typeof manifest.id!=='string')throw new Error('清单须提供技能标识');
    await install(project,manifest.id,{manifest});
  });
});
enable.addEventListener('click',()=>{
  const entry=selected();
  if(!entry?.manifest)return;
  if(!entry.enabled&&!window.confirm('启用此版本并允许权限 '+entry.manifest.permissions.join('、')+'？'))return;
  void perform(async project=>{
    await api(path(project)+'/'+encodeURIComponent(entry.id)+'/enabled',{enabled:!entry.enabled,revision:entry.revision});
    await load(project,entry.id);
  });
});
remove.addEventListener('click',()=>{
  const entry=selected();
  if(!entry||!window.confirm('卸载这条技能？'))return;
  void perform(async project=>{await api(path(project)+'/'+encodeURIComponent(entry.id)+'/remove',{});await load(project,'');});
});
document.addEventListener('apix:snapshot',((event:CustomEvent<{projectId:string}>)=>{
  const next=event.detail.projectId;
  if(projectId!==next&&dialog.open)dialog.close();
  projectId=next;open.disabled=!projectId;
}) as EventListener);
