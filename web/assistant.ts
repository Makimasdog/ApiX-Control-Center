import {interactionForm,type RuntimeInteraction} from './runtime-interaction-form.js';
import {mountPersonalMemory} from './personal-memory.js';
import {tokenUsageView} from './token-usage-view.js';
import {readAttachments} from './assistant-media.js';
import {html} from './html.js';
import {deliveryView} from './delivery-view.js';
import {conversationModelPicker} from './conversation-model.js';
import {assistantTimeline,approvalLabel,toolResultSucceeded} from './assistant-view.js';
import {mountCollaborationScene,type CollaborationActivity,type CollaborationSpeech} from './collaboration-scene.js';
type Pending={id:string;kind:string;question:string;tool?:string;toolDescription?:string;toolVersion?:string;args?:unknown;options?:string[];multiple?:boolean};
type ChildAttention={childSessionId:string;reason:string;taskId:string|null;fingerprint?:string|null;title?:string;unlinked?:boolean;canResume?:boolean;autoRepair?:boolean;employeeId?:string|null};
type Session={modelConfigurationBlocked?:boolean;childAttention?:ChildAttention|null;promptStrategy?:'legacy'|'stable-prefix-v1';promptSettingsVersion?:number;generation?:string|null;message_channel?:'wechat'|'telegram'|'discord'|null;optimizationMode?:'standard'|'saving';task_id?:string|null;limits?:{maxCalls:number};review?:any;capabilities?:{managedCommands:{available:boolean;reason:string|null}};verificationStatus?:string;acceptanceStatus?:string;id:string;project_id:string;title:string;status:string;version:number;steps:number;summary:string;child_session_id:string|null;busy:boolean;pending:Pending|null;workerInteractions?:RuntimeInteraction[];previousEventId:number|null;events:{id:number;role:string;kind:string;body:Record<string,unknown>}[];notes:{title:string;content:string;source:string;version:number;kind:string;status:string}[];policy:{mode:string;version:number}};
const root=document.querySelector<HTMLElement>('#page-assistant')!;
root.innerHTML=html`<div class="assistant-workspace"><section class="assistant-main"><header class="assistant-header"><div class="assistant-header-context"><button id="assistant-menu" type="button" class="icon-button" aria-label="打开导航" aria-controls="main-navigation"><svg class="icon" aria-hidden="true"><use href="#icon-grid"/></svg></button><strong id="assistant-project">ApiX</strong><span id="assistant-status" class="assistant-status"><i class="assistant-status-dot" data-status="idle" aria-hidden="true"></i><span id="assistant-status-text">等待消息</span></span></div><div class="assistant-header-actions"><button id="assistant-personal-memory" class="text-action" aria-haspopup="dialog">个人记忆</button><button id="assistant-details" class="text-action" aria-expanded="false" aria-controls="assistant-inspector">详情</button><button id="assistant-advanced" class="text-action" hidden>协作进度</button><button id="assistant-config" class="text-action" hidden>协作设置</button><button id="assistant-new" class="outline-button" hidden>新对话</button></div></header><section class="assistant-team" aria-label="协作工作台"><details id="assistant-team-details" class="assistant-team-details"><summary><strong>协作工作台</strong><small id="assistant-team-summary">尚未委派员工任务</small></summary><div class="assistant-team-body"><p class="assistant-team-note">主会话统筹目标，员工过程与成果在此汇合。</p><div id="assistant-workers"><p class="assistant-team-empty">尚未委派员工任务。向 ApiX 描述目标后，可在这里跟进参与员工。</p></div><div class="assistant-team-foot"><button class="text-action" id="assistant-employees">管理员工</button></div></div></details></section><div id="assistant-transcript" class="assistant-transcript" aria-live="polite"><div class="assistant-welcome"><span>ApiX</span><h1>今天想完成什么？</h1><p>直接描述目标。我会选择工具、加载 Skill，或协调本机 Agent，检查结果后继续推进。</p></div></div><div id="assistant-thinking" class="assistant-thinking" hidden aria-live="polite"><span class="thinking-caret" aria-hidden="true"></span><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="thinking-label" data-thinking-label>正在思考</span><span class="thinking-elapsed" data-thinking-elapsed></span></div><p id="assistant-error" role="alert"></p><div class="assistant-compose-wrap"><div id="assistant-pending"></div><section id="assistant-worker-interactions" aria-label="员工等待你的决定" hidden></section><div class="assistant-resume-bar" id="assistant-resume-bar" hidden><span id="assistant-resume-status"></span><button id="assistant-resume" type="button" class="outline-button">检查后继续</button></div><form id="assistant-form" class="assistant-composer"><textarea id="assistant-input" rows="3" maxlength="10000" placeholder="向 ApiX 描述任务，也可以在执行中补充要求…" aria-label="给 ApiX 的消息"></textarea><div class="assistant-media-controls"><label>添加附件<input id="assistant-attachments" type="file" multiple aria-label="添加附件"></label><label><input id="assistant-markdown" type="checkbox">Markdown</label></div><div class="assistant-compose-toolbar">
  <div class="assistant-compose-mode">
    <label class="assistant-mode"><select id="assistant-execution-mode" aria-label="执行方式" aria-describedby="assistant-mode-hint">
      <option value="full_access">自动执行</option><option value="ask_approval">逐次确认</option><option value="read_only">只读</option>
    </select></label>
    <output id="assistant-mode-risk" class="assistant-mode-risk" data-risk="medium" aria-live="polite">逐次确认</output>
    <button id="assistant-stop" type="button" class="text-action" hidden>停止</button>
  </div>
  <div class="assistant-compose-actions">
    <div id="assistant-model"><button type="button" class="outline-button" data-choose-conversation-model>模型与思考强度</button></div>
    <button type="submit" class="send-button" aria-label="发送给 ApiX"><svg class="icon" aria-hidden="true"><use href="#icon-send"/></svg><span aria-hidden="true">…</span></button>
  </div>
</div>
</form><small id="assistant-mode-hint">自动执行可修改文件、运行命令和测试，可能产生模型费用。</small><p id="assistant-channel-hint" hidden>此对话来自外部渠道，请通过原渠道继续。</p></div></section><aside id="assistant-inspector" class="assistant-inspector"><h2>工作详情</h2><section><h3>Node/npm 项目接入</h3><button id="npm-diagnose" type="button" class="outline-button">只读诊断项目</button><div id="npm-diagnosis"></div><form id="npm-proposal"><label>允许修改的源码路径（逗号分隔）<input name="paths" value="src" maxlength="1000" required></label><label><input name="network" type="checkbox">批准 npm 公共仓库下载（不包含安装脚本或模型费用）</label><button type="submit" class="outline-button">生成准备与检查方案</button></form><div id="npm-plan"></div></section><p id="assistant-inspect-status">选择项目后开始对话。</p><section><h3>工具与员工</h3><div id="assistant-activity"></div><div id="assistant-child"></div></section><section><h3>本任务交付</h3><div id="assistant-delivery"></div><details><summary>开始下一任务</summary><form id="assistant-task-form"><input name="description" maxlength="4000" placeholder="下一任务目标" aria-label="下一任务目标" required><button type="submit" class="outline-button">开始下一任务并发送</button></form></details></section><section><h3>Token 用量与优化</h3><button id="assistant-usage-refresh" type="button" class="outline-button">刷新任务用量</button><div id="assistant-usage" aria-live="polite">选择对话后查看任务用量。</div><form id="assistant-optimization"><label>上下文模式<select name="mode"><option value="standard">标准</option><option value="saving">节省</option></select></label><label id="assistant-prompt-strategy" hidden>输入布局<select name="promptStrategy"><option value="legacy">现有布局</option><option value="stable-prefix-v1">稳定布局（试验）</option></select></label><button type="submit" class="outline-button">应用模式</button><small>节省模式按需加载工具参数并折叠较旧结果；完整记录可回读。空闲且安全状态已确认时可修改。</small></form><p id="assistant-optimization-status" role="status"></p></section><section><h3>上下文占用</h3><button id="assistant-context-refresh" type="button" class="outline-button">查看上下文占用</button><div id="assistant-budget" aria-live="polite"></div><form id="assistant-compact"><label>压缩时重点保留<textarea name="focus" maxlength="2000" placeholder="例如：验收标准、未完成事项和文件引用"></textarea></label><button type="submit" class="outline-button">压缩历史</button><small>调用当前模型，按现有费用预算执行；原始记录保留。</small></form></section><section><h3>工作摘要</h3><pre id="assistant-context">暂无压缩摘要；原始记录持续保存。</pre></section><section><h3>项目记忆</h3><div id="assistant-notes"></div><details><summary>添加或修改记忆</summary><form id="assistant-memory"><input name="title" placeholder="记忆标题" maxlength="120" required aria-label="记忆标题"><textarea name="content" placeholder="项目约定或偏好" maxlength="3000" required aria-label="记忆内容"></textarea><button type="submit" class="outline-button">保存记忆</button></form></details></section></aside></div><dialog id="assistant-dialog" class="assistant-dialog" aria-labelledby="assistant-question"><form id="assistant-request"><h2 id="assistant-question"></h2><div id="assistant-options"></div><p id="assistant-request-error" role="alert"></p><textarea id="assistant-choice-text" maxlength="4000" placeholder="也可以补充说明" aria-label="补充回答"></textarea><div class="assistant-request-actions"><button id="assistant-request-dismiss" type="button" class="text-action">稍后处理</button><button id="assistant-deny" type="button" class="outline-button">拒绝</button><button id="assistant-approve" type="submit" class="primary-button">提交选择</button></div></form></dialog>`;
const $=<T extends HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
const collaborationHost=document.createElement('div');
collaborationHost.className='collaboration-scene';
collaborationHost.hidden=true;
$('#assistant-workers').before(collaborationHost);
const updateCollaboration=mountCollaborationScene(collaborationHost);
const updateModel=conversationModelPicker(root.querySelector<HTMLElement>('#assistant-model')!, true);
let projectId='',current:Session|null=null,threadId='',active=false,loading=false,generation=0,lastRender='',lastRequest='',lastChildAttention='',posting=false;
let olderEvents:Session['events']=[],olderCursor:number|null|undefined,notesSignature='';
let collaborationSpeech:CollaborationSpeech[]=[];
let modeProject='',modeDirty=false,contextGeneration=0;
const executionMode=$<HTMLSelectElement>('#assistant-execution-mode');
// 风险等级只由执行方式决定，随下拉框实时更新；颜色在 CSS 里按 data-risk 取值。
const executionRisks:Record<string,[string,string]>={read_only:['low','只读'],ask_approval:['medium','逐次确认'],full_access:['high','自动执行 · 可改文件']};
function showExecutionRisk(){
  const [risk,label]=executionRisks[executionMode.value]??executionRisks.ask_approval!;
  const badge=$('#assistant-mode-risk');
  badge.dataset.risk=risk;
  badge.textContent=label;
}
executionMode.value='ask_approval';
showExecutionRisk();
$('#assistant-execution-mode').addEventListener('change',()=>{modeDirty=true;showExecutionRisk();});
let projectName='ApiX';
const teamDetails=$<HTMLDetailsElement>('#assistant-team-details'),teamSummary=$('#assistant-team-summary');
// 用户手动收起后轮询不得再自动展开；仅在再次回到“无员工”状态时重置该标记。
let teamUserClosed=false,teamExpectedOpen=false;
teamDetails.addEventListener('toggle',()=>{if(teamDetails.open!==teamExpectedOpen){teamExpectedOpen=teamDetails.open;if(!teamDetails.open)teamUserClosed=true;}});
function setTeamOpen(open:boolean){teamExpectedOpen=open;if(teamDetails.open!==open)teamDetails.open=open;}
function setStatus(text:string,status:string){$('#assistant-status-text').textContent=text;root.querySelector<HTMLElement>('.assistant-status-dot')!.dataset.status=status;}
$('#assistant-menu').addEventListener('click',()=>document.querySelector<HTMLButtonElement>('#navigation-toggle')?.click());
let stopRequestPending=false;
let reviewSignature='' ;
type AssistantDestination={id:string;delivery?:boolean;approval?:boolean;interactionId?:string};
let destination:AssistantDestination|undefined;
const drafts=new Map<string,string>();const draftKey=()=>projectId+':'+threadId;
const messageRequests=new Map<string,{key:string;content:string;requestId:string}>();
function setPosting(value:boolean){
  posting=value;
  const form=$<HTMLFormElement>('#assistant-form'),send=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  form.setAttribute('aria-busy',String(value));
  send.disabled=value;
  $<HTMLInputElement>('#assistant-attachments').disabled=value;
  $<HTMLInputElement>('#assistant-markdown').disabled=value;
  send.setAttribute('aria-label',value?'正在发送给 ApiX':'发送给 ApiX');
  $<HTMLButtonElement>('#assistant-new').disabled=value;
}
async function api<T>(path:string,body?:unknown):Promise<T>{const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error??'请求失败');return value as T;}
mountPersonalMemory(root,api,()=>current?.id);
function error(value:unknown){$('#assistant-error').textContent=value instanceof Error?value.message:String(value);}
function showWorkerInteractions(s:Session){
  const box=$('#assistant-worker-interactions'),items=s.workerInteractions??[];
  const mounted=new Map([...box.querySelectorAll<HTMLFormElement>('[data-interaction]')].map(form=>[form.dataset.interaction,form]));
  const activeIds=new Set(items.map(item=>item.id));
  for(const [id,form] of mounted)if(!id||!activeIds.has(id))form.remove();
  const version=generation;
  for(const item of items)if(!mounted.has(item.id)){
    box.append(interactionForm(item,api,()=>void refresh(),value=>{
      if(version===generation&&current?.id===s.id)error(value);
    }));
  }
  box.hidden=!items.length;
}
const renderedEventIds=new Set<number>();let renderedSession='';
function renderTranscript(s:Session){
  const events=[...new Map([...olderEvents,...s.events].map(event=>[event.id,event])).values()].sort((first,second)=>first.id-second.id);
  const cursor=olderCursor===undefined?s.previousEventId:olderCursor;
  const signature=JSON.stringify([events,collaborationSpeech,cursor]);
  const box=$('#assistant-transcript'),selection=window.getSelection();
  if(signature===lastRender||selection&&!selection.isCollapsed&&box.contains(selection.anchorNode))return;
  const nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<100;
  const openRecords=new Set(renderedSession===s.id?[...box.querySelectorAll<HTMLDetailsElement>('details[data-execution-record][open]')].map(node=>node.dataset.executionRecord):[]);
  if(renderedSession!==s.id){renderedSession=s.id;renderedEventIds.clear();}
  box.innerHTML=(cursor?'<button class="text-action" id="assistant-load-older">加载更早记录</button>':'')+assistantTimeline(events,collaborationSpeech,s.id);
  for(const node of box.querySelectorAll<HTMLDetailsElement>('details[data-execution-record]'))node.open=openRecords.has(node.dataset.executionRecord);
  // 只给本轮新到达的消息加入场动画；整段 innerHTML 每次刷新都是新节点，因此必须按事件 id 判定。
  for(const node of box.querySelectorAll<HTMLElement>('[data-event-id]')){
    const id=Number(node.dataset.eventId);
    if(!renderedEventIds.has(id))node.classList.add('is-new');
    renderedEventIds.add(id);
  }
  lastRender=signature;
  if(nearBottom)box.scrollTop=box.scrollHeight;
}
const thinkingPhases:Record<string,string>={running:'正在思考并调用工具',waiting_agents:'等待员工执行与验收',waiting_user:'需要你的决定'};
let thinkingSince=0;
function setThinking(busy:boolean,status?:string|null,tool?:string){
  const box=root.querySelector<HTMLElement>('#assistant-thinking');
  if(!box)return;
  if(!busy){box.hidden=true;thinkingSince=0;return;}
  const label=box.querySelector<HTMLElement>('[data-thinking-label]');
  if(label)label.textContent=tool?`正在调用 ${tool}`:thinkingPhases[status??'']??'正在处理';
  const dots=box.querySelector<HTMLElement>('.thinking-dots');
  if(dots)dots.hidden=status!=='waiting_agents';
  box.dataset.phase=status??'';
  if(box.hidden){box.hidden=false;thinkingSince=Date.now();}
}
setInterval(()=>{
  const box=root.querySelector<HTMLElement>('#assistant-thinking');
  if(!box||box.hidden||!thinkingSince)return;
  const node=box.querySelector<HTMLElement>('[data-thinking-elapsed]');
  if(node)node.textContent='· '+Math.max(1,Math.round((Date.now()-thinkingSince)/1000))+'s';
},1000);
function render(s:Session){
  if(current?.id!==s.id)collaborationSpeech=[];
  const pendingMessage=messageRequests.get(s.id);
  if(pendingMessage&&s.events.some(e=>e.role==='user'&&e.kind==='message'&&e.body.requestId===pendingMessage.requestId)){
    messageRequests.delete(s.id);$('#assistant-error').textContent='';
    const input=$<HTMLTextAreaElement>('#assistant-input');if(input.value.trim()===pendingMessage.content)input.value='';
  }
  const sessionBusy=Boolean(s.busy||['running','waiting_agents','waiting_user'].includes(s.status));
  updateModel('assistant',s.id,sessionBusy);
  const lastEvent=s.events.at(-1);
  const runningTool=lastEvent?.kind==='tool_started'?String(lastEvent.body.tool??''):'';
  setThinking(sessionBusy,s.status,runningTool);
  $('#assistant-transcript').dataset.busy=String(sessionBusy);
  if(active&&current?.id!==s.id)document.dispatchEvent(new CustomEvent('apix:thread-selected',{detail:{id:s.id,kind:'assistant'}}));
  if(current?.id!==s.id||current?.promptStrategy!==s.promptStrategy){$('#assistant-prompt-strategy').hidden=s.promptSettingsVersion===undefined;$<HTMLSelectElement>('#assistant-optimization [name=promptStrategy]').value=s.promptStrategy??'legacy';}if(current?.id!==s.id){$('#assistant-usage').textContent='点击刷新任务用量查看当前任务。';$('#assistant-optimization-status').textContent='';$<HTMLSelectElement>('#assistant-optimization [name=mode]').value=s.optimizationMode??'standard';}if(current?.optimizationMode!==s.optimizationMode)$<HTMLSelectElement>('#assistant-optimization [name=mode]').value=s.optimizationMode??'standard';if(current&&current.id!==s.id){olderEvents=[];olderCursor=undefined;notesSignature='';}
  if(modeProject!==s.project_id){modeProject=s.project_id;}if(!modeDirty){executionMode.value=s.policy.mode;showExecutionRisk();}
  if(current?.task_id!==s.task_id)$('#assistant-usage').textContent='任务已切换，请刷新任务用量。';current=s;threadId=s.id;root.classList.toggle('assistant-external-session',Boolean(s.message_channel));$('#assistant-channel-hint').hidden=!s.message_channel;localStorage.setItem('apix.assistant.'+projectId,s.id);setStatus(({idle:'等待消息',running:'正在执行',waiting_user:'需要你的决定',waiting_agents:'员工执行与验收中',completed:'本轮完成',attention:'需要检查',stopped:'已停止'} as Record<string,string>)[s.status]??s.status,s.status);
  $('#assistant-project').textContent=s.title?.trim()||projectName;
  $('#assistant-inspect-status').textContent=`${({verified:s.acceptanceStatus==='accepted'?'可信检查通过 · 当前交付已验收':'可信检查通过 · 尚未正式验收',needs_review:'未验证 · 待审查',unverified:'尚缺可信检查',failed:'可信检查失败',unknown:'检查结果未知',not_required:'本轮无需代码验证'} as Record<string,string>)[s.verificationStatus??'']??'未验证'} · 本轮 ${s.steps}/${s.limits?.maxCalls??24} 步 · ${s.policy.mode==='full_access'?'项目完全访问':s.policy.mode==='read_only'?'只读':'按次批准'}`;
  if(s.capabilities?.managedCommands.available===false)$('#assistant-inspect-status').textContent+=' · '+s.capabilities.managedCommands.reason;
  const reviewKey=JSON.stringify([s.id,s.review,s.busy,s.version]);if(reviewSignature!==reviewKey){const previousDelivery=root.querySelector<HTMLElement>('[data-reviewed-delivery]')?.dataset.reviewedDelivery;const draft=root.querySelector<HTMLTextAreaElement>('#delivery-feedback')?.value??'';root.querySelector<HTMLElement>('#assistant-delivery')!.innerHTML=deliveryView(s.review,s.busy);const field=root.querySelector<HTMLTextAreaElement>('#delivery-feedback');if(field&&previousDelivery===s.review?.latestDelivery?.id)field.value=draft;reviewSignature=reviewKey;}
  renderTranscript(s);
  $('#assistant-context').textContent=s.summary||'暂无压缩摘要；原始记录持续保存。';
  $('#assistant-activity').innerHTML=s.events.filter(e=>['tool_started','tool_result'].includes(e.kind)).slice(-10).map(e=>html`<div class="assistant-tool-row ${e.kind==='tool_result'&&!toolResultSucceeded(e.body)?'failed':''}"><span>${e.kind==='tool_started'?'↗':toolResultSucceeded(e.body)?'✓':'!'}</span>${e.body.tool}</div>`).join('')||'<p>工具调用会显示在这里。</p>';
  const childId=s.child_session_id??s.events.filter(e=>e.kind==='delegation_result').at(-1)?.body.id;
  void showWorkers(s,typeof childId==='string'?childId:null);
  $('#assistant-child').innerHTML=childId?html`<p>已关联子流程</p><code>${childId}</code><button class="text-action" data-child-goal="${childId}">查看契约与验收</button>`:'';
  if(notesSignature!==JSON.stringify(s.notes)){notesSignature=JSON.stringify(s.notes);$('#assistant-notes').innerHTML=s.notes.map(n=>html`<details><summary>${n.title} <small>${n.source==='user'?'你':'ApiX'} · ${n.kind} · ${n.status==='candidate'?'待确认':'已确认'}</small></summary><p>${n.content}</p>` + (n.status==='candidate'?html`<button type="button" class="text-action" data-approve-note="${n.title}" data-version="${n.version}">确认并用于后续召回</button>`:'') + html`<button type="button" class="text-action" data-delete-note="${n.title}" data-version="${n.version}">删除</button></details>`).join('')||'<p>跨对话共享的项目笔记，随时可查看和修改。</p>';}
  $<HTMLButtonElement>('#assistant-approve').disabled=!!s.pending&&s.busy;
  $<HTMLButtonElement>('#assistant-deny').disabled=!!s.pending&&s.busy;
  showWorkerInteractions(s);
  const attention=s.childAttention;
  const attentionKey=attention?JSON.stringify([attention.childSessionId,attention.reason,attention.taskId]):'';
  const attentionDialog=$<HTMLDialogElement>('#assistant-dialog');
  if(s.pending&&attentionDialog.dataset.attentionChild)closeAttentionDialog();
  if(active&&attention&&!s.pending&&attentionKey!==lastChildAttention){
    lastChildAttention=attentionKey;
    void api<Record<string,unknown>>('/api/coordination/sessions/'+encodeURIComponent(attention.childSessionId))
      .then(child=>openChildAttention(s,attention,child))
      .catch(value=>error(value));
  }else if(!attention)lastChildAttention='';
  const pendingBox=$('#assistant-pending');
  const pendingId=s.pending?.id??(s.modelConfigurationBlocked?'model-config':s.childAttention?`child:${s.childAttention.childSessionId}`:'');
  if((pendingBox.dataset.request??'')!==pendingId||(pendingId&&!pendingBox.childElementCount)){
    pendingBox.dataset.request=pendingId;
    pendingBox.innerHTML=s.pending?html`<button id="assistant-open-request" type="button" class="outline-button">${s.pending.kind==='approval'?'操作待批准 · 查看详情':s.pending.kind==='intent'?'查看候选答案':'需要你的决定 · 查看并回答'}</button>`:s.childAttention?html`<button id="assistant-open-child-attention" type="button" class="outline-button">${s.childAttention.unlinked?'协作流程等待确认':'员工流程需要确认'} · 查看原因</button>`:s.modelConfigurationBlocked?'<span>对话已保留。更新模型配置后可直接重试。 </span><button id="assistant-retry-model" type="button" class="outline-button">重试本轮</button>':'';
  }
  $<HTMLTextAreaElement>('#assistant-input').placeholder=s.pending?.kind==='intent'?'直接回复上方的问题，ApiX 会继续处理…':'向 ApiX 描述任务，也可以在执行中补充要求…';
  if(s.modelConfigurationBlocked)setStatus('模型连接需要配置','attention');
  const paused=['attention','stopped'].includes(s.status);
  $('#assistant-resume-bar').hidden=!paused;
  $('#assistant-resume-status').textContent=s.modelConfigurationBlocked?'模型连接需要配置':s.status==='stopped'?'任务已停止':'任务需要检查';
  $('#assistant-resume').textContent=s.modelConfigurationBlocked?'配置模型':'检查并继续';
  $('#assistant-stop').hidden=!['running','waiting_agents','waiting_user'].includes(s.status);
  updateStopButton();
  const target=active&&destination?.id===s.id?destination:undefined;
  if(s.pending&&s.pending.id!==lastRequest&&active){lastRequest=s.pending.id;if(!target?.interactionId&&s.pending.kind==='choice')openRequest();}
  else if(!s.pending&&(!s.childAttention||!active))$<HTMLDialogElement>('#assistant-dialog').close();
  if(target){
    destination=undefined;
    if(target.approval&&s.pending?.kind==='approval')openRequest();
    if(target.delivery){
      if(!root.classList.contains('show-inspector'))$('#assistant-details').click();
      $('#assistant-delivery').scrollIntoView({block:'start'});
    }
    if(target.interactionId){
      $<HTMLDialogElement>('#assistant-dialog').close();
      const card=[...$('#assistant-worker-interactions').querySelectorAll<HTMLFormElement>('[data-interaction]')]
        .find(form=>form.dataset.interaction===target.interactionId);
      if(card){
        card.tabIndex=-1;
        card.scrollIntoView({block:'nearest'});
        card.focus({preventScroll:true});
      }else error('该员工请求已处理或失效。');
    }
  }
}
function clearAttentionDialog(){const dialog=$<HTMLDialogElement>('#assistant-dialog');delete dialog.dataset.attentionChild;delete dialog.dataset.attentionSession;delete dialog.dataset.attentionCanResume;delete dialog.dataset.attentionStopConfirmed;delete dialog.dataset.attentionAutoRepair;}
function closeAttentionDialog(){const dialog=$<HTMLDialogElement>('#assistant-dialog');dialog.close();clearAttentionDialog();}
function openRequest(){const p=current?.pending;if(!p)return;clearAttentionDialog();$('#assistant-request-error').textContent='';$('#assistant-question').textContent=(p.kind==='intent'?'确认你的意图 · ':'')+p.question;
  $('#assistant-options').innerHTML=p.kind==='approval'?html`<strong>${p.toolDescription??p.tool}</strong><small>${p.tool} ${p.toolVersion??''}</small><pre>${JSON.stringify(p.args,null,2)}</pre>`:(p.options??[]).map((option,i)=>html`<label><input type="${p.multiple?'checkbox':'radio'}" name="choice" value="${i}"><span>${option}</span></label>`).join('');
  $<HTMLTextAreaElement>('#assistant-choice-text').value='';$('#assistant-choice-text').hidden=p.kind==='approval';$('#assistant-deny').hidden=p.kind!=='approval';$('#assistant-approve').textContent=approvalLabel(p.kind,p.tool);const dialog=$<HTMLDialogElement>('#assistant-dialog');if(!dialog.open)dialog.showModal();
}
function openChildAttention(s:Session,attention:ChildAttention,child:Record<string,unknown>){
  if(!active||current?.id!==s.id||current.pending||current.childAttention?.childSessionId!==attention.childSessionId||current.childAttention.taskId!==attention.taskId)return;
  const dialog=$<HTMLDialogElement>('#assistant-dialog');
  const childAutonomy=(child.autonomy??{}) as {state?:string};
  const canResume=attention.canResume??(childAutonomy.state==='attention'||['attention','stopped'].includes(s.status));
  $('#assistant-request-error').textContent='';
  $('#assistant-question').textContent=attention.unlinked?'协作流程等待你的确认':'员工流程需要你的确认';
  const tasks=Array.isArray(child.tasks)?child.tasks as {id?:string;status?:string;employee_name?:string}[]:[];
  const task=tasks.find(item=>item.id===attention.taskId)??tasks.find(item=>['failed','blocked','unknown','needs_revision'].includes(String(item.status)));
  $('#assistant-options').innerHTML=(attention.title?html`<strong>${attention.title}</strong>`:'')+html`<p>${attention.reason}</p><small>${task?`${task.employee_name??'员工'} · ${task.status??'需要处理'}`:'ApiX 已暂停自动监督，避免重复运行'} · ${canResume?'详细运行与验收证据保留在协作进度。':'这项异常需要核对运行记录后才能继续。'}</small>`;
  $<HTMLTextAreaElement>('#assistant-choice-text').hidden=true;
  $('#assistant-deny').hidden=!attention.autoRepair&&!canResume;$('#assistant-deny').textContent='查看详细记录';
  $('#assistant-approve').textContent=attention.autoRepair?'交给 ApiX 处理':canResume?'让 ApiX 继续处理':'查看详细记录';
  dialog.dataset.attentionSession=s.id;
  dialog.dataset.attentionChild=attention.childSessionId;
  dialog.dataset.attentionCanResume=canResume?'1':'0';
  if(attention.autoRepair)dialog.dataset.attentionAutoRepair='1';else delete dialog.dataset.attentionAutoRepair;
  delete dialog.dataset.attentionStopConfirmed;
  if(!dialog.open)dialog.showModal();
}
async function refresh(){if(!active||!projectId||loading)return;loading=true;const version=generation,selected=threadId;
  try{const list=await api<{id:string;title:string;status:string}[]>('/api/assistant/sessions?projectId='+encodeURIComponent(projectId));if(version!==generation)return;
    if(!selected&&list.length&&!posting){selectSession(list[0]!.id);return;}
    if(selected){const session=await api<Session>('/api/assistant/sessions/'+selected);if(version===generation&&threadId===selected){if(session.project_id!==projectId){selectSession('');return;}render(session);}}
  }catch(e){if(version===generation){if(e instanceof Error&&e.message.includes('对话不存在或已归档/删除'))selectSession('');else error(e);}}finally{loading=false;if(active&&(version!==generation||selected!==threadId))void refresh();}
}
async function newSession(startFresh=false){
  const version=generation, needsProject=!projectId;
  const s=await api<Session>('/api/assistant/sessions',projectId?{projectId}:{});
  if(version!==generation)throw new Error('对话已切换，请重试');
  if(startFresh)selectSession(s.id,s.project_id);
  if(needsProject){projectId=s.project_id;document.dispatchEvent(new CustomEvent('apix:select-project',{detail:projectId}));}
  render(s);
  return s;
}
function applyCurrent(s:Session){if(s.project_id===projectId&&s.id===threadId)render(s);}
let npmPlan:any=null;
function npmError(e:unknown){npmPlan=null;$('#npm-plan').textContent=e instanceof Error?e.message:String(e);error(e);}
$('#npm-diagnose').addEventListener('click',()=>{if(!current)return;const id=current.id,rev=generation;void api<any>('/api/assistant/sessions/'+id+'/project-diagnosis').then(d=>{if(current?.id!==id||rev!==generation)return;const summary=document.createElement('p');summary.textContent=({needs_approval:'需要批准准备与检查',needs_review:'等待核对',configuration_incomplete:'配置不完整',unsupported:'暂不支持',scan_incomplete:'扫描未完成'} as Record<string,string>)[d.status]??d.status;const pre=document.createElement('pre');pre.textContent=JSON.stringify({blocks:d.blocks,runtime:d.runtime,project:d.project,source:d.source?{files:d.source.files.length,bytes:d.source.bytes,hash:d.source.hash,complete:d.scanComplete}:null,dependencies:d.dependencies,git:d.git,artifacts:d.artifactCandidates?.map((a:any)=>({path:a.path,files:a.items,bytes:a.bytes}))},null,2);$('#npm-diagnosis').replaceChildren(summary,pre);}).catch(error);});
$('#npm-proposal').addEventListener('submit',event=>{event.preventDefault();if(!current)return;const id=current.id,rev=generation,data=new FormData(event.currentTarget as HTMLFormElement);void api<any>('/api/assistant/sessions/'+id+'/npm-proposal',{network:data.has('network'),writablePaths:String(data.get('paths')).split(',').map(p=>p.trim())}).then(c=>{if(current?.id!==id||rev!==generation)return;npmPlan=c;$('#npm-plan').innerHTML=html`<p>在任务副本中 npm ci；关闭安装脚本。按序执行下列全部 pre/main/post 检查；不授予模型费用。项目脚本可访问本机，当前环境不是 OS 沙箱。</p><pre>${JSON.stringify(c,null,2)}</pre><button id="npm-approve" type="button" class="outline-button">批准此版本的准备与全部检查</button>`;}).catch(npmError);});
root.addEventListener('click',event=>{if(!(event.target instanceof Element)||!event.target.closest('#npm-approve')||!current||!npmPlan||posting)return;const s=current,c=npmPlan;setPosting(true);void api<Session>('/api/assistant/sessions/'+s.id+'/npm-approval',{version:s.version,approved:true,contractVersion:c.version,network:c.npm.network,writablePaths:c.writablePaths}).then(next=>{applyCurrent(next);npmPlan=null;$('#npm-plan').textContent='已批准；发送修复目标后，使用现有 run_check 检查和交付审阅。';}).catch(npmError).finally(()=>setPosting(false));});
$('#assistant-task-form').addEventListener('submit',event=>{event.preventDefault();if(!current||posting)return;const s=current,description=String(new FormData(event.currentTarget as HTMLFormElement).get('description')??'');setPosting(true);void api<Session>('/api/assistant/sessions/'+s.id+'/tasks',{version:s.version,description}).then(async next=>{applyCurrent(next);await sendMessage(next,description);await refresh();}).catch(error).finally(()=>setPosting(false));});
async function sendMessage(s:Session,content:string,format='plain',attachments:Awaited<ReturnType<typeof readAttachments>>=[]){
  const version=generation;if(s.project_id!==projectId)throw new Error('项目已切换，请重新发送');
  const mode=executionMode.value;
  if(modeDirty&&s.policy.mode!==mode){const policy=await api<Session['policy']>('/api/permissions',{projectId:s.project_id,subject:'apix',mode,version:s.policy.version});s.policy=policy;modeDirty=false;}
  if(version!==generation||s.project_id!==projectId)throw new Error('项目已切换，消息尚未发送');
  const key=JSON.stringify([content,format,attachments]);
  const previous=messageRequests.get(s.id),pending=previous?.key===key?previous:{key,content,requestId:crypto.randomUUID()};
  messageRequests.set(s.id,pending);
  const result=await api<Session>('/api/assistant/sessions/'+s.id+'/channel-messages',{content,format,attachments,requestId:pending.requestId});
  if(messageRequests.get(s.id)?.requestId===pending.requestId)messageRequests.delete(s.id);
  return result;
}
$('#assistant-form').addEventListener('submit',event=>{event.preventDefault();if(posting)return;void(async()=>{setPosting(true);try{const input=$<HTMLTextAreaElement>('#assistant-input'),content=input.value.trim(),fileInput=$<HTMLInputElement>('#assistant-attachments');const files=Array.from(fileInput.files??[]);if(!content&&!files.length)return;const version=generation,format=$<HTMLInputElement>('#assistant-markdown').checked?'markdown':'plain';const attachments=await readAttachments(files);if(version!==generation)return;const s=current??await newSession();
  if(s.pending?.kind==='intent')await api<Session>('/api/assistant/sessions/'+s.id+'/reply',{version:s.version,requestId:s.pending.id,selected:[],content});
  else await sendMessage(s,content,format,attachments);
  if(version!==generation)return;if(input.value.trim()===content)input.value='';fileInput.value='';$('#assistant-error').textContent='';await refresh();}catch(e){error(e);}finally{setPosting(false);}})();});
