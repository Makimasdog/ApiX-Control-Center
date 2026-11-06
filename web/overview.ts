import {html} from './html.js';
type Task = {id:string;project_id:string;plan_id:string|null;employee_id:string|null;prompt:string;status:string;updated_at:string};
type Employee = {id:string;name:string;role:string;runtime:string;department:string;enabled:number};
type Project = {id:string;name:string};
type Goal = {id:string;title:string;plan_id:string|null;derivedStatus:string;status:string};
type AssistantAction = {id:string;title:string} & (
  {action:'approve'|'answer'|'inspect'|'review';interactionId?:never;employee?:never}
  |{action:'worker_approve'|'worker_answer';interactionId:string;employee:string}
);
const assistantActionLabels={approve:'操作等待审批',answer:'对话等待回答',inspect:'对话需要检查',review:'代码交付等待审阅',worker_approve:'员工操作等待审批',worker_answer:'员工提问等待回答'};
const goalActionLabels:Record<string,string>={clarifying:'继续澄清需求',ready:'需求已齐备，等待确认',plan_review:'执行计划等待审查',awaiting_acceptance:'员工交付等待验收',attention:'任务需要处理'};
type Snapshot = {projects:Project[];tasks:Task[];employees:Employee[];departments:{id:string;name:string}[];runs:{id:string;task_id:string;status:string}[]};
const root=document.querySelector<HTMLElement>('#page-overview')!;
const $=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
const setMarkup=(selector:string,value:string)=>{const element=$(selector);if(element.innerHTML!==value)element.innerHTML=value;};
const status:Record<string,string>={awaiting_approval:'待审批',queued:'等待依赖',running:'执行中',stopping:'正在停止',completed:'待验收',accepted:'已验收',failed:'执行失败',blocked:'已阻塞',unknown:'状态未知',needs_revision:'需要修改',cancelled:'已取消',rejected:'已拒绝'};
const lanes=[
  {key:'waiting',name:'待启动',statuses:['awaiting_approval','queued']},
  {key:'active',name:'执行中',statuses:['running','stopping']},
  {key:'review',name:'待验收',statuses:['completed']},
  {key:'attention',name:'需处理',statuses:['failed','blocked','unknown','rejected','needs_revision','cancelled']},
  {key:'done',name:'已完成',statuses:['accepted']},
];
let snapshot:Snapshot={projects:[],tasks:[],employees:[],departments:[],runs:[]};let projectId='';let goals:Goal[]=[];let goalsProjectId='';let loadVersion=0;
let assistantActions:AssistantAction[]=[];
let actionsLoaded=false,actionErrors:string[]=[];
root.innerHTML=html`<div class="overview-header"><div><div class="eyebrow">APIX · COMMAND CENTER</div><h1>管理总览</h1><p>查看目标、员工与任务的真实进展，再决定下一步。</p></div><div class="overview-header-actions"><label>当前项目<select id="overview-project" aria-label="总览项目"></select></label><button class="primary-button" data-overview-nav="assistant">提出新任务</button></div></div>
<div id="overview-empty" class="surface-card overview-empty" hidden><h2>先添加项目</h2><p>ApiX 将在这里汇总该项目的目标、任务和员工状态。</p><button class="outline-button" data-overview-nav="projects">添加项目</button></div>
<div id="overview-content"><section class="overview-metrics" aria-label="项目概况"><article class="surface-card"><span>目标</span><strong id="overview-goal-count">0</strong><small>当前项目</small></article><article class="surface-card"><span>正在执行</span><strong id="overview-active-count">0</strong><small>真实运行任务</small></article><article class="surface-card"><span>等待你处理</span><strong id="overview-action-count">0</strong><small>澄清、确认、审批与验收</small></article><article class="surface-card"><span>参与员工</span><strong id="overview-employee-count">0</strong><small>当前项目计划</small></article></section>
<div class="overview-grid"><section class="surface-card overview-attention"><div class="overview-section-head"><div><h2>ApiX 等待你的决定</h2><p>显示需要继续澄清、确认、审批、验收或处理阻塞的事项。</p></div><span id="overview-attention-count" class="coord-pill">0 项</span></div><div id="overview-action-list"></div></section><section class="surface-card overview-team"><div class="overview-section-head"><div><h2>员工动态</h2><p>基于任务和 Run 状态；点击员工查看履历。</p></div><button class="text-action" data-overview-nav="missions">管理员工</button></div><div id="overview-team-list"></div><div id="overview-departments"></div></section></div>
<section class="surface-card overview-board-section"><div class="overview-section-head"><div><h2>任务流转</h2><p>任务由 ApiX 的已确认计划创建；状态变化由真实执行和用户验收决定。</p></div><span id="overview-board-count" class="coord-pill">0 个任务</span></div><div class="overview-filters"><label>查找任务<input id="overview-search" type="search" placeholder="按任务内容筛选"></label><label>员工<select id="overview-employee-filter"><option value="">全部员工</option></select></label></div><div id="overview-board" class="overview-board"></div></section>
<p id="overview-updated" class="overview-updated" aria-live="polite"></p></div>`;
function goalFor(task:Task){return goals.find(goal=>goal.plan_id===task.plan_id);}
function employeeFor(task:Task){return snapshot.employees.find(employee=>employee.id===task.employee_id);}
function render(){
  const selected=snapshot.projects.find(project=>project.id===projectId);
  $('#overview-empty').hidden=!!selected;$('#overview-content').hidden=!selected;
  const projectSelect=$<HTMLSelectElement>('#overview-project');
  const choices=snapshot.projects.map(project=>html`<option value="${project.id}">${project.name}</option>`).join('');
  if(projectSelect.innerHTML!==choices)projectSelect.innerHTML=choices;
  projectSelect.value=projectId;projectSelect.disabled=!snapshot.projects.length;
  if(!selected)return;
  const tasks=snapshot.tasks.filter(task=>task.project_id===projectId && task.plan_id && goalFor(task));
  const active=tasks.filter(task=>['running','stopping'].includes(task.status));
  const employeeIds=new Set(tasks.map(task=>task.employee_id));
  const goalActions=actionErrors.includes('协作待办')?[]:goals.filter(goal=>goalActionLabels[goal.derivedStatus]);
  const actionCount=goalActions.length+assistantActions.length;
  $('#overview-goal-count').textContent=String(goals.length);
  $('#overview-active-count').textContent=String(active.length);
  $('#overview-action-count').textContent=actionsLoaded&&!actionErrors.length?String(actionCount):'—';
  $('#overview-employee-count').textContent=String(employeeIds.size);
  $('#overview-attention-count').textContent=actionsLoaded?`${actionCount} 项`:'—';
  const actionRows=assistantActions.map(({id,title,action,interactionId,employee})=>html`<button type="button" class="overview-action" data-overview-assistant="${id}" data-overview-action="${action}" data-overview-interaction="${interactionId??''}"><span class="overview-action-dot"></span><span><strong>${title}</strong><small>${employee?employee+' · ':''}${assistantActionLabels[action]}</small></span><span aria-hidden="true">→</span></button>`).join('')
    +goalActions.map(goal=>html`<button type="button" class="overview-action" data-overview-goal="${goal.id}"><span class="overview-action-dot"></span><span><strong>${goal.title}</strong><small>${goalActionLabels[goal.derivedStatus]}</small></span><span aria-hidden="true">→</span></button>`).join('');
  setMarkup('#overview-action-list',actionRows+(actionErrors.length
    ?html`<p class="overview-placeholder" role="status">${actionErrors.join('、')}读取失败，正在重试。</p>`
    :actionRows?'':`<p class="overview-placeholder">${actionsLoaded?'当前没有等待你处理的事项。':'正在读取待办事项…'}</p>`));
  const team=snapshot.employees.filter(employee=>employee.enabled && (employeeIds.has(employee.id)||active.some(task=>task.employee_id===employee.id)));
  setMarkup('#overview-team-list',team.length?team.map(employee=>{const assigned=tasks.filter(task=>task.employee_id===employee.id);const running=assigned.filter(task=>['running','stopping'].includes(task.status));return html`<button class="overview-person" data-open-employee="${employee.id}"><span class="overview-person-mark">${employee.name.slice(0,1)}</span><span><strong>${employee.name}</strong><small>${employee.role} · ${employee.runtime}${running.length?` · ${running.length} 项执行中`:''}</small></span><span class="overview-person-state ${running.length?'working':''}">${running.length?'工作中':'待命'}</span></button>`;}).join(''):'<p class="overview-placeholder">项目尚未安排员工。创建目标并确认计划后会显示团队动态。</p>');
  const departments=[...new Set(team.map(employee=>employee.department || '未分组'))];
  setMarkup('#overview-departments',departments.length?html`<div class="overview-department-title">团队分布</div><div class="overview-department-list">` + (departments.map(name=>html`<span>${name} <strong>${team.filter(employee=>(employee.department||'未分组')===name).length}</strong></span>`).join('')) + html`</div>`:'');
  const employeeSelect=$<HTMLSelectElement>('#overview-employee-filter');const selectedEmployee=employeeSelect.value;
  const employeeOptions='<option value="">全部员工</option>'+team.map(employee=>html`<option value="${employee.id}">${employee.name}</option>`).join('');
  if(employeeSelect.innerHTML!==employeeOptions)employeeSelect.innerHTML=employeeOptions;
  if(team.some(employee=>employee.id===selectedEmployee))employeeSelect.value=selectedEmployee;
  renderBoard(tasks);
  $('#overview-updated').textContent=`最近更新：${new Date().toLocaleTimeString('zh-CN')} · 数据来自本机任务记录`;
}
function renderBoard(tasks:Task[]){
  const query=$<HTMLInputElement>('#overview-search').value.trim().toLowerCase();const employeeId=$<HTMLSelectElement>('#overview-employee-filter').value;
  const visible=tasks.filter(task=>(!query||task.prompt.toLowerCase().includes(query))&&(!employeeId||task.employee_id===employeeId));
  $('#overview-board-count').textContent=`${visible.length} 个任务`;
  setMarkup('#overview-board',lanes.map(lane=>{const items=visible.filter(task=>lane.statuses.includes(task.status));return html`<section class="overview-lane lane-${lane.key}"><div class="overview-lane-head"><h3>${lane.name}</h3><span>${items.length}</span></div><div class="overview-lane-cards">` + (items.length?items.map(task=>{const goal=goalFor(task);const employee=employeeFor(task);return html`<button class="overview-task" data-overview-goal="${goal?.id ?? ''}"><span class="overview-task-status">${status[task.status]??task.status}</span><strong>${task.prompt}</strong><small>${employee?.name ?? '历史员工'} · ${goal?.title ?? '任务'}</small></button>`;}).join(''):'<p class="overview-lane-empty">暂无任务</p>') + html`</div></section>`;}).join(''));
}
async function readList<T>(url:string):Promise<T[]>{
  const response=await fetch(url);
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function update(){const selected=projectId;const version=++loadVersion;
  if(selected!==goalsProjectId){goals=[];assistantActions=[];actionsLoaded=false;actionErrors=[];goalsProjectId=selected;}
  render();
  if(!selected)return;
  const query=`projectId=${encodeURIComponent(selected)}`;
  const [coordination,assistant]=await Promise.allSettled([
    readList<Goal>(`/api/coordination/sessions?${query}&summary=1`),
    readList<AssistantAction>(`/api/assistant/sessions?${query}&view=attention`),
  ]);
  if(version!==loadVersion||selected!==projectId)return;
  actionErrors=[];
  if(coordination.status==='fulfilled')goals=coordination.value;
  else actionErrors.push('协作待办');
  if(assistant.status==='fulfilled')assistantActions=assistant.value;
  else{assistantActions=[];actionErrors.push('对话待办');}
  actionsLoaded=true;
  render();
}
let active=false;
document.addEventListener('apix:snapshot',((event:CustomEvent<{data:Snapshot;projectId:string}>)=>{
  snapshot=event.detail.data;projectId=event.detail.projectId;
  if(active)void update();
}) as EventListener);
document.addEventListener('apix:page',((event:CustomEvent<string>)=>{
  active=event.detail==='overview';
  if(active)void update();
}) as EventListener);
$('#overview-project').addEventListener('change',event=>document.dispatchEvent(new CustomEvent('apix:select-project',{detail:(event.target as HTMLSelectElement).value})));
$('#overview-search').addEventListener('input',()=>renderBoard(snapshot.tasks.filter(task=>task.project_id===projectId&&task.plan_id&&goalFor(task))));
$('#overview-employee-filter').addEventListener('change',()=>renderBoard(snapshot.tasks.filter(task=>task.project_id===projectId&&task.plan_id&&goalFor(task))));
root.addEventListener('click',event=>{const target=(event.target as Element).closest<HTMLElement>('[data-overview-goal],[data-overview-assistant],[data-overview-nav]');if(!target)return;
  if(target.dataset.overviewGoal)document.dispatchEvent(new CustomEvent('apix:open-goal',{detail:target.dataset.overviewGoal}));
  if(target.dataset.overviewAssistant){
    document.querySelector<HTMLElement>('[data-page-target="assistant"]')?.click();
    document.dispatchEvent(new CustomEvent('apix:open-assistant',{detail:{id:target.dataset.overviewAssistant,delivery:target.dataset.overviewAction==='review',interactionId:target.dataset.overviewInteraction||undefined}}));
  }
  if(target.dataset.overviewNav)document.querySelector<HTMLElement>(`[data-page-target="${target.dataset.overviewNav}"]`)?.click();
});
