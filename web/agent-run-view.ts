import {interactionForm,type RuntimeInteraction} from './runtime-interaction-form.js';
import {instructionState} from './execution-view.js';
import {html} from './html.js';
import {foldAgentRun,type RunEvent} from './agent-run-model.js';

const phases:Record<string,string>={executing:'运行中',waiting_input:'等待回答',waiting_approval:'等待批准',closing:'正在关闭',stopping:'正在停止',unknown:'停止或执行未确认',completed:'执行结束，待验证',failed:'失败',cancelled:'已取消'};
let selection=0,runId='',taskId='',timer:ReturnType<typeof setTimeout>|undefined,events:RunEvent[]=[],cursor:number|null=null;
const dialog=document.createElement('dialog');dialog.className='agent-run-dialog';dialog.setAttribute('aria-label','员工任务过程与成果');document.body.append(dialog);
async function api(path:string,body?:unknown){const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error??'读取失败');return result;}
const panel=document.createElement('section');panel.className='agent-run-panel';dialog.append(panel);
const wide=matchMedia('(min-width: 1100px)');
let opened=false,workspace=false,opener:HTMLElement|null=null;
const drafts=new Map<string,{content:string;mode:string;request?:string;body?:string}>();
const field=(selector:string)=>panel.querySelector<HTMLElement>(selector)!;
function saveDraft(){const form=panel.querySelector<HTMLFormElement>('[data-guidance]');if(form&&runId)drafts.set(runId,{content:form.querySelector('textarea')!.value,mode:form.querySelector('select')!.value,request:form.dataset.request,body:form.dataset.body});}
function present(){
  const root=document.querySelector<HTMLElement>('#page-assistant')!;
  let dock=root.querySelector<HTMLElement>('#assistant-run-dock');
  if(workspace&&wide.matches){
    if(!dock){dock=document.createElement('aside');dock.id='assistant-run-dock';dock.setAttribute('aria-label','员工过程与成果');root.querySelector('.assistant-workspace')!.append(dock);}
    dock.hidden=false;dock.append(panel);root.classList.add('show-agent-workbench');root.classList.remove('show-inspector');root.querySelector('#assistant-details')?.setAttribute('aria-expanded','false');if(dialog.open)dialog.close();
  }else{dialog.append(panel);if(dock)dock.hidden=true;root.classList.remove('show-agent-workbench');if(!dialog.open)dialog.showModal();}
}
function closeView(restoreFocus=true){
  if(!opened)return;saveDraft();opened=false;selection++;clearTimeout(timer);
  document.querySelector('#page-assistant')?.classList.remove('show-agent-workbench');const dock=document.querySelector<HTMLElement>('#assistant-run-dock');if(dock)dock.hidden=true;if(dialog.open)dialog.close();
  document.dispatchEvent(new CustomEvent('apix:agent-run-selected',{detail:null}));if(restoreFocus){const target=opener?.isConnected?opener:[...document.querySelectorAll<HTMLElement>('[data-worker-run]')].find(row=>row.dataset.workerRun===runId);target?.focus();}
}
wide.addEventListener('change',()=>{if(opened)present();});

