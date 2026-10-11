import { readConversation } from './conversation-stream.js';
import { saveBrief } from './requirements-form.js';
import { selectProvider, settingsDraft, settingsPayload, localLookupRequest, mergeLocalModels, type ModelDraft, type ModelSettings, type ProviderConfig } from './model-settings.js';
type Mode = 'full_access' | 'ask_approval' | 'read_only';
type InteractionMode = 'structured' | 'conversational';
type Policy = { mode: Mode; version: number };
type Step = { prompt: string; employeeId: string; dependsOn: number[] };
interface Session {
  id: string; title: string; project_id: string; revision: number; status: string; derivedStatus: string; plan_id: string | null; planVersion?: string; interaction_mode: InteractionMode; busy?: boolean;
  requirements: Record<string,string>; assessment: {score:number;ready:boolean;conflicts:string[]}; policy: Policy; workerPolicies: Record<string,Policy>;
  tasks: {id:string;prompt:string;employee_id:string;status:string;result?:string}[]; dependencies: {task_id:string;depends_on_id:string}[];
  turns: {role:string;kind:string;content:string}[]; agent: {mode:string;error?:string};
}
interface Snapshot { projects:{id:string;name:string}[]; employees:{id:string;name:string;runtime:string}[]; artifacts:{id:string;run_id:string;content:string}[]; runs:{id:string;task_id:string}[] }
const root = document.querySelector<HTMLElement>('#page-coordinator')!;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
let snapshot: Snapshot = {projects:[],employees:[],artifacts:[],runs:[]};
let projectId = ''; let sessionId = ''; let current: Session | null = null; let loading = false; let reloading = false; let editingBrief = false; let planKey = ''; let draft: Step[] = []; let reloadVersion = 0;
let streaming = false; let isComposing = false;
const messageDrafts = new Map<string,string>();
const failedReplies = new Map<string,{text:string;error:string}>();
const unsynced = new Set<string>();
const fields = [['goal','目标'],['scope','范围与边界'],['constraints','约束'],['deliverable','交付物'],['acceptance','验收标准']];
const statuses: Record<string,string> = {clarifying:'澄清中',ready:'待确认需求',plan_review:'待审查计划',running:'执行中',awaiting_acceptance:'待验收',completed:'已验收',attention:'需要处理',cancelled:'已取消',awaiting_approval:'待批准',queued:'等待依赖',failed:'失败',blocked:'已阻塞',accepted:'已验收',stopping:'正在停止',unknown:'状态未知',needs_revision:'需要修改'};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path,body === undefined ? undefined : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`); return data as T;
}
function notice(message: string, error = false) { $('#coord-notice').textContent=message; $('#coord-notice').classList.toggle('error',error); }
async function action(work:()=>Promise<void>) {
  if (loading) return; loading=true; root.classList.add('is-busy'); updateStreamingControls();
  const originProject=projectId; const originSession=sessionId;
  notice('ApiX 正在处理…');
  try { await work(); if(projectId===originProject && sessionId===originSession)notice('已保存'); await reload(); }
  catch(e) { if(projectId===originProject && sessionId===originSession)notice(e instanceof Error ? e.message : String(e),true); }
  finally { loading=false; root.classList.remove('is-busy'); if(projectId!==originProject || sessionId!==originSession)notice('');updateStreamingControls(); }
}
function modeOptions(mode: Mode) { return [['ask_approval','请求批准'],['full_access','完全访问'],['read_only','只读规划']].map(([v,l])=>`<option value="${v}" ${v===mode?'selected':''}>${l}</option>`).join(''); }
function interactionOptions(mode: InteractionMode) { return [['conversational','对话模式'],['structured','约束模式']].map(([v,l])=>`<option value="${v}" ${v===mode?'selected':''}>${l}</option>`).join(''); }
function updateStreamingControls() {
  const disabled=streaming || loading || !current || current.id!==sessionId || !!current.busy || unsynced.has(sessionId);
  $<HTMLTextAreaElement>('#coord-message textarea').disabled=disabled;
  $<HTMLButtonElement>('#coord-message button').disabled=disabled;
}
function selectSession(id:string) {
  const input=$<HTMLTextAreaElement>('#coord-message textarea');
  if(sessionId)messageDrafts.set(sessionId,input.value);
  sessionId=id;current=null;reloadVersion++;editingBrief=false;planKey='';
  input.value=messageDrafts.get(id) ?? '';
  $('#coord-turns').querySelectorAll('.coord-turn:not(#coord-stream)').forEach(node=>node.remove());
  $('#coord-turns').dataset.session='';$('#coord-turns').dataset.rendered='';
  $('#coord-body').hidden=true;updateStreamingControls();
}
async function streamMessage(id:string,body:unknown,userContent:string) {
  if(streaming || current?.busy || unsynced.has(id))throw new Error('正在生成或同步回复，请稍后再试');
  const originProject=projectId;
  const ownsView=()=>sessionId===id && projectId===originProject;
  streaming=true;failedReplies.delete(id);updateStreamingControls();
  const history=$('#coord-turns');
  const nearBottom=()=>history.scrollHeight-history.scrollTop-history.clientHeight<100;
  history.querySelectorAll('[data-failed-reply]').forEach(node=>node.remove());
  const userTurn=document.createElement('article');userTurn.className='coord-turn from-user';userTurn.dataset.tempId='user';
  userTurn.innerHTML='<strong>你</strong><p>'+esc(userContent)+'</p>';
  const apixTurn=document.createElement('article');apixTurn.className='coord-turn coord-stream';apixTurn.dataset.tempId='apix';
  apixTurn.innerHTML='<strong>ApiX</strong><p class="stream-text">正在思考…</p>';
  const follow=nearBottom();$('#coord-stream').before(userTurn,apixTurn);if(follow)history.scrollTop=history.scrollHeight;
  const streamText=apixTurn.querySelector<HTMLElement>('.stream-text')!;
  let partial='';let finalSession:Session|null=null;
  try {
    const response=await fetch('/api/coordination/sessions/'+encodeURIComponent(id)+'/messages/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    await readConversation<Session>(response,id,{
      delta(text){partial+=text;if(ownsView()){const follow=nearBottom();streamText.textContent=partial;if(follow)history.scrollTop=history.scrollHeight;}},
      complete(session){finalSession=session;},
    });
    userTurn.remove();apixTurn.remove();
    messageDrafts.delete(id);
    if(ownsView()){
      $<HTMLTextAreaElement>('#coord-message textarea').value='';
      if(finalSession)render(finalSession);
    }
  } catch(error) {
    const detail=error instanceof Error?error.message:String(error);
    failedReplies.set(id,{text:partial,error:detail});unsynced.add(id);
    userTurn.remove();apixTurn.remove();
    try {
      const session=await api<Session>('/api/coordination/sessions/'+encodeURIComponent(id));
      unsynced.delete(id);if(ownsView())render(session);
    } catch { if(ownsView()){renderFailedReply(id);notice('同步目标失败，请等待恢复或刷新；请勿重复发送',true);} }
    throw error;
  } finally {
    streaming=false;updateStreamingControls();
    if(ownsView() && current)render(current);
  }
}
function renderFailedReply(id:string) {
  const history=$('#coord-turns');history.querySelectorAll('[data-failed-reply]').forEach(node=>node.remove());
  const failed=failedReplies.get(id);if(!failed)return;
  const article=document.createElement('article');article.className='coord-turn coord-turn-error';article.dataset.failedReply=id;
  article.innerHTML='<strong>ApiX</strong><p>'+esc(failed.text || '尚未收到回复')+'</p><div class="stream-error-note">'+esc('[生成中断] '+failed.error)+'</div>';
  $('#coord-stream').before(article);
}
root.innerHTML = `<div class="coord-header"><div><div class="eyebrow">APIX · MANAGER AGENT</div><h1>一起把目标变成行动。</h1><p>与 ApiX 澄清需求，由它安排员工、跟进进度。你可以随时调整。</p></div><select id="coord-project" aria-label="当前项目"></select></div>
<div id="coord-notice" role="status" aria-live="polite"></div>
<div class="coord-layout"><aside class="coord-rail"><h2>我的目标</h2><form id="coord-create"><label>新的目标<textarea name="goal" required maxlength="4000" placeholder="描述你希望达成的目标…"></textarea></label><label>交互方式<select name="interactionMode">${interactionOptions('conversational')}</select></label><button class="primary-button">交给 ApiX 梳理</button></form><div id="coord-sessions"></div>
<details class="coord-settings"><summary>ApiX 的推理模型</summary><p>ApiX 使用 Pi 推理底座；这不是员工 Pi 的配置。支持 DeepSeek、阿里云百炼、火山引擎豆包等平台。</p><form id="coord-model"><label>模型平台<select name="provider" id="model-provider-select"><option value="">使用 Pi 默认配置</option><option value="custom">自定义 URL</option></select></label><div id="model-preset-config" hidden><label>选择模型<select name="model" id="model-select"><option value="">请先选择平台</option></select></label><label>或自定义模型名称 <span class="field-optional">(可选)</span><input name="customModelName" id="custom-model-name-input" placeholder="留空使用上方选中的模型"><small class="field-hint">用于该平台的其他模型，如新版本或特殊模型</small></label><label id="api-key-label">API Key 环境变量<input name="apiKeyEnv" id="api-key-input" placeholder="例如 DEEPSEEK_API_KEY"><small class="field-hint" id="api-key-hint"></small></label></div><div id="model-custom-config" hidden><label>自定义 API URL<input name="baseUrl" type="url" placeholder="http://127.0.0.1:11434/v1"></label><label>模型 ID<input name="customModel" placeholder="例如 qwen-max"></label><label>API 类型<select name="apiType"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label>API Key 环境变量<input name="customApiKeyEnv" placeholder="例如 CUSTOM_API_KEY"></label></div><button class="outline-button">保存模型配置</button></form></details></aside>
<section id="coord-empty" class="surface-card coord-empty"><h2>从一个目标开始</h2><p>先选择项目，再告诉 ApiX 你想完成什么。需求、计划、员工记录和交付物都会保存在这里。</p><button class="outline-button" data-page-target="projects">管理项目</button></section>
<section id="coord-body" hidden><div class="coord-title coord-goal-head"><h2 id="coord-title"></h2><div class="coord-head-controls"><span id="coord-status" class="coord-pill"></span><label class="coord-mode">交互方式<select id="coord-interaction-mode">${interactionOptions('conversational')}</select></label></div></div>
<div class="coord-columns"><section id="coord-conversation" class="surface-card"><div class="coord-title"><h3 id="coord-chat-title">与 ApiX 对话</h3></div><div id="coord-backend" class="coord-muted"></div><div id="coord-turns" class="coord-turns" aria-live="polite"><article id="coord-stream" class="coord-turn coord-stream" hidden><strong>ApiX</strong><p id="coord-stream-text"></p></article></div><button id="coord-scroll-bottom" aria-label="回到底部" title="回到底部">↓</button><form id="coord-message" class="coord-composer"><label><span id="coord-message-label">给 ApiX 发消息</span><textarea name="content" rows="3" required maxlength="10000" placeholder="告诉 ApiX 你的想法或补充需求…"></textarea></label><button class="primary-button" type="submit">发送给 ApiX</button></form></section>
<section id="coord-requirements" class="surface-card"><div class="coord-title"><h3>需求摘要</h3><span id="coord-score" class="coord-pill"></span></div><div id="coord-conflicts"></div><form id="coord-brief">${fields.map(([key,label])=>`<label>${label}<textarea name="${key}" maxlength="4000" rows="2"></textarea></label>`).join('')}<button class="outline-button" type="submit">保存修改</button></form><button id="coord-confirm" class="primary-button">确认需求，让 ApiX 安排任务</button><p class="coord-muted">完整度达到 100% 且无待处理冲突后可确认。完整访问模式下，可用员工也须获得完整访问授权，ApiX 才会自动派发。</p></section></div>
<section class="surface-card coord-section"><h3>权限由你决定</h3><p class="coord-muted">ApiX 与员工分别授权。请求批准会等待你审查计划；只读规划不会启动员工。更改权限将使已有执行授权失效。</p><div id="coord-permissions"></div></section>
<section class="surface-card coord-section"><div class="coord-title"><h3>任务安排</h3><button id="coord-add-step" class="text-action">新增步骤</button></div><div id="coord-plan"></div><div class="coord-actions"><button id="coord-save-plan" class="outline-button">保存计划修改</button><button id="coord-dispatch" class="primary-button">批准此计划并执行</button></div><div id="coord-tasks"></div></section>
<section id="coord-guidance-section" class="surface-card coord-section"><h3>指导正在执行的员工</h3><p class="coord-muted">ApiX 会依据员工的进度报告继续指导。你也可以补充当前任务范围内的说明；员工需在运行中读取 mailbox 才能收到。</p><form id="coord-instruction"><label>员工任务<select name="taskId"></select></label><label>补充说明<textarea name="content" required maxlength="2000" placeholder="例如：请优先核对已确认的验收标准。"></textarea></label><button class="outline-button">发送给员工</button></form></section>
<section class="surface-card coord-section"><h3>中途调整</h3><form id="coord-revise"><label>需要怎样调整<textarea name="reason" required placeholder="说明新的要求，ApiX 会取消未启动任务并请求停止运行中的任务。"></textarea></label><button class="outline-button">请求调整需求</button></form></section>
<section class="surface-card coord-section"><h3>员工交付与验收</h3><div id="coord-artifacts"></div></section>
<details class="surface-card coord-section"><summary>独立记忆与历史追溯</summary><form id="coord-history"><label>事件序号<input name="at" type="number" min="0" placeholder="留空查看当前"></label><button class="outline-button">重建该时刻状态</button></form><form id="coord-search"><label>检索项目记录<input name="q" required placeholder="需求、决策、执行记录中的关键词"></label><button class="outline-button">检索</button></form><pre id="coord-history-output"></pre></details></section></div>`;
function render(s: Session) {
  current=s; $('#coord-empty').hidden=true; $('#coord-body').hidden=false;
  root.dataset.interactionMode=s.interaction_mode;
  $('#coord-title').textContent=s.title; $('#coord-status').textContent=statuses[s.derivedStatus] ?? s.derivedStatus;
  $('#coord-chat-title').textContent=s.interaction_mode==='conversational'?'与 ApiX 对话':'需求澄清记录';
  $('#coord-message-label').textContent=s.interaction_mode==='conversational'?'给 ApiX 发消息':'补充需求或询问进展';
  $<HTMLSelectElement>('#coord-interaction-mode').value=s.interaction_mode;
  $<HTMLSelectElement>('#coord-interaction-mode').disabled=!['clarifying','ready'].includes(s.status);
  $('#coord-score').textContent=`${Math.round(s.assessment.score*100)}% · v${s.revision}`;
  $('#coord-backend').textContent=s.agent.mode==='pi' ? 'ApiX 正在使用 Pi 推理底座' : `规则引导${s.agent.error ? ` · ${s.agent.error}` : ' · 发送消息后使用 Pi 深度澄清'}`;
  const turns=s.turns.map(t=>`<article class="coord-turn ${t.role==='user'?'from-user':''}"><strong>${t.role==='user'?'你':'ApiX'}</strong><p>${esc(t.content)}</p></article>`).join('');
  const history=$('#coord-turns');

  if (!streaming || history.dataset.session!==s.id || !history.querySelector('[data-temp-id]')) {
    if(history.dataset.session!==s.id || history.dataset.rendered!==turns) {
      const follow=history.dataset.session!==s.id || history.scrollHeight-history.scrollTop-history.clientHeight<100;
      history.dataset.session=s.id;history.dataset.rendered=turns;
      history.querySelectorAll('.coord-turn:not(#coord-stream)').forEach(node=>node.remove());
      $('#coord-stream').insertAdjacentHTML('beforebegin',turns);
      if(follow)history.scrollTop=history.scrollHeight;
    }
    renderFailedReply(s.id);
  }

  if (!editingBrief) for(const [key] of fields) $<HTMLTextAreaElement>(`#coord-brief [name="${key}"]`).value=s.requirements[key!] ?? '';
  const editable=['clarifying','ready'].includes(s.status);
  root.querySelectorAll<HTMLTextAreaElement>('#coord-brief textarea').forEach(t=>t.disabled=!editable);
  $<HTMLButtonElement>('#coord-brief button').disabled=!editable;
  $<HTMLButtonElement>('#coord-confirm').disabled=!editable || !s.assessment.ready;

  updateStreamingControls();

  $('#coord-conflicts').textContent=s.assessment.conflicts.join('；');
  const actors=[{id:'apix',name:'ApiX · 管理者'},...snapshot.employees.map(e=>({id:e.id,name:`${e.name} · ${e.runtime}`}))];
  if (!$('#coord-permissions').contains(document.activeElement)) $('#coord-permissions').innerHTML=actors.map(a=>`<label class="coord-permission">${esc(a.name)}<select data-permission="${esc(a.id)}">${modeOptions((a.id==='apix'?s.policy:s.workerPolicies[a.id])?.mode ?? 'ask_approval')}</select></label>`).join('');
  const key=`${s.plan_id}:${s.planVersion}:${s.status}`;
  if (key!==planKey) { planKey=key; draft=s.tasks.map(t=>({prompt:t.prompt,employeeId:t.employee_id,dependsOn:s.dependencies.filter(d=>d.task_id===t.id).map(d=>s.tasks.findIndex(x=>x.id===d.depends_on_id))})); renderPlan(); }
  for(const id of ['coord-save-plan','coord-dispatch','coord-add-step']) $( '#'+id).hidden=s.status!=='plan_review';
  $('#coord-tasks').innerHTML=s.tasks.map((t,i)=>`<article class="coord-task"><span>${i+1}</span><div><strong>${esc(snapshot.employees.find(e=>e.id===t.employee_id)?.name ?? '历史员工')}</strong><p>${esc(t.prompt)}</p></div><span class="coord-pill">${esc(t.status==='completed'?'待验收':statuses[t.status] ?? t.status)}</span>${t.status==='completed'?`<button class="text-action" data-coord-accept="${t.id}">通过验收</button><button class="text-action" data-coord-reject="${t.id}">要求修改</button>`:''}</article>`).join('');
  const active=s.tasks.filter(t=>t.status==='running');
  $('#coord-guidance-section').hidden=!active.length;
  const taskSelect=$<HTMLSelectElement>('#coord-instruction [name="taskId"]');
  const previousTask=taskSelect.value;
  taskSelect.innerHTML=active.map(t=>`<option value="${esc(t.id)}">${esc(snapshot.employees.find(e=>e.id===t.employee_id)?.name ?? t.employee_id)} · ${esc(t.prompt.slice(0,60))}</option>`).join('');
  if(active.some(t=>t.id===previousTask)) taskSelect.value=previousTask;
  $('#coord-revise').hidden=['clarifying','ready'].includes(s.status);
  const runIds=snapshot.runs.filter(r=>s.tasks.some(t=>t.id===r.task_id)).map(r=>r.id);
  $('#coord-artifacts').innerHTML=snapshot.artifacts.filter(a=>runIds.includes(a.run_id)).map(a=>`<details><summary>员工交付物 · ${esc(a.id.slice(0,8))}</summary><pre>${esc(a.content)}</pre></details>`).join('') || '<p class="coord-muted">员工的实际交付物会显示在这里。</p>';
}
function renderPlan() {
  $('#coord-plan').innerHTML=current?.status==='plan_review' ? draft.map((s,i)=>`<div class="coord-plan-step" data-step="${i}"><strong>步骤 ${i+1}</strong><label>任务<textarea data-prompt>${esc(s.prompt)}</textarea></label><label>员工<select data-employee>${snapshot.employees.map(e=>`<option value="${e.id}" ${s.employeeId===e.id?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label><label>等待步骤（逗号分隔的编号）<input data-deps value="${s.dependsOn.map(n=>n+1).join(',')}"></label><button data-remove="${i}" class="text-action">删除步骤</button></div>`).join('') : '';
}
function readDraft(): Step[] { return [...root.querySelectorAll<HTMLElement>('[data-step]')].map(el=>({prompt:el.querySelector<HTMLTextAreaElement>('[data-prompt]')!.value,employeeId:el.querySelector<HTMLSelectElement>('[data-employee]')!.value,dependsOn:el.querySelector<HTMLInputElement>('[data-deps]')!.value.split(',').filter(v=>v.trim()).map(v=>Number(v.trim())-1)})); }
async function reload() {
  const version = ++reloadVersion; const selectedProject = projectId; reloading=true;
  try {
    if(!projectId) { $('#coord-body').hidden=true; $('#coord-empty').hidden=false; return; }
    const list=await api<Session[]>(`/api/coordination/sessions?projectId=${encodeURIComponent(projectId)}`);
    if(version!==reloadVersion || selectedProject!==projectId) return;
    if(!list.some(s=>s.id===sessionId)) selectSession(list[0]?.id ?? '');
    $('#coord-sessions').innerHTML=list.map(s=>`<button class="coord-session ${s.id===sessionId?'selected':''}" data-session="${s.id}"><strong>${esc(s.title)}</strong><span>${esc(statuses[s.derivedStatus] ?? s.derivedStatus)}</span></button>`).join('');
    const selected=list.find(s=>s.id===sessionId); if(selected) {unsynced.delete(selected.id);render(selected);} else {current=null;$('#coord-body').hidden=true;$('#coord-empty').hidden=false;}
  } finally {if(version===reloadVersion)reloading=false;}
}
document.addEventListener('apix:snapshot', ((event: CustomEvent<{data:Snapshot;projectId:string}>)=>{
  snapshot=event.detail.data;
  const changed=projectId!==event.detail.projectId;
  if(changed) {selectSession('');projectId=event.detail.projectId;}
  const select=$<HTMLSelectElement>('#coord-project'); select.innerHTML=snapshot.projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');select.value=projectId;
  if(root.classList.contains('active-page') && (changed || (!loading && !reloading))) void reload().catch(e=>notice(String(e),true));
}) as EventListener);
document.addEventListener('apix:page',((event:CustomEvent<string>)=>{if(event.detail==='coordinator' && !loading && !reloading)void reload().catch(e=>notice(String(e),true));}) as EventListener);
document.addEventListener('apix:open-goal',((event:CustomEvent<string>)=>{selectSession(event.detail);void reload().catch(e=>notice(String(e),true));document.querySelector<HTMLElement>('[data-page-target="coordinator"]')?.click();}) as EventListener);
$('#coord-project').addEventListener('change',()=>document.dispatchEvent(new CustomEvent('apix:select-project',{detail:$<HTMLSelectElement>('#coord-project').value})));
$('#coord-create').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{if(!projectId)throw new Error('请先添加或选择项目');const form=event.target as HTMLFormElement;const values=new FormData(form);const created=await api<Session>('/api/coordination/sessions',{projectId,goal:values.get('goal'),interactionMode:values.get('interactionMode')});selectSession(created.id);form.reset();});});
$('#coord-message').addEventListener('submit',event=>{event.preventDefault();if(!current || $<HTMLButtonElement>('#coord-message button').disabled)return;void action(async()=>{const content=$<HTMLTextAreaElement>('#coord-message textarea').value.trim();if(!content)return;const id=sessionId;messageDrafts.set(id,content);await streamMessage(id,{revision:current!.revision,content},content);});});
// 支持 Enter 发送、Shift+Enter 换行、处理中文输入法
const messageTextarea=$<HTMLTextAreaElement>('#coord-message textarea');
messageTextarea.addEventListener('input',()=>messageDrafts.set(sessionId,messageTextarea.value));
messageTextarea.addEventListener('compositionstart',()=>isComposing=true);
messageTextarea.addEventListener('compositionend',()=>isComposing=false);
messageTextarea.addEventListener('keydown',event=>{
  if(event.key==='Enter' && !event.shiftKey && !isComposing && !event.isComposing){
    event.preventDefault();
    if(!streaming && messageTextarea.value.trim()) {
      $<HTMLFormElement>('#coord-message').requestSubmit();
    }
  }
});

// 滚动监听和回到底部功能
const turnsContainer=$<HTMLElement>('#coord-turns');
const scrollBottomBtn=$<HTMLButtonElement>('#coord-scroll-bottom');
turnsContainer.addEventListener('scroll',()=>{
  const isNearBottom=turnsContainer.scrollHeight - turnsContainer.scrollTop - turnsContainer.clientHeight < 100;
  scrollBottomBtn.classList.toggle('visible',!isNearBottom && turnsContainer.scrollHeight > turnsContainer.clientHeight + 200);
});
scrollBottomBtn.addEventListener('click',()=>{
  turnsContainer.scrollTo({top:turnsContainer.scrollHeight,behavior:'smooth'});
});
$('#coord-interaction-mode').addEventListener('change',event=>{const mode=(event.target as HTMLSelectElement).value;void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/mode`,{revision:current!.revision,mode});}).then(()=>{if(mode==='conversational')$<HTMLTextAreaElement>('#coord-message textarea').focus();});});
$('#coord-brief').addEventListener('input',()=>editingBrief=true);
$('#coord-brief').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
  const original=current!;const originProject=projectId;const values=new FormData(event.target as HTMLFormElement);
  const entries: [string,string][]=fields.map(([field])=>[field!,String(values.get(field!) ?? '')]);
  const updated=await saveBrief(original,entries,(id,revision,field,value)=>api<Session>(`/api/coordination/sessions/${id}/answers`,{revision,field,value}));
  if(sessionId===original.id && projectId===originProject){current=updated;editingBrief=false;}
});});
$('#coord-confirm').addEventListener('click',()=>void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/confirm`,{revision:current!.revision});}));
$('#coord-dispatch').addEventListener('click',()=>void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/dispatch`,{planVersion:current!.planVersion});}));
$('#coord-save-plan').addEventListener('click',()=>void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/plan`,{revision:current!.revision,planVersion:current!.planVersion,steps:readDraft()});planKey='';}));
$('#coord-add-step').addEventListener('click',()=>{draft=readDraft();draft.push({prompt:'',employeeId:snapshot.employees[0]?.id ?? '',dependsOn:[]});renderPlan();});
$('#coord-revise').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/revise`,{revision:current!.revision,reason:new FormData(event.target as HTMLFormElement).get('reason')});editingBrief=false;planKey='';});});
$('#coord-instruction').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const form=event.target as HTMLFormElement;await api(`/api/coordination/sessions/${sessionId}/instructions`,{revision:current!.revision,...Object.fromEntries(new FormData(form))});form.querySelector<HTMLTextAreaElement>('textarea')!.value='';});});
$('#coord-permissions').addEventListener('change',event=>{const select=event.target as HTMLSelectElement;const subject=select.dataset.permission!;void action(async()=>{const policy=subject==='apix'?current!.policy:current!.workerPolicies[subject] ?? {version:0};await api('/api/permissions',{projectId,subject,mode:select.value,version:policy.version});});});
root.addEventListener('click',event=>{const el=(event.target as Element).closest<HTMLElement>('[data-session],[data-remove],[data-coord-accept],[data-coord-reject]');if(!el)return;
  if(el.dataset.session){selectSession(el.dataset.session);void reload().catch(e=>notice(String(e),true));}
  if(el.dataset.remove!==undefined){draft=readDraft();const n=Number(el.dataset.remove);draft.splice(n,1);draft=draft.map(s=>({...s,dependsOn:s.dependsOn.filter(d=>d!==n).map(d=>d>n?d-1:d)}));renderPlan();}
  if(el.dataset.coordAccept || el.dataset.coordReject)void action(async()=>{await api(`/api/tasks/${el.dataset.coordAccept ?? el.dataset.coordReject}/review`,{accepted:!!el.dataset.coordAccept});});
});
$('#coord-history').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const at=new FormData(event.target as HTMLFormElement).get('at');$('#coord-history-output').textContent=JSON.stringify(await api(`/api/coordination/sessions/${sessionId}/timeline${at?`?at=${at}`:''}`),null,2);});});
$('#coord-search').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const q=new FormData(event.target as HTMLFormElement).get('q');$('#coord-history-output').textContent=JSON.stringify(await api(`/api/coordination/memory?projectId=${projectId}&q=${encodeURIComponent(String(q))}`),null,2);});});

