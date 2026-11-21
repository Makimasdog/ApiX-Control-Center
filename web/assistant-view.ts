import {html} from './html.js';
import type {CollaborationSpeech} from './collaboration-scene.js';
export {escapeHtml as escapeAssistant} from './html.js';
import {hostResultSucceeded} from '../src/assistant/assistant-result.js';
function outputLink(value:unknown){if(!value||typeof value!=='object'||!('outputRef' in value))return '';return html`<button type="button" class="text-action" data-output-reference="${value.outputRef}">分段查看已保存结果</button>`;}
function logLinks(operationId:unknown){if(!operationId)return '';return html`<div class="assistant-evidence-actions">` + ((['stdout','stderr'] as const).map(channel=>(['head','tail'] as const).map(mode=>html`<button type="button" class="text-action" data-command-log="${operationId}" data-log-channel="${channel}" data-log-mode="${mode}">${channel} ${mode==='head'?'头部':'尾部'}</button>`).join('')).join('')) + html`</div>`;}
function fileCard(tool:unknown,value:Record<string,unknown>){return html`<details class="assistant-tool-detail assistant-file-result"><summary>${value.conflict?'!':'✓'} ${tool} · ${value.path??'本会话文件'} ${value.added!==undefined?`+${String((value.added)??'')} / −${String((value.removed)??'')}`:''}</summary><p>版本 ${value.beforeSha256??'新建'} → ${value.afterSha256??value.sha256??'见结果'}</p>` + (value.startLine!==undefined?html`<p>行 ${value.startLine}–${value.endLine} · ${value.bytesReturned??''} 字节</p>`:'') + (value.diffTruncated?'<p class="assistant-evidence-warning">差异受预算限制，未完整展示。</p>':'') + html`<pre>${value.diff??value.content??JSON.stringify(value,null,2)}</pre>` + (outputLink(value)) + html`</details>`;}
export function approvalLabel(kind:string,tool?:string){return kind==='approval'?(tool==='configure_agents'?'授权此项目并继续':tool==='configure_verification'?'批准此验收契约':'仅批准这一次'):'提交选择';}
export function toolResultSucceeded(body:Record<string,unknown>){return body.ok!==false&&hostResultSucceeded(body.result);}
function messageContent(value:unknown){
  const text=String(value??'');let output='',position=0;
  for(const match of text.matchAll(/KB:[\w-]+:[\w-]+:\d+:\d+/g)){
    const citation=match[0];
    output+=html`${text.slice(position,match.index)}<button type="button" class="text-action" data-kb-citation="${citation}">${citation}</button>`;
    position=match.index+citation.length;
  }
  return output+html`${text.slice(position)}`;
}