$('#assistant-input').addEventListener('keydown',event=>{if(event instanceof KeyboardEvent&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$<HTMLFormElement>('#assistant-form').requestSubmit();}});
$('#assistant-new').addEventListener('click',()=>{if(posting)return;setPosting(true);void newSession(true).then(()=>refresh()).catch(error).finally(()=>setPosting(false));});
function updateStopButton(){
  const stop=$<HTMLButtonElement>('#assistant-stop');
  stop.disabled=stopRequestPending;
  stop.textContent=stopRequestPending?'停止中…':'停止';
}
$('#assistant-stop').addEventListener('click',()=>{
  if(!current||stopRequestPending)return;
  stopRequestPending=true;
  updateStopButton();
  void api<Session>('/api/assistant/sessions/'+current.id+'/stop',{}).then(applyCurrent).catch(error).finally(()=>{
    stopRequestPending=false;
    updateStopButton();
  });
});
$('#assistant-resume').addEventListener('click',()=>{if(current?.modelConfigurationBlocked){openConfiguration();return;}if(current&&window.confirm('请确认已检查工具、员工和验证结果，原命令已停止；继续不会重放未确认的操作。'))void api<Session>('/api/assistant/sessions/'+current.id+'/resume',{version:current.version,confirmed:true}).then(applyCurrent).catch(error);});
function openConfiguration(){document.dispatchEvent(new Event('apix:manager-settings'));}
$('#assistant-details').addEventListener('click',()=>{document.dispatchEvent(new Event('apix:close-agent-run'));const open=root.classList.toggle('show-inspector');$('#assistant-details').setAttribute('aria-expanded',String(open));});
$('#assistant-config').addEventListener('click',openConfiguration);
$('#assistant-advanced').addEventListener('click',()=>{
  const childId=current?.child_session_id??current?.events.filter(e=>e.kind==='delegation_result').at(-1)?.body.id;
  if(typeof childId==='string')document.dispatchEvent(new CustomEvent('apix:open-goal',{detail:childId}));
  else document.querySelector<HTMLButtonElement>('[data-page-target="coordinator"]')?.click();
});
root.addEventListener('click',event=>{const target=event.target;if(!(target instanceof Element))return;
  const historical=target.closest<HTMLButtonElement>('[data-delivery-history]');if(historical&&current){const id=current.id,revision=generation;void api<any>('/api/assistant/sessions/'+id+'/deliveries/'+historical.dataset.deliveryHistory).then(d=>{if(current?.id!==id||generation!==revision)return;const viewer=root.querySelector<HTMLElement>('#delivery-history-view');if(viewer){viewer.innerHTML='<h4>冻结历史版本（只读回看）</h4>'+deliveryView({task:{id:d.taskId,description:d.description},latestDelivery:d},true);viewer.querySelectorAll('button[data-delivery-action],#delivery-continue,label').forEach(element=>element.remove());}}).catch(error);}
  const decision=target.closest<HTMLButtonElement>('[data-delivery-action]');if(decision&&current&&!posting){const s=current;setPosting(true);void api<Session>('/api/assistant/sessions/'+s.id+'/delivery-review',{version:s.version,deliveryId:decision.dataset.deliveryId,deliveryVersion:Number(decision.dataset.deliveryVersion),action:decision.dataset.deliveryAction,requestId:crypto.randomUUID(),comment:root.querySelector<HTMLTextAreaElement>('#delivery-feedback')?.value??''}).then(applyCurrent).catch(error).finally(()=>setPosting(false));}
  if(target.closest('#delivery-continue')&&current&&!posting){const selected=current;setPosting(true);void sendMessage(selected,'请按本任务已保存的修改意见继续，重新检查并提交新的交付版本；沿用现有权限和预算。').then(()=>refresh()).catch(error).finally(()=>setPosting(false));}
  const file=target.closest<HTMLButtonElement>('[data-delivery-file]');if(file&&current){const id=current.id,revision=generation,deliveryId=file.dataset.deliveryId!;file.disabled=true;void api<{text:string|null;detail:string;nextOffset:number|null}>('/api/assistant/sessions/'+id+'/deliveries/'+deliveryId+'/files?version='+file.dataset.deliveryVersion+'&path='+encodeURIComponent(file.dataset.deliveryFile!)+'&side='+file.dataset.side+'&offset='+(file.dataset.offset??0)).then(page=>{if(generation!==revision||current?.id!==id||!root.querySelector('[data-reviewed-delivery="'+deliveryId+'"]'))return;const pre=document.createElement('pre');pre.textContent=page.text??'仅有冻结元数据：'+page.detail;file.after(pre);if(page.nextOffset!==null){const next=file.cloneNode(true) as HTMLButtonElement;next.disabled=false;next.dataset.offset=String(page.nextOffset);next.textContent='继续读取冻结内容';pre.after(next);}}).catch(error).finally(()=>file.disabled=false);}
  if(target.closest('[data-choose-conversation-model]')&&!posting){setPosting(true);void newSession().catch(error).finally(()=>setPosting(false));}
  if(target.closest('#assistant-open-request'))openRequest();
  if(target.closest('#assistant-open-child-attention')&&current?.childAttention){const attention=current.childAttention,s=current;void api<Record<string,unknown>>('/api/coordination/sessions/'+encodeURIComponent(attention.childSessionId)).then(child=>openChildAttention(s,attention,child)).catch(error);}
  if(target.closest('[data-open-child-attention]')&&current?.childAttention){const attention=current.childAttention,s=current;void api<Record<string,unknown>>('/api/coordination/sessions/'+encodeURIComponent(attention.childSessionId)).then(child=>openChildAttention(s,attention,child)).catch(error);}
  if(target.closest('#assistant-retry-model')&&current?.modelConfigurationBlocked&&!posting){setPosting(true);void api<Session>('/api/assistant/sessions/'+current.id+'/resume',{version:current.version,retryModel:true}).then(applyCurrent).catch(error).finally(()=>setPosting(false));}
  const log=target.closest<HTMLButtonElement>('[data-command-log]');if(log&&current){const session=current.id,version=generation,operation=log.dataset.commandLog!,channel=log.dataset.logChannel??'stdout',mode=log.dataset.logMode??'head',offset=log.dataset.logOffset??'0';log.disabled=true;void api<{text:string;nextOffset:number|null;complete:boolean;status:string;reason?:string}>('/api/assistant/sessions/'+session+'/logs/'+encodeURIComponent(operation)+'?channel='+channel+'&mode='+mode+'&offset='+offset).then(page=>{if(generation!==version||current?.id!==session)return;const viewer=document.createElement('section'),label=document.createElement('p'),pre=document.createElement('pre');viewer.className='assistant-log-page';label.textContent=page.status==='recording'?'日志正在采集':page.complete?'已保存日志片段':'日志不完整 / 已过期：'+(page.reason??page.status);pre.textContent=page.text;viewer.append(label,pre);if(page.nextOffset!==null){const next=document.createElement('button');next.type='button';next.className='text-action';next.textContent='继续读取下一页';next.dataset.commandLog=operation;next.dataset.logChannel=channel;next.dataset.logMode=mode;next.dataset.logOffset=String(page.nextOffset);viewer.append(next);}log.after(viewer);}).catch(error).finally(()=>log.disabled=false);}
  const output=target.closest<HTMLButtonElement>('[data-output-reference]');if(output&&current){const id=current.id,offset=output.dataset.outputOffset??'0';output.disabled=true;void api<{text:string;nextOffset:number|null}>('/api/assistant/sessions/'+id+'/outputs/'+encodeURIComponent(output.dataset.outputReference!)+'?offset='+offset).then(page=>{const viewer=document.createElement('div'),pre=document.createElement('pre');pre.textContent=page.text;viewer.append(pre);if(page.nextOffset!==null){const next=document.createElement('button');next.type='button';next.className='text-action';next.textContent='继续读取下一段';next.dataset.outputReference=output.dataset.outputReference;next.dataset.outputOffset=String(page.nextOffset);viewer.append(next);}output.after(viewer);output.hidden=true;}).catch(error).finally(()=>{output.disabled=false;});}
  const child=target.closest<HTMLElement>('[data-child-goal]');if(child)document.dispatchEvent(new CustomEvent('apix:open-goal',{detail:child.dataset.childGoal}));
  if(target.closest('#assistant-load-older')&&current){const id=current.id,version=generation,cursor=olderCursor===undefined?current.previousEventId:olderCursor;const box=$('#assistant-transcript'),height=box.scrollHeight,top=box.scrollTop;void api<{events:Session['events'];previousEventId:number|null}>('/api/assistant/sessions/'+id+'/events?before='+cursor).then(page=>{if(generation!==version||current?.id!==id)return;olderEvents=[...page.events,...olderEvents,...current.events];olderCursor=page.previousEventId;lastRender='';render(current);box.scrollTop=top+box.scrollHeight-height;}).catch(error);}
  const note=target.closest<HTMLElement>('[data-delete-note]');if(note&&current)void api<Session>('/api/assistant/sessions/'+current.id+'/memory',{title:note.dataset.deleteNote,version:Number(note.dataset.version),delete:true}).then(applyCurrent).catch(error);
});
function clearSession(){destination=undefined;setThinking(false);renderedEventIds.clear();renderedSession='';root.classList.remove('assistant-external-session');$('#assistant-channel-hint').hidden=true;$<HTMLInputElement>('#assistant-attachments').value='';$('#assistant-worker-interactions').replaceChildren();$('#assistant-worker-interactions').hidden=true;workerContext='';document.dispatchEvent(new Event('apix:close-agent-run'));teamUserClosed=false;setTeamOpen(false);teamSummary.textContent='尚未委派员工任务';$('#assistant-workers').dataset.signature='';$('#assistant-workers').innerHTML='<p class="assistant-team-empty">尚未委派员工任务。向 ApiX 描述目标后，可在这里跟进参与员工。</p>'; $('#assistant-prompt-strategy').hidden=true;npmPlan=null;$('#npm-plan').textContent='';$('#npm-diagnosis').textContent='';reviewSignature='';root.querySelector<HTMLElement>('#assistant-delivery')!.textContent='选择对话后查看本任务交付';updateModel('assistant','');$('#assistant-model').innerHTML='<button type="button" class="outline-button" data-choose-conversation-model>模型与思考强度</button>';generation++;olderEvents=[];olderCursor=undefined;notesSignature='';current=null;threadId='';lastRender='';lastRequest='';lastChildAttention='';clearAttentionDialog();$<HTMLDialogElement>('#assistant-dialog').close();$('#assistant-transcript').innerHTML='<div class="assistant-welcome"><h1>今天想完成什么？</h1><p>直接描述目标，ApiX 会持续推进。</p></div>';$('#assistant-notes').textContent='';$('#assistant-activity').textContent='';$('#assistant-context').textContent='暂无压缩摘要；原始记录持续保存。';$('#assistant-budget').textContent='';$('#assistant-usage').textContent='选择对话后查看任务用量。';$('#assistant-optimization-status').textContent='';$('#assistant-child').textContent='';$('#assistant-pending').textContent='';setStatus('等待消息','idle');$('#assistant-project').textContent=projectName;$('#assistant-inspect-status').textContent='选择对话后查看详情';$('#assistant-error').textContent='';$('#assistant-resume-bar').hidden=true;$('#assistant-stop').hidden=true;}
document.addEventListener('apix:open-assistant',((event:CustomEvent<string|AssistantDestination>)=>{
  const target=typeof event.detail==='string'?{id:event.detail}:event.detail;
  if(!target.interactionId||current?.id!==target.id)selectSession(target.id);
  destination=target;
  document.dispatchEvent(new CustomEvent('apix:thread-selected',{detail:{id:threadId,kind:'assistant'}}));void refresh();
}) as EventListener);
function selectSession(id:string,nextProject=projectId){
  const input=$<HTMLTextAreaElement>('#assistant-input');
  drafts.set(draftKey(),input.value);
  clearSession();
  delete $('#assistant-pending').dataset.request;
  collaborationSpeech=updateCollaboration(null);
  projectId=nextProject;
  threadId=id;
  input.value=drafts.get(draftKey())??'';
  if(!id)localStorage.removeItem('apix.assistant.'+projectId);
}
document.addEventListener('apix:history-changed',((event:CustomEvent<{id:string;kind:string;action:string}>)=>{if(event.detail.kind==='assistant'&&event.detail.id===threadId&&event.detail.action!=='restore')selectSession('');void refresh();}) as EventListener);
$('#assistant-request-dismiss').addEventListener('click',()=>closeAttentionDialog());
async function answer(approved:boolean){const s=current,p=s?.pending;if(!s||!p||posting)return;setPosting(true);
  try{const selected=[...root.querySelectorAll<HTMLInputElement>('#assistant-options input:checked')].map(i=>(p.options??[])[Number(i.value)]);const result=await api<Session>('/api/assistant/sessions/'+s.id+'/reply',{version:s.version,requestId:p.id,approved,selected,content:$<HTMLTextAreaElement>('#assistant-choice-text').value});$<HTMLDialogElement>('#assistant-dialog').close();applyCurrent(result);}catch(e){error(e);$('#assistant-request-error').textContent=e instanceof Error?e.message:String(e);}finally{setPosting(false);}
}
async function answerChildAttention(approved:boolean,repair=false){
  const s=current,dialog=$<HTMLDialogElement>('#assistant-dialog'),childId=dialog.dataset.attentionChild;if(!s||!childId||posting)return;
  const canResume=dialog.dataset.attentionCanResume==='1',stopConfirmed=dialog.dataset.attentionStopConfirmed==='1';
  const autoRepair=dialog.dataset.attentionAutoRepair==='1';
  if(!approved||(!canResume&&!repair)){closeAttentionDialog();document.dispatchEvent(new CustomEvent('apix:open-goal',{detail:childId}));return;}
  setPosting(true);
  let needsRecovery=false;
  try{
    const child=await api<{revision:number;autonomy?:{state?:string};autonomyRecoveryFingerprint?:string|null;tasks?:{id:string;status:string}[]}>(`/api/coordination/sessions/${encodeURIComponent(childId)}`);
    needsRecovery=child.autonomy?.state==='attention';
    if(repair){
      const attention=current?.childAttention;
      const task=(child.tasks??[]).find(item=>item.id===attention?.taskId&&item.status==='failed');
      if(!task)throw new Error('当前协作流程没有可自动恢复的失败任务');
      const result=await api<{failure:string|null}>(`/api/tasks/${encodeURIComponent(task.id)}/recovery`,{revision:child.revision,useExistingAuthorization:true});
      if(result.failure)throw new Error(result.failure);
    }else if(needsRecovery)await api<Record<string,unknown>>(`/api/coordination/sessions/${encodeURIComponent(childId)}/autonomy/resume`,{revision:child.revision,fingerprint:child.autonomyRecoveryFingerprint,reviewed:true,...(stopConfirmed?{confirmedStopped:true}:{})});
    else await api<Session>('/api/assistant/sessions/'+s.id+'/resume',{version:s.version,confirmed:true});
    closeAttentionDialog();await refresh();
  }catch(value){
    const message=value instanceof Error?value.message:String(value);
    if((needsRecovery||repair)&&autoRepair&&!stopConfirmed&&/确认已停止|确认原进程停止|请先停止或恢复原员工运行/.test(message)){
      dialog.dataset.attentionStopConfirmed='1';
      $('#assistant-question').textContent='需要确认原进程已停止';
      $('#assistant-options').innerHTML=html`<p>${message}</p><small>ApiX 不会重放未确认的操作。请先停止原员工运行；确认已停止后再继续。</small>`;
      $('#assistant-approve').textContent='已确认停止，继续';
      $('#assistant-deny').hidden=false;$('#assistant-deny').textContent='查看详细记录';
      $('#assistant-request-error').textContent='';
      return;
    }
    error(value);$('#assistant-request-error').textContent=message;
  }
  finally{setPosting(false);}
}
$('#assistant-request').addEventListener('submit',event=>{event.preventDefault();const dialog=$<HTMLDialogElement>('#assistant-dialog');if(dialog.dataset.attentionChild)void answerChildAttention(true,dialog.dataset.attentionAutoRepair==='1');else void answer(true);});
$('#assistant-deny').addEventListener('click',()=>{const dialog=$<HTMLDialogElement>('#assistant-dialog');if(dialog.dataset.attentionChild)void answerChildAttention(false);else void answer(false);});
$('#assistant-memory').addEventListener('submit',event=>{event.preventDefault();if(!current)return;const data=new FormData(event.currentTarget as HTMLFormElement),title=String(data.get('title')),content=String(data.get('content')),old=current.notes.find(n=>n.title===title);void api<Session>('/api/assistant/sessions/'+current.id+'/memory',{title,content,version:old?.version??0}).then(applyCurrent).catch(error);});
root.addEventListener('click',event=>{const button=(event.target as Element).closest<HTMLElement>('[data-approve-note]');if(button&&current)void api<Session>('/api/assistant/sessions/'+current.id+'/memory',{title:button.dataset.approveNote,version:Number(button.dataset.version),approve:true}).then(applyCurrent).catch(error);});
document.addEventListener('apix:page',((event:CustomEvent<string>)=>{active=event.detail==='assistant';if(!active)$<HTMLDialogElement>('#assistant-dialog').close();else{lastChildAttention='';void refresh();}}) as EventListener);
document.addEventListener('apix:snapshot',((event:CustomEvent<{projectId:string;data:{projects:{id:string;name:string}[]}}>)=>{
  const id=event.detail.projectId;
  if(id!==projectId){
    modeProject=id;modeDirty=false;executionMode.value='ask_approval';showExecutionRisk();
    projectName=event.detail.data.projects.find(p=>p.id===id)?.name??'ApiX · 通用对话';
    $('#assistant-project').textContent=projectName;
    selectSession(localStorage.getItem('apix.assistant.'+id)??'',id);
  }
  void refresh();
}) as EventListener);
setInterval(()=>void refresh(),1200);
document.addEventListener('apix:collaboration-change',()=>{
  if(current?.child_session_id)void refresh();
});