// Model form uses the same state/payload functions as its regression tests.
const modelForm=$<HTMLFormElement>('#coord-model');
modelForm.insertAdjacentHTML('beforeend','<button type="button" id="model-discover" class="outline-button" hidden>读取本地模型</button><p id="model-discovery-status" class="coord-muted" role="status"></p><datalist id="local-model-options"></datalist>');
for(const name of ['customModel','customModelName'])(modelForm.elements.namedItem(name) as HTMLInputElement).setAttribute('list','local-model-options');
const providerSelect=$<HTMLSelectElement>('#model-provider-select');
const modelSelect=$<HTMLSelectElement>('#model-select');
let providers:ProviderConfig[]=[];let savedSettings:ModelSettings|null=null;let modelReady=false;
let lookupVersion=0;let lookupSignature='';let lookupPending=false;
function modelDraft(){return Object.fromEntries(new FormData(modelForm)) as ModelDraft;}
function updateLocalLookup() {
  const request=modelReady?localLookupRequest(modelDraft(),providers):null;
  const signature=JSON.stringify([providerSelect.value,request]);
  if(signature!==lookupSignature){lookupSignature=signature;lookupVersion++;lookupPending=false;$('#model-discovery-status').textContent='';$('#local-model-options').innerHTML='';}
  const button=$<HTMLButtonElement>('#model-discover');button.hidden=!request;button.disabled=!request || lookupPending;
}
function applyModelDraft(draft:ModelDraft) {
  const config=providers.find(p=>p.id===draft.provider);
  modelSelect.innerHTML=config?.models.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>').join('') || '<option value="">请先选择平台</option>';
  for(const [name,value] of Object.entries(draft)) (modelForm.elements.namedItem(name) as HTMLInputElement).value=value;
  $('#model-preset-config').hidden=!config;$('#model-custom-config').hidden=draft.provider!=='custom';
  $('#api-key-label').hidden=!!config && !config.requiresApiKey;
  $('#api-key-hint').textContent=config?.requiresApiKey?'请在启动前设置环境变量 '+draft.apiKeyEnv:'';
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
modelForm.addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
  const draft=Object.fromEntries(new FormData(modelForm)) as ModelDraft;
  const payload=settingsPayload(draft,providers,savedSettings,modelReady);
  savedSettings=await api<ModelSettings>('/api/manager/settings',payload);
});});
modelForm.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select').forEach(el=>el.disabled=true);
void Promise.all([api<{providers:ProviderConfig[]}>('/api/manager/providers'),api<ModelSettings>('/api/manager/settings')]).then(([catalog,settings])=>{
  providers=catalog.providers;savedSettings=settings;
  providerSelect.innerHTML='<option value="">使用 Pi 默认配置</option>'+providers.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('')+'<option value="custom">自定义 URL / Pi 已配置模型</option>';
  applyModelDraft(settingsDraft(settings,providers));modelReady=true;
  modelForm.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select').forEach(el=>el.disabled=false);
  updateLocalLookup();
}).catch(e=>notice('模型目录或设置加载失败，已禁止保存以保护原配置。请刷新重试：'+String(e),true));

