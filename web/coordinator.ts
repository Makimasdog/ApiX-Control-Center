type Mode = 'full_access' | 'ask_approval' | 'read_only';
type Policy = { mode: Mode; version: number };
type Step = { prompt: string; employeeId: string; dependsOn: number[] };
interface Session {
  id: string; title: string; project_id: string; revision: number; status: string; derivedStatus: string; plan_id: string | null; planVersion?: string;
  requirements: Record<string,string>; assessment: {score:number;ready:boolean;conflicts:string[]}; policy: Policy; workerPolicies: Record<string,Policy>;
  tasks: {id:string;prompt:string;employee_id:string;status:string;result?:string}[]; dependencies: {task_id:string;depends_on_id:string}[];
  turns: {role:string;kind:string;content:string}[]; agent: {mode:string;error?:string};
}
interface Snapshot { projects:{id:string;name:string}[]; employees:{id:string;name:string;runtime:string}[]; artifacts:{id:string;run_id:string;content:string}[]; runs:{id:string;task_id:string}[] }
const root = document.querySelector<HTMLElement>('#page-coordinator')!;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
let snapshot: Snapshot = {projects:[],employees:[],artifacts:[],runs:[]};
let projectId = ''; let sessionId = ''; let current: Session | null = null; let loading = false; let editingBrief = false; let planKey = ''; let draft: Step[] = []; let reloadVersion = 0;
const fields = [['goal','目标'],['scope','范围与边界'],['constraints','约束'],['deliverable','交付物'],['acceptance','验收标准']];
const statuses: Record<string,string> = {clarifying:'澄清中',ready:'待确认需求',plan_review:'待审查计划',running:'执行中',awaiting_acceptance:'待验收',completed:'已验收',attention:'需要处理',cancelled:'已取消',awaiting_approval:'待批准',queued:'等待依赖',failed:'失败',blocked:'已阻塞',accepted:'已验收',stopping:'正在停止',unknown:'状态未知',needs_revision:'需要修改'};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path,body === undefined ? undefined : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`); return data as T;
}
function notice(message: string, error = false) { $('#coord-notice').textContent=message; $('#coord-notice').classList.toggle('error',error); }
async function action(work:()=>Promise<void>) {
  if (loading) return; loading=true; root.classList.add('is-busy'); notice('ApiX 正在处理…');
  try { await work(); notice('已保存'); await reload(); } catch(e) { notice(e instanceof Error ? e.message : String(e),true); }
  finally { loading=false; root.classList.remove('is-busy'); }
}
function modeOptions(mode: Mode) { return [['ask_approval','请求批准'],['full_access','完全访问'],['read_only','只读规划']].map(([v,l])=>`<option value="${v}" ${v===mode?'selected':''}>${l}</option>`).join(''); }
root.innerHTML = `<div class="coord-header"><div><div class="eyebrow">APIX · MANAGER AGENT</div><h1>一起把目标变成行动。</h1><p>与 ApiX 澄清需求，由它安排员工、跟进进度。你可以随时调整。</p></div><select id="coord-project" aria-label="当前项目"></select></div>
<div id="coord-notice" role="status" aria-live="polite"></div>
<div class="coord-layout"><aside class="coord-rail"><h2>我的目标</h2><form id="coord-create"><label>新的目标<textarea name="goal" required maxlength="4000" placeholder="描述你希望达成的目标…"></textarea></label><button class="primary-button">交给 ApiX 梳理</button></form><div id="coord-sessions"></div>
<details class="coord-settings"><summary>ApiX 的推理模型</summary><p>ApiX 使用 Pi 推理底座；这不是员工 Pi 的配置。</p><form id="coord-model"><label>Provider<input name="provider" placeholder="使用 Pi 默认配置"></label><label>模型 ID<input name="model" placeholder="使用 Pi 默认模型"></label><button class="outline-button">保存模型</button></form></details></aside>
<section id="coord-empty" class="surface-card coord-empty"><h2>从一个目标开始</h2><p>先选择项目，再告诉 ApiX 你想完成什么。需求、计划、员工记录和交付物都会保存在这里。</p><button class="outline-button" data-page-target="projects">管理项目</button></section>
<section id="coord-body" hidden><div class="coord-title"><h2 id="coord-title"></h2><span id="coord-status" class="coord-pill"></span></div>
<div class="coord-columns"><section class="surface-card"><h3>与 ApiX 沟通</h3><div id="coord-backend" class="coord-muted"></div><div id="coord-turns" class="coord-turns" aria-live="polite"></div><form id="coord-message"><label>补充需求或询问进展<textarea name="content" required maxlength="10000" placeholder="可以一次描述范围、约束和验收要求，也可以与 ApiX 逐步讨论。"></textarea></label><button class="primary-button">发送给 ApiX</button></form></section>
<section class="surface-card"><div class="coord-title"><h3>需求摘要</h3><span id="coord-score" class="coord-pill"></span></div><div id="coord-conflicts"></div><form id="coord-brief">${fields.map(([key,label])=>`<label>${label}<textarea name="${key}" maxlength="4000" rows="2"></textarea></label>`).join('')}<button class="outline-button" type="submit">保存修改</button></form><button id="coord-confirm" class="primary-button">确认需求，让 ApiX 安排任务</button><p class="coord-muted">完整度达到 100% 且无待处理冲突后可确认。完整访问模式下，可用员工也须获得完整访问授权，ApiX 才会自动派发。</p></section></div>
<section class="surface-card coord-section"><h3>权限由你决定</h3><p class="coord-muted">ApiX 与员工分别授权。请求批准会等待你审查计划；只读规划不会启动员工。更改权限将使已有执行授权失效。</p><div id="coord-permissions"></div></section>
<section class="surface-card coord-section"><div class="coord-title"><h3>任务安排</h3><button id="coord-add-step" class="text-action">新增步骤</button></div><div id="coord-plan"></div><div class="coord-actions"><button id="coord-save-plan" class="outline-button">保存计划修改</button><button id="coord-dispatch" class="primary-button">批准此计划并执行</button></div><div id="coord-tasks"></div></section>
<section class="surface-card coord-section"><h3>中途调整</h3><form id="coord-revise"><label>需要怎样调整<textarea name="reason" required placeholder="说明新的要求，ApiX 会取消未启动任务并请求停止运行中的任务。"></textarea></label><button class="outline-button">请求调整需求</button></form></section>
<section class="surface-card coord-section"><h3>员工交付与验收</h3><div id="coord-artifacts"></div></section>
<details class="surface-card coord-section"><summary>独立记忆与历史追溯</summary><form id="coord-history"><label>事件序号<input name="at" type="number" min="0" placeholder="留空查看当前"></label><button class="outline-button">重建该时刻状态</button></form><form id="coord-search"><label>检索项目记录<input name="q" required placeholder="需求、决策、执行记录中的关键词"></label><button class="outline-button">检索</button></form><pre id="coord-history-output"></pre></details></section></div>`;
function render(s: Session) {
  current=s; $('#coord-empty').hidden=true; $('#coord-body').hidden=false;
  $('#coord-title').textContent=s.title; $('#coord-status').textContent=statuses[s.derivedStatus] ?? s.derivedStatus;
  $('#coord-score').textContent=`${Math.round(s.assessment.score*100)}% · v${s.revision}`;
  $('#coord-backend').textContent=s.agent.mode==='pi' ? 'ApiX 正在使用 Pi 推理底座' : `规则引导${s.agent.error ? ` · ${s.agent.error}` : ' · 发送消息后使用 Pi 深度澄清'}`;
  const turns=s.turns.map(t=>`<article class="coord-turn ${t.role==='user'?'from-user':''}"><strong>${t.role==='user'?'你':'ApiX'}</strong><p>${esc(t.content)}</p></article>`).join('');
  if ($('#coord-turns').innerHTML!==turns) { $('#coord-turns').innerHTML=turns; $('#coord-turns').scrollTop=$('#coord-turns').scrollHeight; }
  if (!editingBrief) for(const [key] of fields) $<HTMLTextAreaElement>(`#coord-brief [name="${key}"]`).value=s.requirements[key!] ?? '';
  const editable=['clarifying','ready'].includes(s.status);
  root.querySelectorAll<HTMLTextAreaElement>('#coord-brief textarea').forEach(t=>t.disabled=!editable);
  $<HTMLButtonElement>('#coord-brief button').disabled=!editable;
  $<HTMLButtonElement>('#coord-confirm').disabled=!editable || !s.assessment.ready;
  $('#coord-conflicts').textContent=s.assessment.conflicts.join('；');
  const actors=[{id:'apix',name:'ApiX · 管理者'},...snapshot.employees.map(e=>({id:e.id,name:`${e.name} · ${e.runtime}`}))];
  if (!$('#coord-permissions').contains(document.activeElement)) $('#coord-permissions').innerHTML=actors.map(a=>`<label class="coord-permission">${esc(a.name)}<select data-permission="${esc(a.id)}">${modeOptions((a.id==='apix'?s.policy:s.workerPolicies[a.id])?.mode ?? 'ask_approval')}</select></label>`).join('');
  const key=`${s.plan_id}:${s.planVersion}:${s.status}`;
  if (key!==planKey) { planKey=key; draft=s.tasks.map(t=>({prompt:t.prompt,employeeId:t.employee_id,dependsOn:s.dependencies.filter(d=>d.task_id===t.id).map(d=>s.tasks.findIndex(x=>x.id===d.depends_on_id))})); renderPlan(); }
  for(const id of ['coord-save-plan','coord-dispatch','coord-add-step']) $( '#'+id).hidden=s.status!=='plan_review';
  $('#coord-tasks').innerHTML=s.tasks.map((t,i)=>`<article class="coord-task"><span>${i+1}</span><div><strong>${esc(snapshot.employees.find(e=>e.id===t.employee_id)?.name ?? '历史员工')}</strong><p>${esc(t.prompt)}</p></div><span class="coord-pill">${esc(t.status==='completed'?'待验收':statuses[t.status] ?? t.status)}</span>${t.status==='completed'?`<button class="text-action" data-coord-accept="${t.id}">通过验收</button><button class="text-action" data-coord-reject="${t.id}">要求修改</button>`:''}</article>`).join('');
  $('#coord-revise').hidden=['clarifying','ready'].includes(s.status);
  const runIds=snapshot.runs.filter(r=>s.tasks.some(t=>t.id===r.task_id)).map(r=>r.id);
  $('#coord-artifacts').innerHTML=snapshot.artifacts.filter(a=>runIds.includes(a.run_id)).map(a=>`<details><summary>员工交付物 · ${esc(a.id.slice(0,8))}</summary><pre>${esc(a.content)}</pre></details>`).join('') || '<p class="coord-muted">员工的实际交付物会显示在这里。</p>';
}
function renderPlan() {
  $('#coord-plan').innerHTML=current?.status==='plan_review' ? draft.map((s,i)=>`<div class="coord-plan-step" data-step="${i}"><strong>步骤 ${i+1}</strong><label>任务<textarea data-prompt>${esc(s.prompt)}</textarea></label><label>员工<select data-employee>${snapshot.employees.map(e=>`<option value="${e.id}" ${s.employeeId===e.id?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label><label>等待步骤（逗号分隔的编号）<input data-deps value="${s.dependsOn.map(n=>n+1).join(',')}"></label><button data-remove="${i}" class="text-action">删除步骤</button></div>`).join('') : '';
}
function readDraft(): Step[] { return [...root.querySelectorAll<HTMLElement>('[data-step]')].map(el=>({prompt:el.querySelector<HTMLTextAreaElement>('[data-prompt]')!.value,employeeId:el.querySelector<HTMLSelectElement>('[data-employee]')!.value,dependsOn:el.querySelector<HTMLInputElement>('[data-deps]')!.value.split(',').filter(v=>v.trim()).map(v=>Number(v.trim())-1)})); }
async function reload() {
  const version = ++reloadVersion; const selectedProject = projectId;
  if(!projectId) { $('#coord-body').hidden=true; $('#coord-empty').hidden=false; return; }
  const list=await api<Session[]>(`/api/coordination/sessions?projectId=${encodeURIComponent(projectId)}`);
  if(version!==reloadVersion || selectedProject!==projectId) return;
  if(!list.some(s=>s.id===sessionId)) sessionId=list[0]?.id ?? '';
  $('#coord-sessions').innerHTML=list.map(s=>`<button class="coord-session ${s.id===sessionId?'selected':''}" data-session="${s.id}"><strong>${esc(s.title)}</strong><span>${esc(statuses[s.derivedStatus] ?? s.derivedStatus)}</span></button>`).join('');
  const selected=list.find(s=>s.id===sessionId); if(selected) render(selected); else {current=null;$('#coord-body').hidden=true;$('#coord-empty').hidden=false;}
}
document.addEventListener('apix:snapshot', ((event: CustomEvent<{data:Snapshot;projectId:string}>)=>{
  snapshot=event.detail.data;
  if(projectId!==event.detail.projectId) {projectId=event.detail.projectId;sessionId='';editingBrief=false;planKey='';}
  const select=$<HTMLSelectElement>('#coord-project'); select.innerHTML=snapshot.projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');select.value=projectId;
  if(!loading) void reload().catch(e=>notice(String(e),true));
}) as EventListener);
$('#coord-project').addEventListener('change',()=>document.dispatchEvent(new CustomEvent('apix:select-project',{detail:$<HTMLSelectElement>('#coord-project').value})));
$('#coord-create').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{if(!projectId)throw new Error('请先添加或选择项目');const form=event.target as HTMLFormElement;const created=await api<Session>('/api/coordination/sessions',{projectId,goal:new FormData(form).get('goal')});sessionId=created.id;editingBrief=false;form.reset();});});
$('#coord-message').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const form=event.target as HTMLFormElement;await api(`/api/coordination/sessions/${sessionId}/messages`,{revision:current!.revision,content:new FormData(form).get('content')});editingBrief=false;form.reset();});});
$('#coord-brief').addEventListener('input',()=>editingBrief=true);
$('#coord-brief').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const values=new FormData(event.target as HTMLFormElement);for(const [field] of fields){const value=String(values.get(field!) ?? '');if(value!==current!.requirements[field!])current=await api<Session>(`/api/coordination/sessions/${sessionId}/answers`,{revision:current!.revision,field,value});}editingBrief=false;});});
$('#coord-confirm').addEventListener('click',()=>void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/confirm`,{revision:current!.revision});}));
$('#coord-dispatch').addEventListener('click',()=>void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/dispatch`,{planVersion:current!.planVersion});}));
$('#coord-save-plan').addEventListener('click',()=>void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/plan`,{revision:current!.revision,planVersion:current!.planVersion,steps:readDraft()});planKey='';}));
$('#coord-add-step').addEventListener('click',()=>{draft=readDraft();draft.push({prompt:'',employeeId:snapshot.employees[0]?.id ?? '',dependsOn:[]});renderPlan();});
$('#coord-revise').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/revise`,{revision:current!.revision,reason:new FormData(event.target as HTMLFormElement).get('reason')});editingBrief=false;planKey='';});});
$('#coord-permissions').addEventListener('change',event=>{const select=event.target as HTMLSelectElement;const subject=select.dataset.permission!;void action(async()=>{const policy=subject==='apix'?current!.policy:current!.workerPolicies[subject] ?? {version:0};await api('/api/permissions',{projectId,subject,mode:select.value,version:policy.version});});});
root.addEventListener('click',event=>{const el=(event.target as Element).closest<HTMLElement>('[data-session],[data-remove],[data-coord-accept],[data-coord-reject]');if(!el)return;
  if(el.dataset.session && !loading){sessionId=el.dataset.session;editingBrief=false;planKey='';void reload().catch(e=>notice(String(e),true));}
  if(el.dataset.remove!==undefined){draft=readDraft();const n=Number(el.dataset.remove);draft.splice(n,1);draft=draft.map(s=>({...s,dependsOn:s.dependsOn.filter(d=>d!==n).map(d=>d>n?d-1:d)}));renderPlan();}
  if(el.dataset.coordAccept || el.dataset.coordReject)void action(async()=>{await api(`/api/tasks/${el.dataset.coordAccept ?? el.dataset.coordReject}/review`,{accepted:!!el.dataset.coordAccept});});
});
$('#coord-history').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const at=new FormData(event.target as HTMLFormElement).get('at');$('#coord-history-output').textContent=JSON.stringify(await api(`/api/coordination/sessions/${sessionId}/timeline${at?`?at=${at}`:''}`),null,2);});});
$('#coord-search').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const q=new FormData(event.target as HTMLFormElement).get('q');$('#coord-history-output').textContent=JSON.stringify(await api(`/api/coordination/memory?projectId=${projectId}&q=${encodeURIComponent(String(q))}`),null,2);});});
$('#coord-model').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{await api('/api/manager/settings',Object.fromEntries(new FormData(event.target as HTMLFormElement)));});});
void api<{provider:string;model:string}>('/api/manager/settings').then(s=>{ $<HTMLInputElement>('#coord-model [name="provider"]').value=s.provider;$<HTMLInputElement>('#coord-model [name="model"]').value=s.model;}).catch(e=>notice(String(e),true));

document.querySelector('#page-missions')!.insertAdjacentHTML('beforeend', `<section class="surface-card coord-section"><h3>接入自定义 CLI</h3><p class="coord-muted">适用于提供非交互 CLI 的 Agent。通过标准输入接收任务，通过标准输出返回结果；注册后可在运行时列表中添加员工。</p><form id="adapter-form" class="stacked-form"><label>适配器 ID<input name="id" required placeholder="qoder-cli"></label><label>名称<input name="name" required placeholder="Qoder CLI"></label><label>可执行文件绝对路径<input name="executable" required placeholder="C:\\Program Files\\nodejs\\node.exe"></label><label>启动参数（JSON 字符串数组）<input name="args" required value="[]"></label><label>输出格式<select name="format"><option value="plain">纯文本</option><option value="jsonl">JSONL 事件</option></select></label><button class="outline-button">注册适配器</button><p id="adapter-notice" role="status"></p></form></section>`);
document.querySelector('#adapter-form')!.addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.target as HTMLFormElement; const output=document.querySelector('#adapter-notice')!;
  try {const values=Object.fromEntries(new FormData(form)); await api('/api/adapters',{...values,args:JSON.parse(String(values.args))}); output.textContent='适配器已注册，可以在运行时列表注册员工。';}catch(e){output.textContent=String(e instanceof Error ? e.message : e);}
});
document.addEventListener('apix:manager-settings',()=>{ const panel=$<HTMLDetailsElement>('.coord-settings'); panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'center'});$<HTMLInputElement>('#coord-model [name="provider"]').focus(); });
