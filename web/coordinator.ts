import { readConversation } from './conversation-stream.js';
import {readinessView,type Readiness} from './readiness.js';
import { saveBrief } from './requirements-form.js';
import { instructionState, recoveryForm } from './execution-view.js';
import { schedulingView } from './scheduling-view.js';
import {autonomyView,type AutonomyState} from './autonomy-view.js';
import type {AutonomyPolicy} from '../src/architecture.js';
import type { TaskProfile } from '../src/scheduling.js';
import { selectProvider, settingsDraft, settingsPayload, localLookupRequest, mergeLocalModels, connectionTestRequest, type ModelDraft, type ModelSettings, type ProviderConfig } from './model-settings.js';
type Mode = 'full_access' | 'ask_approval' | 'read_only';
type InteractionMode = 'structured' | 'conversational';
type Policy = { mode: Mode; version: number };
type Step = { prompt: string; employeeId: string; dependsOn: number[]; moduleId?:string;scheduling?:TaskProfile };
interface Session {
  autonomy?:AutonomyState|null;autonomyPolicy?:AutonomyPolicy;autonomyRecoveryFingerprint?:string|null;
  workflow?:{enabled:boolean;version:number;employeeIds:string[]};
  id: string; title: string; project_id: string; revision: number; status: string; derivedStatus: string; plan_id: string | null; planVersion?: string; interaction_mode: InteractionMode; busy?: boolean;
  requirements: Record<string,string>; assessment: {score:number;ready:boolean;conflicts:string[]}; policy: Policy; workerPolicies: Record<string,Policy>;
  tasks: {id:string;prompt:string;employee_id:string;status:string;result?:string;queue_reason?:string}[]; dependencies: {task_id:string;depends_on_id:string}[];
  turns: {role:string;kind:string;content:string}[]; agent: {mode:string;error?:string};
  managerTools?:{toolName:string;phase:'start'|'end';isError?:boolean}[];
  instructions?: {id:string;taskId:string;runId:string;status:string;payload:{content?:string;kind?:string};mailbox_seen_at?:string}[];
  capabilities?: {id:string;mailbox?:boolean}[];
  handoffs?: {task_id:string;status:string;input_commit:string;report:{files:string[];sources:{taskId:string;commit:string}[];error?:string}}[];
  scheduling?:Parameters<ReturnType<typeof schedulingView>['render']>[1];
  schedulingTasks?:{taskId:string;profile:TaskProfile;decision:{reviewMode?:string;candidates:{name:string;eligible:boolean;reasons:string[];warnings:string[];waiting:string|null;forecastMinor?:number|null;forecastCurrency?:string|null;forecastSource?:string;estimateMinor:number|null;currency:string|null;minutes:number|null;history:{samples:number;accepted:number}}[]}}[];
  planningMeetings?:{id:string;plan_id:string;round:number;status:string;body:{minutes:string;disagreements:string[];proposals:{employeeId:string;status:string;claims:unknown[];decline?:string;error?:string}[]}}[];
}
interface Delivery {taskId:string;status:string;workspacePath?:string;inputCommit?:string;deliveryCommit?:string;error?:string;inspection?:{fingerprint:string|null;files:string[];conflicts:string[];preview:string;previewTruncated?:boolean};handoff?:{status:string;report:{error?:string}};latestRun?:{id:string;status:string;pid:number|null};processMayExist:boolean|null;managedActive:boolean;recoveryFingerprint:string|null;sourceHead?:string|null}
interface ExecutionPolicy {projectLimit:number;employeeLimit:number;paused:boolean;version:number;runtimePauses:{runtime:string;reason:string}[]}
interface Snapshot { projects:{id:string;name:string}[]; employees:{id:string;name:string;runtime:string}[]; artifacts:{id:string;run_id:string;content:string}[]; runs:{id:string;task_id:string}[] }
const root = document.querySelector<HTMLElement>('#page-coordinator')!;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => (root.querySelector<T>(selector) ?? document.querySelector<T>(selector))!;
let snapshot: Snapshot = {projects:[],employees:[],artifacts:[],runs:[]};
let projectId = ''; let sessionId = ''; let current: Session | null = null; let loading = false; let reloading = false; let editingBrief = false; let planKey = ''; let draft: Step[] = []; let reloadVersion = 0;
let streaming = false; let isComposing = false;
let newChat=false;
type Workflow={enabled:boolean;version:number;employeeIds:string[];manager:Policy;employees:{id:string;name:string;runtime:string;version:number}[]};
let workflow:Workflow|null=null;
let autonomyPolicy:AutonomyPolicy|null=null;
const messageDrafts = new Map<string,string>();
const newMessageDrafts=new Map<string,string>();
const failedReplies = new Map<string,{text:string;error:string}>();
const unsynced = new Set<string>();
const deliveryFingerprints = new Map<string,string>();
let executionPolicy:ExecutionPolicy|null=null;
let inspectedDelivery:Delivery|null=null;
const fields = [['goal','目标'],['scope','范围与边界'],['constraints','约束'],['deliverable','交付物'],['acceptance','验收标准']];
const statuses: Record<string,string> = {clarifying:'澄清中',ready:'待确认需求',plan_review:'待审查计划',running:'执行中',awaiting_acceptance:'待验收',completed:'已验收',attention:'需要处理',cancelled:'已取消',awaiting_approval:'待批准',queued:'排队中',failed:'失败',blocked:'已阻塞',accepted:'已验收',stopping:'正在停止',unknown:'状态未知',needs_revision:'需要修改'};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path,body === undefined ? undefined : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`); return data as T;
}
function notice(message: string, error = false) { $('#coord-notice').textContent=message; $('#coord-notice').classList.toggle('error',error); }
async function action(work:()=>Promise<void>) {
  if (loading) return; loading=true; root.classList.add('is-busy'); updateStreamingControls();
  const originProject=projectId; const originSession=sessionId;
  const originFocus=document.activeElement;
  notice('ApiX 正在处理…');
  try { await work(); if(document.activeElement===originFocus && originFocus instanceof HTMLButtonElement)originFocus.blur();if(projectId===originProject && sessionId===originSession)notice('已保存'); await reload(); }
  catch(e) { if(projectId===originProject && sessionId===originSession)notice(e instanceof Error ? e.message : String(e),true); }
  finally { loading=false; root.classList.remove('is-busy'); if(projectId!==originProject || sessionId!==originSession)notice('');updateStreamingControls(); }
}
function modeOptions(mode: Mode) { return [['ask_approval','请求批准'],['full_access','完全访问'],['read_only','只读规划']].map(([v,l])=>`<option value="${v}" ${v===mode?'selected':''}>${l}</option>`).join(''); }
function interactionOptions(mode: InteractionMode) { return [['conversational','对话模式'],['structured','约束模式']].map(([v,l])=>`<option value="${v}" ${v===mode?'selected':''}>${l}</option>`).join(''); }
function updateStreamingControls() {
  const disabled=streaming || loading || !current || current.id!==sessionId || !!current.busy || unsynced.has(sessionId);
  $<HTMLTextAreaElement>('#coord-message textarea').disabled=disabled;
  $<HTMLButtonElement>('#coord-message button').disabled=disabled;
  const startButton=root.querySelector<HTMLButtonElement>('#desktop-start button');if(startButton)startButton.disabled=loading || streaming || !projectId;
}
function selectSession(id:string) {
  const input=$<HTMLTextAreaElement>('#coord-message textarea');
  if(sessionId)messageDrafts.set(sessionId,input.value);
  sessionId=id;current=null;reloadVersion++;editingBrief=false;planKey='';
  if(id)localStorage.setItem('apix.chat.'+projectId,id);
  input.value=messageDrafts.get(id) ?? '';
  $('#coord-turns').querySelectorAll('.coord-turn:not(#coord-stream)').forEach(node=>node.remove());
  $('#coord-turns').dataset.session='';$('#coord-turns').dataset.rendered='';
  $('#coord-body').hidden=true;updateStreamingControls();
  root.querySelector('#coord-delivery-panel')?.remove();
  inspectedDelivery=null;
  $('#coord-history-output').textContent='';
  $<HTMLButtonElement>('#coord-history-earlier').hidden=true;
  const tools=root.querySelector<HTMLElement>('#desktop-tools');if(tools){tools.textContent='本次对话尚无工具调用。';delete tools.dataset.key;}
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
  apixTurn.innerHTML='<strong>ApiX</strong><p class="stream-tool" role="status"></p><p class="stream-text">正在思考…</p>';
  const follow=nearBottom();$('#coord-stream').before(userTurn,apixTurn);if(follow)history.scrollTop=history.scrollHeight;
  const streamText=apixTurn.querySelector<HTMLElement>('.stream-text')!;
  let partial='';let finalSession:Session|null=null;
  try {
    const response=await fetch('/api/coordination/sessions/'+encodeURIComponent(id)+'/messages/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    await readConversation<Session>(response,id,{
      delta(text){partial+=text;if(ownsView()){const follow=nearBottom();streamText.textContent=partial;if(follow)history.scrollTop=history.scrollHeight;}},
      tool(event){if(ownsView())apixTurn.querySelector('.stream-tool')!.textContent=`${event.phase==='start'?'正在使用':event.isError?'工具失败':'工具完成'} · ${event.toolName}`;},
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
<details class="coord-settings"><summary>ApiX 的推理模型</summary><p>ApiX 独立调用模型 API；Pi、Codex、Claude 等是可选执行 Agent。支持 DeepSeek、阿里云百炼、火山引擎豆包等平台。</p><form id="coord-model"><label>模型平台<select name="provider" id="model-provider-select"><option value="">请选择模型 API</option><option value="custom">自定义 URL</option></select></label><div id="model-preset-config" hidden><label>选择模型<select name="model" id="model-select"><option value="">请先选择平台</option></select></label><label>或自定义模型名称 <span class="field-optional">(可选)</span><input name="customModelName" id="custom-model-name-input" placeholder="留空使用上方选中的模型"><small class="field-hint">用于该平台的其他模型，如新版本或特殊模型</small></label><label id="api-key-label">API Key 环境变量<input name="apiKeyEnv" id="api-key-input" placeholder="例如 DEEPSEEK_API_KEY"><small class="field-hint" id="api-key-hint"></small></label></div><div id="model-custom-config" hidden><label>自定义 API URL<input name="baseUrl" type="url" placeholder="http://127.0.0.1:11434/v1"></label><label>模型 ID<input name="customModel" placeholder="例如 qwen-max"></label><label>API 类型<select name="apiType"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label>API Key 环境变量<input name="customApiKeyEnv" placeholder="例如 CUSTOM_API_KEY"></label></div><button class="outline-button">保存模型配置</button></form></details></aside>
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
const executionSection=document.createElement('section');executionSection.className='surface-card coord-section';executionSection.id='coord-execution';
$('#coord-tasks').parentElement!.before(executionSection);
function renderExecutionPolicy() {
  const p=executionPolicy;if(!p || executionSection.contains(document.activeElement))return;
  executionSection.innerHTML=`<h3>执行限额与暂停</h3><p>暂停或降低并发只影响新启动的任务。状态未知的任务占用名额，请检查后恢复。</p><form id="coord-execution-form"><label>项目并发<input name="projectLimit" type="number" min="1" max="8" required value="${p.projectLimit}"></label><label>每位员工在本项目的并发<input name="employeeLimit" type="number" min="1" max="4" required value="${p.employeeLimit}"></label><label><input name="paused" type="checkbox" ${p.paused?'checked':''}>暂停本项目的新任务</label><button class="outline-button">保存执行设置</button></form>${p.runtimePauses.map(r=>`<p>${esc(r.runtime)} · ${esc(r.reason)} <button class="outline-button" data-resume-runtime="${esc(r.runtime)}">已检查额度，恢复新启动</button></p>`).join('')}`;
}
executionSection.addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const project=projectId;const form=event.target as HTMLFormElement;const values=new FormData(form);await api(`/api/projects/${project}/execution`,{version:executionPolicy!.version,projectLimit:Number(values.get('projectLimit')),employeeLimit:Number(values.get('employeeLimit')),paused:values.has('paused')});});});
executionSection.addEventListener('click',event=>{const button=(event.target as Element).closest<HTMLElement>('[data-resume-runtime]');if(button)void action(async()=>{await api(`/api/projects/${projectId}/execution/runtime`,{version:executionPolicy!.version,runtime:button.dataset.resumeRuntime,paused:false});});});
const schedulingSection=document.createElement('section');schedulingSection.className='surface-card coord-section';executionSection.after(schedulingSection);
const schedulingUI=schedulingView(schedulingSection,(path,body)=>void action(async()=>{const originalProject=projectId;const originalSession=sessionId;const focus=document.activeElement;await api(path,body);if(originalProject===projectId && originalSession===sessionId && document.activeElement===focus)(focus as HTMLElement)?.blur();}));
const autonomySection=document.createElement('section');autonomySection.className='surface-card coord-section';autonomySection.id='coord-autonomy';autonomySection.innerHTML='<h3>自主交付</h3>';executionSection.after(autonomySection);
const autonomyUI=autonomyView(autonomySection,(path,body)=>void action(async()=>{await api(path,body);}));
const meetingSection=document.createElement('section');meetingSection.className='surface-card coord-section';schedulingSection.after(meetingSection);
// Reuse the existing controls in a chat-first desktop layout.
const layout=$('.coord-layout');const body=$('#coord-body');const empty=$('#coord-empty');const rail=$('.coord-rail');
const inspector=document.createElement('aside');inspector.className='desktop-inspector';inspector.id='desktop-inspector';
const main=document.createElement('div');main.className='desktop-main';main.append(empty,body);
const chats=$('#coord-sessions');const chatSection=document.createElement('div');chatSection.className='sidebar-section desktop-chats';chatSection.innerHTML='<div class="section-heading"><span class="section-caption">对话</span><button class="icon-button" id="desktop-new-chat" aria-label="新建对话">＋</button></div>';chatSection.append(chats);document.querySelector('.project-section')!.after(chatSection);
chats.addEventListener('click',event=>{const button=(event.target as Element).closest<HTMLButtonElement>('button[data-session]');if(button && chats.contains(button) && button.dataset.session!==sessionId){newChat=false;selectSession(button.dataset.session!);void reload().catch(e=>notice(String(e),true));}});
inspector.innerHTML='<div class="desktop-inspector-head"><strong>工作详情</strong><button class="outline-button" id="desktop-close-details" aria-label="关闭工作详情">关闭</button></div><section id="desktop-workflow" class="surface-card"></section><details class="desktop-detail"><summary>ApiX 工具活动</summary><div id="desktop-tools"></div></details>';
for(const section of [...body.children])if(section.classList.contains('coord-section') || section.id==='coord-execution'){
  if(section.querySelector('#coord-tasks')){
    section.querySelector('h3')!.textContent='Agent 活动';
    const plan=document.createElement('details');plan.className='desktop-plan';plan.innerHTML='<summary>任务安排与审查</summary>';
    plan.append(section.querySelector('#coord-plan')!,section.querySelector('.coord-actions')!,section.querySelector('#coord-add-step')!);
    section.querySelector('#coord-tasks')!.before(plan);inspector.append(section);continue;
  }
  const details=document.createElement('details');details.className='desktop-detail';const summary=document.createElement('summary');summary.textContent=section.querySelector('h3')?.textContent??'工作记录';details.append(summary,section);inspector.append(details);
}
const requirements=body.querySelector<HTMLElement>('#coord-requirements')!;const briefDetails=document.createElement('details');briefDetails.className='desktop-detail';briefDetails.innerHTML='<summary>需求与验收</summary>';briefDetails.append(requirements);inspector.append(briefDetails,rail.querySelector('.coord-settings')!);
const interactionDetails=document.createElement('details');interactionDetails.className='desktop-detail';interactionDetails.innerHTML='<summary>对话方式</summary>';interactionDetails.append(body.querySelector('.coord-mode')!);inspector.append(interactionDetails);
layout.replaceChildren(main,inspector);
rail.hidden=true;root.append(rail);
layout.classList.add('inspector-closed');
$('.coord-header').insertAdjacentHTML('beforeend','<button id="desktop-mobile-new" class="outline-button desktop-mobile-new">新建对话</button><button id="desktop-project-settings" class="outline-button">项目设置</button>');
$('.coord-header h1').textContent='对话工作区';
$('.coord-header').insertAdjacentHTML('afterend','<p id="desktop-model-state" role="status" hidden></p>');
$('.coord-header').insertAdjacentHTML('afterend','<section id="desktop-readiness" aria-label="首次使用与配置检查"></section>');
let setupUpdated=0;let setupRequest=0;
async function refreshReadiness(force=false){
  if(!force && Date.now()-setupUpdated<15000)return;
  setupUpdated=Date.now();const version=++setupRequest;const selected=projectId;
  try{const result=await api<Readiness>('/api/readiness?projectId='+encodeURIComponent(selected));if(version===setupRequest && selected===projectId && !$('#desktop-readiness').contains(document.activeElement))$('#desktop-readiness').innerHTML=readinessView(result);}
  catch{if(version===setupRequest)$('#desktop-readiness').textContent='配置检查暂不可用，请确认本地服务状态。';}
}
$('#desktop-readiness').addEventListener('click',event=>{
  const el=(event.target as Element).closest<HTMLElement>('[data-setup-action],[data-setup-refresh]');if(!el)return;
  if(el.hasAttribute('data-setup-refresh')){void refreshReadiness(true);return;}
  const target=el.dataset.setupAction;
  if(target==='model'){toggleInspector(true);document.dispatchEvent(new Event('apix:manager-settings'));}
  else if(target==='budget' || target==='permissions'){toggleInspector(true);const section=target==='budget'?schedulingSection:$('#desktop-workflow');section.closest('details')?.setAttribute('open','');section.scrollIntoView({block:'nearest'});}
  else document.querySelector<HTMLButtonElement>(`[data-page-target="${target}"]`)?.click();
});
function toggleInspector(open:boolean){layout.classList.toggle('inspector-closed',!open);$('#desktop-details').setAttribute('aria-expanded',String(open));$('#desktop-project-settings').setAttribute('aria-expanded',String(open));}
$('#desktop-project-settings').addEventListener('click',()=>toggleInspector(layout.classList.contains('inspector-closed')));
$('#desktop-close-details').addEventListener('click',()=>toggleInspector(false));
document.addEventListener('keydown',event=>{if(root.classList.contains('active-page') && event.key==='Escape' && !layout.classList.contains('inspector-closed')){toggleInspector(false);$('#desktop-project-settings').focus();}});
for(const details of inspector.querySelectorAll<HTMLDetailsElement>('.desktop-detail')){const section=details.querySelector('section');if(section===executionSection)details.querySelector('summary')!.textContent='执行与暂停';if(section===schedulingSection)details.querySelector('summary')!.textContent='能力与预算';if(section===meetingSection)details.querySelector('summary')!.textContent='规划会议';}
empty.innerHTML='<div class="desktop-welcome"><span class="desktop-orbit">A</span><h2>今天想完成什么？</h2><p>选择项目，直接告诉 ApiX。它会规划工作、安排 Agent，并带回可检查的结果。</p><div class="desktop-suggestions"><button type="button" data-prompt="检查这个项目，找出最值得修复的问题">检查项目</button><button type="button" data-prompt="帮助我实现一个新功能">开发功能</button><button type="button" data-prompt="检查测试和代码质量，提出改进建议">验证质量</button></div><form id="desktop-start" class="coord-composer"><label><span class="sr-only">给 ApiX 发消息</span><textarea name="content" rows="3" maxlength="4000" required placeholder="描述任务，或直接问一个问题…"></textarea></label><div class="desktop-composer-bar"><span>ApiX · 项目上下文</span><button class="primary-button" type="submit" aria-label="发送并开始对话">↑</button></div></form><button class="text-action" data-page-target="projects">添加或管理项目</button></div>';
const newConversation=()=>{newChat=true;selectSession('');empty.hidden=false;body.hidden=true;void reload();$<HTMLTextAreaElement>('#desktop-start textarea').focus();};
document.querySelector('#desktop-new-chat')!.addEventListener('click',newConversation);
document.addEventListener('apix:new-chat',newConversation);
$('#desktop-mobile-new').addEventListener('click',newConversation);
empty.addEventListener('click',event=>{const button=(event.target as Element).closest<HTMLElement>('[data-prompt]');if(button){const input=$<HTMLTextAreaElement>('#desktop-start textarea');input.value=button.dataset.prompt!;input.focus();}});
$('#desktop-start').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{if(!projectId)throw new Error('请先添加或选择项目');const originProject=projectId;const input=$<HTMLTextAreaElement>('#desktop-start textarea');const content=input.value.trim();const created=await api<Session>('/api/coordination/sessions',{projectId:originProject,goal:content,interactionMode:'conversational'});if(projectId!==originProject)return;newChat=false;selectSession(created.id);render(created);input.value='';await streamMessage(created.id,{revision:created.revision,content},content);});});
$('#coord-message button').textContent='↑';$('#coord-message button').setAttribute('aria-label','发送消息');
$('#coord-message').insertAdjacentHTML('beforebegin','<div id="desktop-activity" class="desktop-activity" hidden></div>');
root.addEventListener('click',event=>{if((event.target as Element).closest('[data-review-plan]')){toggleInspector(true);$<HTMLDetailsElement>('.desktop-plan').open=true;}});
$('.coord-goal-head').insertAdjacentHTML('beforeend','<div class="desktop-work-actions"><button id="desktop-stop" class="outline-button">停止工作</button><button id="desktop-details" class="outline-button" aria-expanded="true">工作详情</button></div>');
$('#desktop-stop').addEventListener('click',()=>void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/stop`,{revision:current!.revision});}));
$('#desktop-details').setAttribute('aria-expanded','false');$('#desktop-project-settings').setAttribute('aria-expanded','false');
$('#desktop-details').addEventListener('click',()=>toggleInspector(layout.classList.contains('inspector-closed')));
$('.coord-header').insertAdjacentHTML('beforeend','<button id="desktop-capabilities" class="desktop-capabilities" title="查看工具权限和自动协作设置"></button>');
$('#desktop-capabilities').addEventListener('click',()=>{toggleInspector(true);$('#desktop-workflow').scrollIntoView({block:'nearest'});});
function renderWorkflow(){
  if(!workflow || $('#desktop-workflow').contains(document.activeElement))return;
  $('#desktop-capabilities').textContent=`${workflow.manager.mode==='full_access'?'工具已开启':workflow.manager.mode==='read_only'?'只读工具':'工具待授权'} · ${workflow.enabled?'自动协作':'计划待审'}`;
  $('#desktop-workflow').innerHTML=`<h3>${workflow.enabled?'自动协作已开启':'按计划审查'}</h3><p>${workflow.enabled?'明确任务会自动规划和派发；自主交付开启时按授权实测、自审及返工，其他目标完成后等待你验收。':'明确工作请求会生成待审计划；开启自动协作后按授权派发。'}</p><form id="desktop-automation">${workflow.enabled?'':`<p>授权 ApiX 使用文件读写和命令工具，并与所选员工在当前项目执行，可能产生模型费用。默认只处理目标相关内容，遵守预算与项目规则，成果须审查。</p>${workflow.employees.map(e=>`<label><input type="checkbox" name="employee" value="${esc(e.id)}" checked>${esc(e.name)} · ${esc(e.runtime)}</label>`).join('')||'<button type="button" data-page-target="missions" class="text-action">先配置可用 Agent</button>'}`}<button class="outline-button" ${!workflow.enabled&&!workflow.employees.length?'disabled':''}>${workflow.enabled?'暂停自动安排':'授权并开启自动协作'}</button></form>`;
}
$('#desktop-workflow').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const form=event.target as HTMLFormElement;const selected=new FormData(form).getAll('employee');await api(`/api/projects/${projectId}/workflow`,{version:workflow!.version,enabled:!workflow!.enabled,approved:!workflow!.enabled,managerVersion:workflow!.manager.version,employees:workflow!.employees.filter(e=>selected.includes(e.id)).map(e=>({id:e.id,version:e.version}))});});});
meetingSection.addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const form=event.target as HTMLFormElement;const v=new FormData(form);const participants=[...form.querySelectorAll<HTMLInputElement>('[data-participant]:checked')].map(e=>({employeeId:e.value,estimateMinor:v.get('cap:'+e.value)===''?null:Number(v.get('cap:'+e.value))}));await api(`/api/coordination/sessions/${sessionId}/planning-meetings`,{revision:current!.revision,planVersion:current!.planVersion,approved:v.has('approved'),participants,previousId:v.get('previousId')||undefined});});});
meetingSection.addEventListener('click',event=>{const el=(event.target as Element).closest<HTMLElement>('[data-apply-meeting]');if(el)void action(async()=>{await api(`/api/coordination/sessions/${sessionId}/planning-meetings/apply`,{revision:current!.revision,planVersion:current!.planVersion,meetingId:el.dataset.applyMeeting});planKey='';});});
function render(s: Session) {
  current=s; $('#coord-empty').hidden=true; $('#coord-body').hidden=false;
  const tools=$('#desktop-tools');const toolKey=JSON.stringify(s.managerTools??[]);if(tools.dataset.key!==toolKey){tools.dataset.key=toolKey;tools.innerHTML=(s.managerTools??[]).map(e=>`<p>${esc(e.toolName)} · ${e.phase==='start'?'开始':e.isError?'失败':'完成'}</p>`).join('')||'<p>本次对话尚无工具调用。</p>';}
  $('#desktop-model-state').hidden=!s.agent.error;$('#desktop-model-state').textContent=s.agent.error?`模型规划或连接需要处理：${s.agent.error}`:'';
  const planPanel=$<HTMLDetailsElement>('.desktop-plan');if(planPanel.dataset.status!==s.status){planPanel.open=s.status==='plan_review';planPanel.dataset.status=s.status;}
  const activity=$('#desktop-activity');activity.hidden=!s.tasks.length;
  const automaticQuality=s.autonomy?.state==='running'&&s.autonomyPolicy?.enabled===true;
  const finished=automaticQuality?undefined:s.tasks.find(t=>t.status==='completed');
  activity.innerHTML=`<div><strong>${esc(statuses[s.derivedStatus]??s.derivedStatus)}</strong><span>${s.tasks.filter(t=>t.status==='running').length} 个执行中 · ${s.tasks.filter(t=>t.status==='queued').length} 个排队 · ${s.tasks.filter(t=>t.status==='completed').length} 个${automaticQuality?'等待自动检查':'待验收'}</span></div>${s.status==='plan_review'?'<button class="outline-button" data-review-plan>检查计划与阻塞原因</button>':finished?`<button class="outline-button" data-delivery="${esc(finished.id)}">查看变更并验收</button>`:''}`;
  $('#desktop-stop').hidden=!s.tasks.some(t=>['running','queued','awaiting_approval','stopping'].includes(t.status));
  if(s.scheduling)schedulingUI.render(projectId,s.scheduling,snapshot.employees);
  if(!meetingSection.contains(document.activeElement)){
    const expanded=[...meetingSection.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d=>d.querySelector('summary')?.textContent);
    const meetings=s.planningMeetings??[];const active=meetings.filter(m=>m.plan_id===s.plan_id);const first=active.find(m=>m.round===1);
    meetingSection.innerHTML=`<h3>规划会议</h3><p>参与者独立提出可领取的步骤、依据与风险。当前支持 Pi 和具有 bare/restricted 模式的 Claude CLI；Pi 可配置不同模型。Codex 等其他 CLI 尚未验证。会议建议不等于执行审批。</p>${s.status==='plan_review'?`<form data-meeting>${snapshot.employees.filter(e=>['pi','claude'].includes(e.runtime)).map(e=>`<label><input type="checkbox" data-participant value="${esc(e.id)}">${esc(e.name)}<input name="cap:${esc(e.id)}" type="number" min="0" step="1" aria-label="${esc(e.name)} 会议费用上界" placeholder="费用上界，未知留空"></label>`).join('')||'<p>没有支持此会议模式的员工。</p>'}${first && !active.some(m=>m.round===2) && first.body.disagreements.length?`<label><input type="checkbox" name="previousId" value="${esc(first.id)}">针对上一轮分歧进行第二轮</label>`:''}<label><input type="checkbox" name="approved" required>批准以上参与者与本次会议费用预留（最多三位）</label><button class="outline-button" ${s.busy?'disabled':''}>召开规划会议</button></form>`:''}${meetings.map(m=>`<details><summary>第 ${m.round} 轮 · ${esc(m.status)}${m.plan_id!==s.plan_id?' · 历史计划':''}</summary><p>${esc(m.body.minutes)}</p>${m.body.proposals.map(p=>`<article><strong>${esc(snapshot.employees.find(e=>e.id===p.employeeId)?.name??p.employeeId)} · ${esc(p.status)}</strong><pre>${esc(p.error??JSON.stringify(p.claims,null,2))}</pre><p>${esc(p.decline)}</p></article>`).join('')}<p>${esc(m.body.disagreements.join('；'))}</p>${m.status==='completed' && m.plan_id===s.plan_id && s.status==='plan_review'?`<button class="outline-button" data-apply-meeting="${esc(m.id)}">按可用领取建议生成新待审计划</button>`:''}</details>`).join('')}`;
    for(const detail of meetingSection.querySelectorAll<HTMLDetailsElement>('details'))if(expanded.includes(detail.querySelector('summary')?.textContent))detail.open=true;
  }
  root.dataset.interactionMode=s.interaction_mode;
  $('#coord-title').textContent=s.title; $('#coord-status').textContent=statuses[s.derivedStatus] ?? s.derivedStatus;
  $('#coord-chat-title').textContent=s.interaction_mode==='conversational'?'与 ApiX 对话':'需求澄清记录';
  $('#coord-message-label').textContent=s.interaction_mode==='conversational'?'给 ApiX 发消息':'补充需求或询问进展';
  $<HTMLSelectElement>('#coord-interaction-mode').value=s.interaction_mode;
  $<HTMLSelectElement>('#coord-interaction-mode').disabled=!['clarifying','ready'].includes(s.status);
  $('#coord-score').textContent=`${Math.round(s.assessment.score*100)}% · v${s.revision}`;
  $('#coord-backend').textContent=s.agent.mode==='api' ? 'ApiX 正在直接调用模型 API' : s.agent.mode==='pi' ? '历史记录 · 旧 Pi 后端；后续请求使用 ApiX 模型 API' : `规则引导${s.agent.error ? ` · ${s.agent.error}` : ' · 配置模型 API 后继续澄清'}`;
  const hasMessages=s.turns.some(t=>t.kind==='message');
  const turns=s.turns.filter((t,i)=>!(hasMessages && (t.kind==='goal'||i===1&&t.kind==='clarification'))).map(t=>`<article class="coord-turn ${t.role==='user'?'from-user':''}"><strong>${t.role==='user'?'你':'ApiX'}</strong><p>${esc(t.content)}</p></article>`).join('');
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
  const key=JSON.stringify([s.plan_id,s.planVersion,s.status,s.tasks.map(t=>[t.id,t.employee_id,t.prompt])]);
  if (s.autonomyPolicy)autonomyUI.render(projectId,s.autonomyPolicy,{id:s.id,revision:s.revision,autonomy:s.autonomy??null,autonomyRecoveryFingerprint:s.autonomyRecoveryFingerprint});
  if (key!==planKey) { planKey=key; draft=s.tasks.map(t=>({moduleId:s.autonomy?.tasks.find(a=>a.task_id===t.id)?.module_id,prompt:t.prompt,employeeId:t.employee_id,dependsOn:s.dependencies.filter(d=>d.task_id===t.id).map(d=>s.tasks.findIndex(x=>x.id===d.depends_on_id)),scheduling:s.schedulingTasks?.find(p=>p.taskId===t.id)?.profile})); renderPlan(); }
  for(const id of ['coord-save-plan','coord-dispatch','coord-add-step']) $( '#'+id).hidden=s.status!=='plan_review';
  $('#coord-tasks').innerHTML=s.tasks.map((t,i)=>{
    const waiting=s.dependencies.filter(d=>d.task_id===t.id).map(d=>s.tasks.findIndex(task=>task.id===d.depends_on_id)).filter(index=>index>=0 && s.tasks[index]!.status!=='accepted');
    const hint=waiting.length ? `前置步骤 ${waiting.map(index=>index+1).join('、')} 尚未验收` : '无待验收的前置步骤';
    const handoff=s.handoffs?.find(h=>h.task_id===t.id);
    return `<article class="coord-task"><span>${i+1}</span><div><strong>${esc(snapshot.employees.find(e=>e.id===t.employee_id)?.name ?? '历史员工')}</strong><p>${esc(t.prompt)}</p><small>${esc(t.queue_reason || hint)}${handoff ? ' · '+esc(handoff.status==='ready'?(handoff.report.sources.length?`已交接 ${handoff.report.files.length} 个文件`:'工作区就绪'):'代码交接需要处理') : ''}</small>${t.result?`<details><summary>最近保存的运行报告</summary><pre>${esc(t.result)}</pre></details>`:''}</div><span class="coord-pill">${esc(t.status==='completed'?(s.autonomy?'等待自动质量检查':'待验收'):statuses[t.status] ?? t.status)}</span>${['queued','completed','accepted','blocked','unknown','failed','needs_revision','cancelled'].includes(t.status)?`<button class="text-action" data-delivery="${esc(t.id)}">检查代码与恢复</button>`:''}${t.status==='completed'?`<button class="text-action" data-coord-reject="${t.id}">要求修改</button>`:''}</article>`;
  }).join('');
  const active=s.tasks.filter(t=>t.status==='running');
  $('#coord-guidance-section').hidden=!active.length && !s.instructions?.length;
  $('#coord-instruction').hidden=!active.length;
  let instructionList=root.querySelector<HTMLElement>('#coord-instructions');
  if(!instructionList){instructionList=document.createElement('div');instructionList.id='coord-instructions';$('#coord-guidance-section').append(instructionList);}
  instructionList.innerHTML=(s.instructions ?? []).map(m=>`<article class="coord-task"><div><strong>${esc(instructionState(m.status))}</strong><p>${esc(m.payload.content ?? (m.payload.kind==='progress_request'?'ApiX 请求真实进度':'协作消息'))}</p><small>${esc(s.tasks.findIndex(t=>t.id===m.taskId)+1)} 号任务 · ${esc(m.runId?.slice(0,8))} · ${m.mailbox_seen_at?'已检测到消息领取':'尚未检测到此运行领取消息'}</small></div></article>`).join('');
  const taskSelect=$<HTMLSelectElement>('#coord-instruction [name="taskId"]');
  const previousTask=taskSelect.value;
  taskSelect.innerHTML=active.map(t=>`<option value="${esc(t.id)}">${esc(snapshot.employees.find(e=>e.id===t.employee_id)?.name ?? t.employee_id)} · ${esc(t.prompt.slice(0,60))} · ${s.capabilities?.find(c=>c.id===snapshot.employees.find(e=>e.id===t.employee_id)?.runtime)?.mailbox?'声明支持实时消息':'需员工主动读取，未保证实时指导'}</option>`).join('');
  if(active.some(t=>t.id===previousTask)) taskSelect.value=previousTask;
  $('#coord-revise').hidden=['clarifying','ready'].includes(s.status);
  const runIds=snapshot.runs.filter(r=>s.tasks.some(t=>t.id===r.task_id)).map(r=>r.id);
  $('#coord-artifacts').innerHTML=snapshot.artifacts.filter(a=>runIds.includes(a.run_id)).map(a=>`<details><summary>员工交付物 · ${esc(a.id.slice(0,8))}</summary><pre>${esc(a.content)}</pre></details>`).join('') || '<p class="coord-muted">员工的实际交付物会显示在这里。</p>';
}
function renderPlan() {
  $('#coord-plan').innerHTML=current?.status==='plan_review' ? draft.map((s,i)=>`<div class="coord-plan-step" data-step="${i}"><strong>步骤 ${i+1}</strong><label>任务<textarea data-prompt>${esc(s.prompt)}</textarea></label><label>员工<select data-employee>${snapshot.employees.map(e=>`<option value="${e.id}" ${s.employeeId===e.id?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label><label>等待步骤（逗号分隔的编号）<input data-deps value="${s.dependsOn.map(n=>n+1).join(',')}"></label><details><summary>高级调度约束</summary><label>调度约束（JSON；费用为已批准上界，写入范围为相对路径）<textarea data-scheduling>${esc(JSON.stringify(s.scheduling ?? {kind:'implementation',tags:[],tools:[],writePaths:[],estimateMinor:null},null,2))}</textarea></label></details>${candidateReasons(i)}<button data-remove="${i}" class="text-action">删除步骤</button></div>`).join('') : '';
}
function candidateReasons(index:number) {
  const task=current?.tasks[index];const report=current?.schedulingTasks?.find(p=>p.taskId===task?.id);
  const review=report?.decision.reviewMode;const reviewLabel=review==='self_review'?'此步骤为自审':review==='independent'?'此步骤由另一位员工审查':review?'未声明被审查步骤，独立性未验证':'';
  return report?`<details><summary>选人与排除原因（计划生成时）</summary><p>${esc(reviewLabel)}</p><p>保存能力、账户、权限或任务约束后需要重新审查计划。可在 estimates 中为各 employeeId 填写人工估计的 estimateMinor 与 minutes；未知留空，不同币种不互相比价。</p>${report.decision.candidates.map(e=>`<p><strong>${esc(e.name)} · ${e.eligible?'满足当前草案约束':'已排除'}</strong><br>${esc([...e.reasons,...e.warnings,e.waiting??''].filter(Boolean).join('；')||'无已知阻塞')}<br>已验收 ${e.history.accepted}/${e.history.samples} 个可比样本 · 预测 ${e.forecastMinor??'未知'} ${esc(e.forecastCurrency??'')}（${esc(e.forecastSource??'unknown')}） · 费用上界 ${e.estimateMinor??'未知'} ${esc(e.currency??'')} · 时间 ${e.minutes??'未知'} 分钟</p>`).join('')}</details>`:'';
}
function readDraft(): Step[] { return [...root.querySelectorAll<HTMLElement>('[data-step]')].map((el,index)=>({moduleId:draft[index]?.moduleId,scheduling:JSON.parse(el.querySelector<HTMLTextAreaElement>('[data-scheduling]')!.value),prompt:el.querySelector<HTMLTextAreaElement>('[data-prompt]')!.value,employeeId:el.querySelector<HTMLSelectElement>('[data-employee]')!.value,dependsOn:el.querySelector<HTMLInputElement>('[data-deps]')!.value.split(',').filter(v=>v.trim()).map(v=>Number(v.trim())-1)})); }
async function reload() {
  let version = ++reloadVersion; const selectedProject = projectId; reloading=true;
  try {
    if(!projectId) { $('#coord-body').hidden=true; $('#coord-empty').hidden=false; return; }
    const [list,policy,automatic,autonomous]=await Promise.all([api<Pick<Session,'id'|'title'|'derivedStatus'>[]>(`/api/coordination/sessions?projectId=${encodeURIComponent(projectId)}&summary=1`),api<ExecutionPolicy>(`/api/projects/${encodeURIComponent(projectId)}/execution`),api<Workflow>(`/api/projects/${encodeURIComponent(projectId)}/workflow`),api<AutonomyPolicy>(`/api/projects/${encodeURIComponent(projectId)}/autonomy`)]);
    if(version!==reloadVersion || selectedProject!==projectId) return;
    if(!newChat && !list.some(s=>s.id===sessionId)) {const remembered=localStorage.getItem('apix.chat.'+projectId);selectSession(list.find(s=>s.id===remembered)?.id ?? list[0]?.id ?? '');version=reloadVersion;}
    workflow=automatic;renderWorkflow();
    autonomyPolicy=autonomous;if(!sessionId)autonomyUI.render(projectId,autonomous,null);
    $('#coord-sessions').innerHTML=list.map(s=>`<button class="coord-session ${s.id===sessionId?'selected':''}" data-session="${s.id}"><strong>${esc(s.title)}</strong><span>${esc(statuses[s.derivedStatus] ?? s.derivedStatus)}</span></button>`).join('');
    executionPolicy=policy;renderExecutionPolicy();
    const selected=list.find(s=>s.id===sessionId);
    if(selected) {const detail=await api<Session>(`/api/coordination/sessions/${selected.id}`);if(version!==reloadVersion || selectedProject!==projectId || selected.id!==sessionId)return;unsynced.delete(selected.id);render(detail);} else {current=null;$('#coord-body').hidden=true;$('#coord-empty').hidden=false;}
  } finally {if(version===reloadVersion)reloading=false;}
}
document.addEventListener('apix:snapshot', ((event: CustomEvent<{data:Snapshot;projectId:string}>)=>{
  snapshot=event.detail.data;
  const changed=projectId!==event.detail.projectId;
  if(changed) {newMessageDrafts.set(projectId,$<HTMLTextAreaElement>('#desktop-start textarea').value);selectSession('');projectId=event.detail.projectId;$<HTMLTextAreaElement>('#desktop-start textarea').value=newMessageDrafts.get(projectId)??'';updateLocalLookup();setupUpdated=0;}
  void refreshReadiness();
  updateStreamingControls();
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
$('#coord-instruction').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const form=event.target as HTMLFormElement;const originSession=sessionId;const originProject=projectId;const input=form.querySelector<HTMLTextAreaElement>('textarea')!;const content=input.value;await api(`/api/coordination/sessions/${originSession}/instructions`,{revision:current!.revision,...Object.fromEntries(new FormData(form))});if(originSession===sessionId && originProject===projectId && input.value===content)input.value='';});});
$('#coord-permissions').addEventListener('change',event=>{const select=event.target as HTMLSelectElement;const subject=select.dataset.permission!;void action(async()=>{const policy=subject==='apix'?current!.policy:current!.workerPolicies[subject] ?? {version:0};await api('/api/permissions',{projectId,subject,mode:select.value,version:policy.version});});});
function renderDelivery(d:Delivery) {
  inspectedDelivery=d;
  root.querySelector('#coord-delivery-panel')?.remove();
  const panel=document.createElement('section');panel.id='coord-delivery-panel';panel.className='surface-card coord-section';
  if(d.inspection?.fingerprint)deliveryFingerprints.set(d.taskId,d.inspection.fingerprint);else deliveryFingerprints.delete(d.taskId);
  panel.innerHTML=`<h3>代码差异与交接检查</h3><p>任务 ${esc(current!.tasks.findIndex(t=>t.id===d.taskId)+1)} · ${esc(d.status==='completed'?'待验收':statuses[d.status] ?? d.status)}</p><p>${esc(d.error ?? d.handoff?.report.error ?? '')}</p><p>输入版本：${esc(d.inputCommit ?? '未知')}<br>冻结交付：${esc(d.deliveryCommit ?? '尚未冻结')}</p>${d.inspection ? `<p>变更文件：${esc(d.inspection.files.join('、') || '无代码变更')}</p><pre>${esc(d.inspection.preview)}</pre>${d.inspection.previewTruncated?'<p>预览已截断，请同时检查本地完整差异。</p>':''}` : ''}${d.status==='completed'?`<p>核对代码、运行结果与验收证据后，通过验收会冻结当前 Git 内容并允许后续步骤取得该版本。</p><button class="outline-button" data-coord-accept="${esc(d.taskId)}" ${d.inspection?.fingerprint?'':'disabled'}>通过验收</button>`:''}${d.status==='accepted' && !d.deliveryCommit?`<button class="outline-button" data-freeze-delivery="${esc(d.taskId)}" ${d.inspection?.fingerprint?'':'disabled'}>冻结已审查的历史交付</button>`:''}`;
  $('#coord-tasks').parentElement!.after(panel);
  panel.querySelector('h3')!.insertAdjacentHTML('afterend',`<p>工作区：${esc(d.workspacePath ?? '尚未创建')}</p>`);
  if(d.sourceHead) panel.querySelector('p')!.insertAdjacentHTML('afterend',`<p>源基线：${esc(d.sourceHead)}</p>`);
  if(['queued','failed','cancelled','unknown','needs_revision','blocked'].includes(d.status)) {
    const task=current!.tasks.find(t=>t.id===d.taskId)!;
    const dependenciesAccepted=current!.dependencies.filter(dep=>dep.task_id===d.taskId).every(dep=>current!.tasks.some(t=>t.id===dep.depends_on_id && t.status==='accepted'));
    panel.insertAdjacentHTML('beforeend',recoveryForm(d,task,snapshot.employees,dependenciesAccepted));
  }
}
root.addEventListener('submit',event=>{const form=event.target as HTMLFormElement;if(form.id!=='coord-recovery')return;event.preventDefault();void action(async()=>{const d=inspectedDelivery!;const original=current!;const project=projectId;const values=new FormData(form);const result=await api<{failure:string|null}>(`/api/tasks/${d.taskId}/recovery`,{revision:original.revision,runId:d.latestRun?.id ?? null,fingerprint:d.recoveryFingerprint,reviewed:values.has('reviewed'),confirmedStopped:values.has('confirmedStopped'),employeeId:values.get('employeeId')});if(project===projectId && original.id===sessionId)root.querySelector('#coord-delivery-panel')?.remove();if(result.failure)throw new Error(result.failure);});});
root.addEventListener('click',event=>{const el=(event.target as Element).closest<HTMLElement>('button[data-remove],button[data-coord-accept],button[data-coord-reject],button[data-delivery],button[data-freeze-delivery]');if(!el || !root.contains(el))return;
  if(el.dataset.remove!==undefined){draft=readDraft();const n=Number(el.dataset.remove);draft.splice(n,1);draft=draft.map(s=>({...s,dependsOn:s.dependsOn.filter(d=>d!==n).map(d=>d>n?d-1:d)}));renderPlan();}
  if(el.dataset.delivery)void action(async()=>{const id=el.dataset.delivery!;const originProject=projectId;const originSession=sessionId;const d=await api<Delivery>(`/api/tasks/${id}/delivery`);if(projectId===originProject && sessionId===originSession)renderDelivery(d);});
  if(el.dataset.freezeDelivery)void action(async()=>{const id=el.dataset.freezeDelivery!;const originProject=projectId;const originSession=sessionId;await api(`/api/tasks/${id}/delivery`,{fingerprint:deliveryFingerprints.get(id)});if(projectId===originProject && sessionId===originSession)root.querySelector('#coord-delivery-panel')?.remove();});
  if(el.dataset.coordAccept || el.dataset.coordReject)void action(async()=>{const id=el.dataset.coordAccept ?? el.dataset.coordReject!;const originProject=projectId;const originSession=sessionId;await api(`/api/tasks/${id}/review`,{accepted:!!el.dataset.coordAccept,fingerprint:el.dataset.coordAccept?deliveryFingerprints.get(id):undefined});if(projectId===originProject && sessionId===originSession)root.querySelector('#coord-delivery-panel')?.remove();deliveryFingerprints.delete(id);});
});
$('#coord-history').insertAdjacentHTML('beforeend','<button type="button" id="coord-history-earlier" class="outline-button" hidden>查看更早的 200 条记录</button>');
$('#coord-history').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const at=new FormData(event.target as HTMLFormElement).get('at');const id=sessionId;const result=await api<{previousAt:number|null}>(`/api/coordination/sessions/${id}/timeline${at?`?at=${encodeURIComponent(String(at))}`:''}`);if(id!==sessionId)return;$('#coord-history-output').textContent=JSON.stringify(result,null,2);const button=$<HTMLButtonElement>('#coord-history-earlier');button.hidden=!Number.isSafeInteger(result.previousAt);button.dataset.at=String(result.previousAt);});});
$('#coord-history-earlier').addEventListener('click',()=>{($<HTMLFormElement>('#coord-history').elements.namedItem('at') as HTMLInputElement).value=$('#coord-history-earlier').dataset.at??'';$<HTMLFormElement>('#coord-history').requestSubmit();});
$('#coord-search').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{const q=new FormData(event.target as HTMLFormElement).get('q');$('#coord-history-output').textContent=JSON.stringify(await api(`/api/coordination/memory?projectId=${projectId}&q=${encodeURIComponent(String(q))}`),null,2);});});

// Model form uses the same state/payload functions as its regression tests.
const modelForm=$<HTMLFormElement>('#coord-model');
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
  const signatureTest=JSON.stringify([projectId,modelDraft(),savedSettings]);
  if(signatureTest!==testSignature){testSignature=signatureTest;$('#model-test-status').textContent='';$<HTMLInputElement>('#model-test-approved').checked=false;}
  $<HTMLButtonElement>('#model-test').disabled=!modelReady || !projectId || testPending;
  $<HTMLButtonElement>('#coord-model button').disabled=!modelReady || testPending;
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
$('#model-test').addEventListener('click',async()=>{
  if(testPending)return;
  const status=$('#model-test-status');
  try{
    const request=connectionTestRequest(modelDraft(),providers,savedSettings,modelReady,projectId,$<HTMLInputElement>('#model-test-approved').checked);
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

document.querySelector('#page-missions')!.insertAdjacentHTML('beforeend', `<section class="surface-card coord-section"><h3>接入自定义 CLI</h3><p class="coord-muted">适用于提供非交互 CLI 的 Agent。通过标准输入接收任务，通过标准输出返回结果；注册后可在运行时列表中添加员工。</p><p class="coord-muted">Pi、Codex、Claude Code、Gemini、OpenCode、Kimi 已内置支持，请直接点击上方“注册员工”选择运行时，无需在此注册。不可用时请检查对应 CLI 的安装和路径，再点击“重新扫描”。这些 CLI 均为可选，ApiX 自身通过模型 API 独立运行。</p><form id="adapter-form" class="stacked-form"><label>适配器 ID<input name="id" required maxlength="50" pattern="[a-z][a-z0-9\\-]*" aria-describedby="adapter-id-help" title="以小写英文字母开头，只能包含小写字母、数字和连字符（-），最多 50 字符" placeholder="qoder-cli"></label><p id="adapter-id-help" class="coord-muted">例如 qoder-cli；仅使用小写字母、数字和连字符，以小写字母开头。pi、codex、claude、gemini、opencode、kimi 为内置保留 ID。</p><label>名称<input name="name" required placeholder="Qoder CLI"></label><label>可执行文件绝对路径<input name="executable" required placeholder="C:\\Program Files\\nodejs\\node.exe"></label><label>启动参数（JSON 字符串数组）<input name="args" required value="[]"></label><label>输出格式<select name="format"><option value="plain">纯文本</option><option value="jsonl">JSONL 事件</option></select></label><button class="outline-button">注册适配器</button><p id="adapter-notice" role="status"></p></form></section>`);
document.querySelector('#adapter-form')!.addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.target as HTMLFormElement; const output=document.querySelector('#adapter-notice')!;
  try {const values=Object.fromEntries(new FormData(form)); await api('/api/adapters',{...values,args:JSON.parse(String(values.args))}); output.textContent='适配器已注册，可以在运行时列表注册员工。';}catch(e){output.textContent=String(e instanceof Error ? e.message : e);}
});
document.addEventListener('apix:manager-settings',()=>{ toggleInspector(true);const panel=$<HTMLDetailsElement>('.coord-settings'); panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'center'});$<HTMLInputElement>('#coord-model [name="provider"]').focus(); });