// 同时校验请求代次、会话和任务，防止慢响应覆盖切换后或更新后的用量视图。
async function showContext(){const id=current?.id,taskId=current?.task_id,contextRequest=++contextGeneration;const box=$('#assistant-budget');if(!id){box.textContent='请先选择或创建对话。';return;}box.textContent='正在计算…';$('#assistant-usage').textContent='正在读取任务用量…';try{const value=await api<any>('/api/assistant/sessions/'+id+'/context');if(contextRequest!==contextGeneration||current?.id!==id||current?.task_id!==taskId)return;if(value.error)throw new Error(value.error);if(value.optimization.promptSettingsVersion!==undefined&&current?.promptSettingsVersion!==undefined&&value.optimization.promptSettingsVersion<current.promptSettingsVersion)return;$('#assistant-usage').innerHTML=tokenUsageView(value.usage);$('#assistant-prompt-strategy').hidden=value.optimization.promptSettingsVersion===undefined;if(current){current.promptStrategy=value.optimization.promptStrategy;current.promptSettingsVersion=value.optimization.promptSettingsVersion;}$<HTMLSelectElement>('#assistant-optimization [name=promptStrategy]').value=value.optimization.promptStrategy??'legacy';$<HTMLSelectElement>('#assistant-optimization [name=mode]').value=value.optimization.mode;$('#assistant-optimization-status').textContent=value.optimization.mode==='saving'?'节省模式：当前工具目录估算减少 '+value.optimization.estimatedReductionTokens+' Token；不代表任务总节省量。':'标准模式：保留完整工具目录。';const labels:Record<string,string>={stableCore:'稳定核心',currentState:'当前状态与结束契约',system:'系统提示',instructions:'指令记忆',memoryIndex:'自动记忆索引',recalled:'召回正文',skills:'Skill 元数据',tools:'工具目录',task:'当前任务',history:'历史事件',toolResults:'工具结果',other:'摘要与其他'};box.innerHTML=(value.compaction?.blocked?html`<p>自动压缩已暂停：${value.compaction.reason==='no_gain'?'上次压缩没有缩小上下文':value.compaction.reason==='failed'?'上次压缩失败':'压缩进行中或上次结果未确认'}。新增有效用户/工具输入后重新评估，也可点击下方“压缩历史”明确重试；刷新和普通恢复不会重试压缩。</p>`:value.compaction?html`<p>已有新的有效输入，自动压缩可重新评估。</p>`:'')+html`<p>估算 ${value.usedTokens.toLocaleString()} / ${value.windowTokens.toLocaleString()} Token · 剩余 ${value.remainingTokens.toLocaleString()} · 整理阈值 ${value.targetTokens.toLocaleString()}</p><progress max="${value.windowTokens}" value="${value.usedTokens}" aria-label="上下文占用"></progress><dl>` + (Object.entries(value.categories).map(([key,tokens])=>html`<div><dt>${labels[key]??key}</dt><dd>${tokens} Token</dd></div>`).join('')) + html`</dl><details><summary>实际加载的指令文件</summary>` + (value.instructions.map((f:any)=>html`<p>${f.path} · ${f.layer} · ${f.bytes} B · ${f.truncated?'已截断':'未截断'} ${f.blocked??''}</p>`).join('')) + html`</details><details><summary>压缩历史 (${value.compressions.length})</summary>` + (value.compressions.map((c:any)=>html`<p>${c.reason==='manual'?'手动':'自动'} · ${c.estimatedBeforeTokens} → ${c.estimatedAfterTokens??'—'} Token<br>${c.preserve??''}</p>`).join('')) + html`</details>`;}catch(e){if(contextRequest!==contextGeneration||current?.id!==id||current?.task_id!==taskId)return;box.textContent=e instanceof Error?e.message:String(e);$('#assistant-usage').textContent='读取用量失败：'+box.textContent;}}
$('#assistant-context-refresh').addEventListener('click',()=>void showContext());
$('#assistant-compact').addEventListener('submit',async event=>{event.preventDefault();if(!current)return;const id=current.id,form=event.currentTarget as HTMLFormElement,button=form.querySelector('button')!;button.disabled=true;$('#assistant-budget').textContent='正在压缩，原始记录会保留…';try{const result=await api<Session>('/api/assistant/sessions/'+id+'/compact',{version:current.version,focus:new FormData(form).get('focus')});if(current?.id===id){applyCurrent(result);await showContext();}}catch(e){error(e);if(current?.id===id)await showContext();}finally{button.disabled=false;}});