document.querySelector('#page-missions')!.insertAdjacentHTML('beforeend', `<section class="surface-card coord-section"><h3>接入自定义 CLI</h3><p class="coord-muted">适用于提供非交互 CLI 的 Agent。通过标准输入接收任务，通过标准输出返回结果；注册后可在运行时列表中添加员工。</p><form id="adapter-form" class="stacked-form"><label>适配器 ID<input name="id" required placeholder="qoder-cli"></label><label>名称<input name="name" required placeholder="Qoder CLI"></label><label>可执行文件绝对路径<input name="executable" required placeholder="C:\\Program Files\\nodejs\\node.exe"></label><label>启动参数（JSON 字符串数组）<input name="args" required value="[]"></label><label>输出格式<select name="format"><option value="plain">纯文本</option><option value="jsonl">JSONL 事件</option></select></label><button class="outline-button">注册适配器</button><p id="adapter-notice" role="status"></p></form></section>`);
document.querySelector('#adapter-form')!.addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.target as HTMLFormElement; const output=document.querySelector('#adapter-notice')!;
  try {const values=Object.fromEntries(new FormData(form)); await api('/api/adapters',{...values,args:JSON.parse(String(values.args))}); output.textContent='适配器已注册，可以在运行时列表注册员工。';}catch(e){output.textContent=String(e instanceof Error ? e.message : e);}
});
document.addEventListener('apix:manager-settings',()=>{ const panel=$<HTMLDetailsElement>('.coord-settings'); panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'center'});$<HTMLInputElement>('#coord-model [name="provider"]').focus(); });