async function load(generation:number){
  if(!opened||generation!==selection)return;
  try{
    const base='/api/runs/'+encodeURIComponent(runId),[info,page,interactions]=await Promise.all([api(base+'/runtime'),api(base+'/runtime-events'+(cursor?'?afterId='+cursor:'')),api(base+'/interactions')]);
    if(generation!==selection||!opened)return;
    const follow=field('[data-process]').scrollHeight-field('[data-process]').scrollTop-field('[data-process]').clientHeight<60;
    events.push(...page.items);if(page.nextCursor)cursor=page.nextCursor;field('[data-phase]').textContent=`${info.backend==='codex-app-server'?'Codex（App Server 试验）':info.backend==='claude-agent-sdk'?'Claude（SDK 试验）':'CLI'} · ${phases[info.phase]??info.phase} · ${info.active?'运行资源活跃':info.stopEvidence==='quiescent'?'已确认停止':info.stopEvidence==='root_exited'?'根进程已退出':'停止未确认'} · ${info.pendingInteractions} 项待处理`;
    const nodes=foldAgentRun(runId,events);if(nodes.length)field('[data-process]').querySelector('[data-process-empty]')?.remove();else if(!field('[data-process]').querySelector('[data-process-empty]'))field('[data-process]').insertAdjacentHTML('beforeend',html`<p data-process-empty>${info.backend==='cli'?'旧 CLI 没有统一过程帧；可查看本 Run 的公开报告或原始事件诊断。':'尚无公开过程事件，等待运行时更新。'}</p>`);
    if(!info.active&&!field('[data-report]').dataset.loaded){const details=await api('/api/tasks/'+encodeURIComponent(taskId)+'/details');if(generation!==selection||!opened)return;field('[data-report]').dataset.loaded=runId;const reports=(details.artifacts??[]).filter((artifact:any)=>artifact.run_id===runId&&artifact.kind==='agent-response');field('[data-report]').innerHTML=reports.length?reports.map((report:any)=>html`<details><summary>本 Run 的公开报告（不是验证证据）</summary><pre>${report.content}</pre></details>`).join(''):'<p>本 Run 没有保存公开报告。</p>';}
    for(const node of nodes){
      let element=[...panel.querySelectorAll<HTMLElement>('[data-node]')].find(e=>e.dataset.node===node.id);
      if(!element){const details=document.createElement('details');details.dataset.node=node.id;const summary=document.createElement('summary');summary.textContent=node.kind==='output'?'员工公开输出':node.text;const pre=document.createElement('pre');details.append(summary,pre);field('[data-process]').append(details);element=details;}
      element.querySelector('pre')!.textContent=node.kind==='output'?node.text:node.text+' · '+(node.status??'');
      if(node.kind!=='output')element.querySelector('summary')!.textContent=node.text+' · '+(node.status??'');
    }
    if(follow)field('[data-process]').scrollTop=field('[data-process]').scrollHeight;
    const signature=JSON.stringify(interactions);if(field('[data-interactions]').dataset.signature!==signature&&!field('[data-interactions]').contains(document.activeElement)){
      field('[data-interactions]').dataset.signature=signature;
      const items:RuntimeInteraction[]=interactions;
      field('[data-interactions]').replaceChildren(...items.map(item=>{
        if(item.state==='pending')return interactionForm(item,api,()=>void load(generation),error=>{
          if(generation===selection)field('[data-error]').textContent=String(error instanceof Error?error.message:error);
        });
        const status=document.createElement('p');
        const labels:Record<string,string>={answered:'已回答',denied:'已拒绝',invalidated:'已失效',expired:'已过期'};
        status.textContent=(item.kind==='question'?'问题':'审批')+' · '+(labels[item.state]??item.state)+' · '+instructionState('',item.answerDelivery);
        return status;
      }));
    }
    for(const form of panel.querySelectorAll<HTMLFormElement>('[data-interaction]')){const item=interactions.find((i:any)=>i.id===form.dataset.interaction);if(!item||item.state!=='pending')for(const button of form.querySelectorAll('button'))button.disabled=true;}
    field('[data-deliveries]').innerHTML=(info.deliveries??[]).map((delivery:any)=>html`<p>指导 ${delivery.message_id.slice(0,8)} · ${delivery.mode==='queue'?'排队补充':'运行中指导'} · ${instructionState('',delivery.state)}${delivery.state==='unknown'?'；请先核对，不要重复发送':''}</p>`).join('');
    const form=panel.querySelector<HTMLFormElement>('[data-guidance]')!,modes=Array.from(form.querySelectorAll<HTMLOptionElement>('option'));form.hidden=!info.active||!info.capabilities.queue&&!info.capabilities.steer;modes.forEach(o=>o.disabled=!info.capabilities[o.value]);
    if(!info.capabilities.steer)form.querySelector<HTMLSelectElement>('select')!.value='queue';
    field('[data-more]').hidden=!page.hasMore;field('[data-retry]').hidden=true;
    clearTimeout(timer);if(info.active||page.hasMore)timer=setTimeout(()=>void load(generation),page.hasMore?50:1200);
  }catch(error){if(generation===selection){field('[data-error]').textContent=String(error instanceof Error?error.message:error);field('[data-retry]').hidden=false;}}
}
export function openAgentRun(run:string,task:string,inWorkspace=false){
  saveDraft();opener=document.activeElement as HTMLElement;opened=true;workspace=inWorkspace;
  selection++;clearTimeout(timer);runId=run;taskId=task;events=[];cursor=null;
  panel.innerHTML=html`<header><div><h2>员工任务 · Run ${run.slice(0,8)}</h2><p data-task-name>正在读取任务…</p><small data-origin></small></div><div class="agent-run-actions"><button class="text-action" type="button" data-show-results>成果与检查 ↓</button><button class="outline-button" type="button" data-close aria-label="关闭员工过程">关闭</button></div></header><p data-phase>正在读取…</p><p data-error role="alert"></p><div class="agent-run-layout"><section><details open><summary>公开执行过程</summary><div data-process class="agent-run-process"></div></details><button class="outline-button" data-more hidden>继续加载历史</button><button class="outline-button" data-retry hidden>重试加载</button><div data-interactions></div><div data-deliveries></div><form data-guidance hidden><label>给当前员工的指导<textarea name="content" maxlength="16000" required></textarea></label><label>投递方式<select name="mode"><option value="steer">运行中指导</option><option value="queue">排队补充</option></select></label><button class="outline-button">发送给员工</button><p data-delivery role="status"></p></form></section><aside data-results><h3>成果与检查</h3><button class="text-action" type="button" data-show-process>返回过程与互动 ↑</button><p>执行结束不代表验收通过；文件、验证和冻结仍以任务证据为准。</p><button class="outline-button" data-artifacts>查看代码差异与交付</button><div data-report></div><div data-verification>实际验证：尚未读取，不能认定为通过。</div><div data-artifact-view></div></aside></div>`;
  let coordinationId:string|null=null;const version=selection;void api('/api/tasks/'+task+'/details').then(details=>{if(selection!==version)return;coordinationId=details.coordinationSessionId;field('[data-task-name]').textContent=details.task.prompt;field('[data-origin]').textContent=(details.task.employee_name??details.task.runtime)+' · '+details.task.project_name;field('[data-verification]').innerHTML=details.verification?.length?details.verification.map((check:any)=>html`<details><summary>宿主检查 ${check.id} · ${check.status}</summary><pre>${JSON.stringify(check.body,null,2)}</pre></details>`).join(''):'<p>本任务尚无宿主验证记录（未验证）。</p>';}).catch(error=>{if(selection===version)field('[data-error]').textContent=String(error instanceof Error?error.message:error);});
  field('[data-show-results]').addEventListener('click',()=>field('[data-results]').scrollIntoView({block:'start'}));
  field('[data-show-process]').addEventListener('click',()=>panel.scrollIntoView({block:'start'}));
  field('[data-close]').addEventListener('click',()=>closeView());field('[data-more]').addEventListener('click',()=>void load(selection));field('[data-retry]').addEventListener('click',()=>void load(selection));
  panel.querySelector<HTMLFormElement>('[data-guidance]')!.addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement,data=new FormData(form),version=selection,button=form.querySelector('button')!,content=String(data.get('content')),mode=String(data.get('mode')),body=JSON.stringify({content,mode});if(form.dataset.body!==body){form.dataset.body=body;form.dataset.request=crypto.randomUUID();}button.disabled=true;try{const result=await api('/api/runs/'+run+'/messages',{requestId:form.dataset.request,content,mode});if(version===selection){field('[data-delivery]').textContent='投递状态：'+instructionState('',result.delivery);if(['accepted','queued'].includes(result.delivery))form.querySelector('textarea')!.value='';}}catch(error){if(version===selection)field('[data-delivery]').textContent=String(error instanceof Error?error.message:error);}finally{button.disabled=false;}});
  field('[data-artifacts]').addEventListener('click',async()=>{const version=selection;try{const result=await api('/api/tasks/'+taskId+'/delivery');if(version!==selection)return;field('[data-artifact-view]').innerHTML=html`<p>任务：${result.status} · 冻结版本：${result.deliveryCommit??'未冻结'}</p><pre>${result.inspection?.preview??result.error??'暂无代码差异'}</pre><button class="outline-button" data-task-navigation>打开任务验收与恢复</button>`;field('[data-task-navigation]').addEventListener('click',()=>{closeView(false);document.dispatchEvent(new CustomEvent(coordinationId?'apix:open-goal':'apix:open-task',{detail:coordinationId??task}));});}catch(error){if(version===selection)field('[data-artifact-view]').textContent=String(error instanceof Error?error.message:error);}});
  const draft=drafts.get(run);if(draft){const form=panel.querySelector<HTMLFormElement>('[data-guidance]')!;form.querySelector('textarea')!.value=draft.content;form.querySelector('select')!.value=draft.mode;if(draft.request)form.dataset.request=draft.request;if(draft.body)form.dataset.body=draft.body;}
  present();document.dispatchEvent(new CustomEvent('apix:agent-run-selected',{detail:run}));field('[data-close]').focus();void load(selection);
}
dialog.addEventListener('close',()=>{if(dialog.contains(panel)&&opened&&!dialog.open)closeView();});
dialog.addEventListener('cancel',event=>{event.preventDefault();closeView();});
panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeView();}});
document.addEventListener('apix:open-agent-run',((event:CustomEvent<{runId:string;taskId:string;workspace?:boolean}>)=>openAgentRun(event.detail.runId,event.detail.taskId,!!event.detail.workspace)) as EventListener);
document.addEventListener('apix:close-agent-run',()=>closeView(false));
document.addEventListener('apix:thread-selected',()=>closeView(false));
document.addEventListener('apix:select-project',()=>closeView(false));
document.addEventListener('apix:page',((event:CustomEvent<string>)=>{if(event.detail!=='assistant')closeView(false);}) as EventListener);