$('#assistant-usage-refresh').addEventListener('click',()=>void showContext());
$('#assistant-optimization').addEventListener('submit',async event=>{event.preventDefault();if(!current)return;const id=current.id,version=current.version,form=event.currentTarget as HTMLFormElement,button=form.querySelector('button')!;button.disabled=true;$('#assistant-optimization-status').textContent='正在保存…';try{const result=await api<Session>('/api/assistant/sessions/'+id+'/optimization',{version,mode:new FormData(form).get('mode'),...(current.promptSettingsVersion!==undefined?{promptStrategy:new FormData(form).get('promptStrategy'),promptSettingsVersion:current.promptSettingsVersion}:{})});if(current?.id===id){applyCurrent(result);await showContext();}}catch(e){if(current?.id===id)$('#assistant-optimization-status').textContent=e instanceof Error?e.message:String(e);}finally{button.disabled=false;}});

$('#assistant-employees').addEventListener('click',()=>document.querySelector<HTMLButtonElement>('[data-page-target=missions]')?.click());
let workerEmployees:{id:string;name:string}[]=[];
let workerSelection:string|null=null;
document.addEventListener('apix:agent-run-selected',((event:CustomEvent<string|null>)=>{workerSelection=event.detail;for(const row of root.querySelectorAll<HTMLElement>('[data-worker-run]'))row.setAttribute('aria-pressed',String(row.dataset.workerRun===workerSelection));}) as EventListener);
let workerRuns:{id:string;task_id:string;runtime:string;status:string;started_at:string;ended_at?:string;runtime_phase?:string;pending_interactions?:number}[]=[];
document.addEventListener('apix:snapshot',((event:CustomEvent<{data:{runs:typeof workerRuns;employees:typeof workerEmployees}}>)=>{workerRuns=event.detail.data.runs??[];workerEmployees=event.detail.data.employees??[];}) as EventListener);
let workerContext='';
let workerRequest=0;
let appliedWorkerRequest=0;
type WorkerTask={id:string;employee_id:string;employee_name?:string;runtime:string;status:string;prompt:string;result?:string;queue_reason?:string;
  recovery?:{automatic:boolean;state:string;attempts:number;maxAttempts:number;reason?:string}};