type TimelineEvent={id:number;role:string;kind:string;created_at?:string;body:Record<string,unknown>};
function formatClock(value:unknown){
  const time=Date.parse(String(value??''));
  return Number.isFinite(time)?new Date(time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
}
function chatMessage(speaker:string,avatar:string,content:string,id?:number,time='',inline=false){
  const label=time&&!inline?speaker+' · '+time:speaker;
  return html`<article class="assistant-message chat-row ${speaker==='你'?'from-user':''}" data-event-id="${id}">`+(inline?'':html`<span class="collaboration-avatar chat-avatar" aria-hidden="true">${avatar}</span>`)+html`<div class="chat-bubble"><small>${label}</small><div class="chat-content">`+content+'</div></div></article>';
}
function timelineEvent(e:TimelineEvent,inline=false){
  if(e.kind==='model_retry')return html`<p class="assistant-system-note">模型临时故障 · ${e.body.delayMs} ms 后重试第 ${e.body.attempt} 次请求；尚未执行工具</p>`;
  if(e.kind==='delivery_accepted')return html`<p class="assistant-system-note">${e.body.source==='apix'?'ApiX 已按项目规则验收本次交付':'已确认本次交付'}</p>`;
  if(e.kind==='delegation_blocked')return chatMessage('ApiX','✦',html`<strong>员工流程需要你的确认</strong><p>${e.body.content}</p><p>ApiX 已暂停自动监督，避免重复运行；处理后可继续。</p>`,e.id,inline?'':formatClock(e.created_at),inline);
  const content=e.body.content??e.body.error??e.body.question;
  // 系统与模型侧的空内容/纯标点占位(如孤立的".")不渲染成消息气泡;用户原话始终保留。
  if(typeof content==='string'&&e.role!=='user'&&!content.replace(/[\p{P}\p{S}\s]/gu,''))return '';
  if(content)return chatMessage(e.role==='user'?'你':e.role==='system'?'系统':'ApiX',e.role==='user'?'你':e.role==='system'?'系':'✦',messageContent(content),e.id,inline?'':formatClock(e.created_at),inline);
  if(e.kind==='tool_started')return html`<details class="assistant-tool-detail"><summary>↗ ${e.body.tool}</summary><pre>${JSON.stringify(e.body.args,null,2)}</pre>` + (outputLink(e.body.args)) + html`</details>`;
  if(e.kind.startsWith('npm_validation_'))return html`<details class="assistant-tool-detail"><summary>Node/npm · ${e.body.status??e.kind}</summary><pre>${JSON.stringify(e.body,null,2)}</pre></details>`;
  if(e.kind==='command_intent')return html`<details class="assistant-tool-detail"><summary>命令已登记 · 等待托管启动</summary><code>${e.body.operationId}</code>` + (logLinks(e.body.operationId)) + html`</details>`;
  if(e.kind==='command_identity'){const identity=(e.body.identity??{}) as Record<string,unknown>;return html`<details class="assistant-tool-detail"><summary>${identity.pid?'命令已启动':'托管身份已保存'} · PID ${identity.pid??identity.ownerPid}</summary><code>${e.body.operationId}</code><pre>${JSON.stringify(identity,null,2)}</pre></details>`;}
  if(e.kind==='command_finished'){const log=(e.body.log??{}) as Record<string,unknown>,state=e.body.unknown?'进程结束未确认':e.body.sideEffectsNeedReview?'已结束 · 副作用待核对':'已结束';return html`<details class="assistant-tool-detail assistant-command-result"><summary>${toolResultSucceeded({result:e.body})?'✓':'!'} 命令${state} · 退出码 ${e.body.exitCode??'未知'}</summary><code>${e.body.operationId}</code><p>原因：${e.body.reason} · ${log.complete?'日志保存时完整（保留期内可读）':'日志不完整：'+String((log.reason??'未采集')??'')}</p>` + (logLinks(e.body.operationId)) + (outputLink(e.body)) + html`<pre>${JSON.stringify(e.body,null,2)}</pre></details>`;}
  if(e.kind==='command_log_anchor'||e.kind==='file_recovery_checked'||e.kind==='command_recovery_checked')return '';
  if(e.kind==='command_log_expired')return html`<p class="assistant-evidence-warning">日志已过期或按总容量清理：${e.body.operationId}</p>`;
  if(e.kind==='file_edit_intent')return html`<p class="assistant-system-note">正在提交文件修改：${e.body.path}</p>`;
  if(e.kind==='file_edit_result')return fileCard('实际文件变更',(e.body.result??e.body) as Record<string,unknown>);
  if(e.kind==='delivery_summary')return html`<details class="assistant-tool-detail"><summary>交付证据 · ${(e.body.verification as Record<string,unknown>)?.verificationStatus??'见引用'} · ${e.body.acceptanceStatus==='accepted'?'ApiX 已自动验收':'尚未正式验收'}</summary><p>本次修改和检查证据如下。</p><pre>${JSON.stringify(e.body,null,2)}</pre>` + (outputLink(e.body.result??e.body)) + html`</details>`;
  if(e.kind==='command_started')return html`<details class="assistant-tool-detail"><summary>进程启动 · PID ${e.body.pid}</summary><pre>${JSON.stringify(e.body,null,2)}</pre></details>`;
  if(e.kind==='verification_evidence')return html`<details class="assistant-tool-detail"><summary>${e.body.passed===true?'✓':'!'} 可信检查 ${e.body.checkId} · ${e.body.verificationStatus}</summary><pre>${JSON.stringify(e.body,null,2)}</pre>` + (outputLink(e.body)) + html`</details>`;
  if(e.kind==='tool_result'||e.kind==='delegation_result'){
    const r=(e.body.result??{}) as Record<string,unknown>;
    if(e.body.ok!==false&&['edit_file','read_file','write_file'].includes(String(e.body.tool)))return fileCard(e.body.tool,r);
    if(e.body.ok===false&&['edit_file','write_file'].includes(String(e.body.tool)))return html`<article class="assistant-evidence-warning">文件编辑未提交 / 冲突：${e.body.error}</article>`;
    if(e.body.tool==='search_files'&&e.body.ok!==false)return html`<details class="assistant-tool-detail"><summary>代码搜索 · ${Array.isArray(r.matches)?r.matches.length+' 处':'见引用'} · ${r.scanComplete===false?'扫描不完整':'扫描状态见结果'}</summary>` + (r.scanComplete===false?'<p class="assistant-evidence-warning">部分扫描，不能据此断言全项目无匹配。</p>':'') + (Array.isArray(r.matches)?r.matches.map((m:Record<string,unknown>)=>html`<p>${m.path}:${m.line}:${m.column}</p><pre>${m.snippet}</pre>`).join(''):'') + (outputLink(r)) + html`</details>`;
    if(e.body.tool==='get_diff'&&e.body.ok!==false)return html`<details class="assistant-tool-detail assistant-file-result"><summary>本会话实际差异 · 不包含原有改动</summary>` + (Array.isArray(r.files)?r.files.map((f:Record<string,unknown>)=>html`<h4>${f.path}</h4><p>${f.beforeSha256??'新建'} → ${f.afterSha256}</p>` + (f.workspaceChangedSinceEdit?'<p class="assistant-evidence-warning">文件在本次编辑后又有外部变化，未归为 Agent 修改。</p>':'') + html`<pre>${JSON.stringify(f.edits,null,2)}</pre>`).join(''):'') + (r.historyComplete===false?'<p>有更早变更，请继续读取下一页。</p>':'') + (outputLink(r)) + html`</details>`;
    return html`<details class="assistant-tool-detail"><summary>${toolResultSucceeded(e.body)?'✓':'!'} ${e.body.tool??'员工验收结果'} ${e.body.reused?'· 复用已完成结果，未再次执行':''} ${e.body.tool==='read_output'?(r.complete?'· 日志片段':'· 日志不完整 / 正在采集'):''}</summary><pre>${JSON.stringify(e.body.result??e.body,null,2)}</pre>` + (outputLink(e.body.result)) + html`</details>`;
  }
  if(e.kind==='request_answer')return html`<p class="assistant-system-note">已收到你的${'approved'in e.body?(e.body.approved?'批准':'拒绝'):'选择'}，ApiX 将继续处理。</p>`;
  return html`<p class="assistant-system-note">${({context_budget:'已记录本次上下文占用与指令版本',compacted:'已整理上下文，原始记录仍可回看',stopped:'已请求停止',resumed:'已确认继续',memory_edited:'项目记忆已更新',review_snapshot:'已保存工作区核对快照',delivery_record:'已保存本轮结果',task_started:'任务已开始'} as Record<string,string>)[e.kind]??e.kind}</p>`;
}
export function assistantTimeline(events:TimelineEvent[],speech:CollaborationSpeech[]=[]){
 let result='',records:TimelineEvent[]=[];
 // 一轮 = 用户消息之后的所有 ApiX 事件；同一轮共享一个 ApiX 头像与时间线，失败/审批/引用不入折叠。
 let turn:string[]|null=null,turnTime='';
 const foldable=new Set(['activity','protocol_repair','tool_started','tool_result','context_budget']);
 function toolLabel(event:TimelineEvent){
   const tool=String(event.body.tool??'');
   const args=(event.body.args??{}) as Record<string,unknown>;
   const detail=typeof args.path==='string'?args.path:typeof args.executable==='string'?args.executable:'';
   return tool+(detail?`(${detail})`:'');
 }
 function flush(){
   if(!records.length)return;
   const steps=records.filter(event=>event.kind==='tool_started');
   const repairs=records.filter(event=>event.kind==='protocol_repair').length;
   const labels=steps.map(toolLabel);
   // 耗时只在事件自带时间戳时计算，不用当前时钟，保证同一输入渲染稳定。
   const first=steps[0]?.created_at;
   const last=records.filter(event=>event.kind==='tool_result').at(-1);
   const finished=last&&last.id>= (steps.at(-1)?.id??Infinity)?last.created_at:undefined;
   const ms=first&&finished?Date.parse(finished)-Date.parse(first):Number.NaN;
   const elapsed=Number.isFinite(ms)&&ms>=0?`用时 ${ms>=1000?(ms/1000).toFixed(1)+' 秒':ms+' 毫秒'}`:'';
   const parts=[steps.length?`${steps.length} 次工具调用`:`${records.length} 项`,labels.length?labels.slice(0,3).join('、')+(labels.length>3?` 等 ${labels.length} 项`:''):'',repairs?`${repairs} 次格式纠正`:'',elapsed].filter(Boolean);
   const details=records.map(event=>event.kind==='activity'||event.kind==='protocol_repair'?html`<p class="assistant-system-note">${event.body.content}</p>`:timelineEvent(event,true)).join('');
   const markup=details?html`<details class="assistant-run-records" data-execution-record="${records[0]!.id}"><summary>执行记录 · ${parts.join(' · ')}</summary>`+details+'</details>':'';
   records=[];
   if(markup)append(markup);
 }
 function append(markup:string){if(turn)turn.push(markup);else result+=markup;}
 function beginTurn(event:TimelineEvent){if(!turn){turn=[];turnTime=formatClock(event.created_at);}}
 function closeTurn(){
   flush();
   if(turn?.length){
     result+=html`<article class="assistant-turn"><header class="assistant-turn-head"><span class="collaboration-avatar chat-avatar" aria-hidden="true">✦</span><small>ApiX${turnTime?' · '+turnTime:''}</small></header>`+turn.join('')+'</article>';
   }
   turn=null;turnTime='';
 }
 let next=0;
 for(const event of events){
   while(speech[next]&&event.created_at&&speech[next]!.time<event.created_at){flush();append(speech[next++]!.markup);}
   const failedTool=event.kind==='tool_result'&&!toolResultSucceeded(event.body);
   if(!failedTool&&foldable.has(event.kind)){beginTurn(event);records.push(event);continue;}
   if(event.kind==='model_retry'||failedTool||event.body.content||event.body.error||event.body.question){
     const markup=timelineEvent(event,event.role!=='user');
     flush();
     if(!markup)continue;
     if(event.role==='user'){closeTurn();result+=markup;}
     else{
       beginTurn(event);
       turn!.push(markup);
     }
   }else {beginTurn(event);records.push(event);}
 }
 closeTurn();
 return result+speech.slice(next).map(item=>item.markup).join('');
}