async function showWorkers(s:Session,childId:string|null){
  const box=$('#assistant-workers'),context=s.id+':'+childId,request=++workerRequest;
  if(workerContext!==context){teamUserClosed=false;setTeamOpen(false);workerContext=context;}
  if(!childId){
    collaborationSpeech=updateCollaboration(null);
    renderTranscript(s);
    box.dataset.signature='';
    box.innerHTML='<p class="assistant-team-empty">尚未委派员工任务。向 ApiX 描述目标后，可在这里跟进参与员工。<small>现有员工保持原运行方式；在员工设置中可切换试验运行后端。</small></p>';
    teamSummary.textContent='尚未委派员工任务';
    return;
  }
  try{
    const path='/api/coordination/sessions/'+encodeURIComponent(childId);
    const [child,activity]=await Promise.all([
      api<{plan_id:string|null;tasks:WorkerTask[]}>(path),
      api<CollaborationActivity>(path+'/activity').catch(()=>null),
    ]);
    if(current?.id!==s.id||workerContext!==context||request<appliedWorkerRequest)return;
    appliedWorkerRequest=request;
    const names=new Map(workerEmployees.map(employee=>[employee.id,employee.name]));
    const workers=child.tasks.map(task=>({id:task.employee_id,name:names.get(task.employee_id)??task.employee_name??task.runtime}));
    const count=(states:string[])=>child.tasks.filter(task=>states.includes(task.status)).length;
    const summary=[['运行中',count(['running','starting'])],['排队',count(['queued'])],
      ['待验收',count(['completed'])],['已验收',count(['accepted'])],['待确认',count(['awaiting_approval','failed','blocked','unknown','needs_revision','rejected'])]]
      .filter(([,value])=>value).map(([label,value])=>value+' '+label).join(' · ');
    if(activity?.planId===child.plan_id){
      const participants=new Set(activity.events.flatMap(event=>[event.from,event.to]));
      collaborationSpeech=updateCollaboration(activity,[...workerEmployees.filter(employee=>participants.has(employee.id)),...workers],summary);
    }else collaborationSpeech=updateCollaboration(null);
    renderTranscript(current);
    const runs=workerRuns.filter(run=>child.tasks.some(task=>task.id===run.task_id));
    const signature=JSON.stringify([workerEmployees,child.tasks,runs]);
    const hasWorkers=child.tasks.length>0;
    // 真正有员工任务时自动展开；用户手动收起后轮询保持收起。
    if(hasWorkers){if(!teamDetails.open&&!teamUserClosed)setTeamOpen(true);}
    teamSummary.textContent=hasWorkers?child.tasks.length+' 项员工任务'+(summary?' · '+summary:''):'协作计划尚未生成员工任务';
    if(box.dataset.signature===signature)return;
    box.dataset.signature=signature;
    box.innerHTML=child.tasks.length?child.tasks.map((t,index)=>{
      const run=runs.find(r=>r.task_id===t.id),name=workers[index]!.name;
      const recovery=t.recovery?.automatic?'等待自动修复':t.recovery?.state==='dispatched'&&t.status==='running'?`自动修复中（${t.recovery.attempts}/${t.recovery.maxAttempts}）`:null;
      const status=run?.runtime_phase==='waiting_input'?'等待回答':run?.runtime_phase==='waiting_approval'?'等待批准':recovery??({running:'运行中',queued:'排队',awaiting_approval:'等待计划批准',completed:'待验收',accepted:'已验收',failed:'失败',blocked:'受阻',needs_revision:'待修复',rejected:'已拒绝',cancelled:'已取消',unknown:'状态未知'} as Record<string,string>)[t.status]??t.status;
      const elapsed=run?Math.max(0,Math.floor(((run.ended_at?Date.parse(run.ended_at):Date.now())-Date.parse(run.started_at))/1000))+' 秒':'尚未启动';
      const reason=t.recovery?.reason??(t.status==='queued'?t.queue_reason:null);
      return html`<button type="button" class="agent-worker-row" aria-pressed="${run?.id===workerSelection}" ${run?'':'disabled'} data-worker-task="${t.id}" data-worker-run="${run?.id??''}"><strong>${t.prompt}</strong><span>${name} · ${t.runtime} · ${status} · ${run?.pending_interactions?run.pending_interactions+' 项待处理 · ':''}${elapsed}</span>`+(['failed','blocked','unknown','needs_revision'].includes(t.status)&&t.result?html`<small class="agent-worker-failure">失败原因：${String(t.result).slice(-500)}</small>`:'')+(reason?html`<small>${reason}</small>`:'')+'</button>';
    }).join(''):'<p class="assistant-team-empty">协作计划尚未生成员工任务，可从协作进度继续。</p>';
  }catch(error){if(current?.id===s.id&&workerContext===context&&request>=appliedWorkerRequest){appliedWorkerRequest=request;box.dataset.signature='';box.textContent='员工过程加载失败，可从协作进度重试。';teamSummary.textContent='员工过程加载失败';}}
}
root.addEventListener('click',event=>{const button=(event.target as Element).closest<HTMLElement>('[data-worker-run]');if(button?.dataset.workerRun)document.dispatchEvent(new CustomEvent('apix:open-agent-run',{detail:{runId:button.dataset.workerRun,taskId:button.dataset.workerTask,workspace:true}}));});
