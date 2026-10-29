import {html} from './html.js';
export {escapeHtml as escapeAssistant} from './html.js';
import {hostResultSucceeded} from '../src/assistant/assistant-result.js';
function outputLink(value:unknown){if(!value||typeof value!=='object'||!('outputRef' in value))return '';return html`<button type="button" class="text-action" data-output-reference="${value.outputRef}">分段查看已保存结果</button>`;}
function logLinks(operationId:unknown){return operationId?html`<div class="assistant-evidence-actions">` + ((['stdout','stderr'] as const).map(channel=>(['head','tail'] as const).map(mode=>html`<button type="button" class="text-action" data-command-log="${operationId}" data-log-channel="${channel}" data-log-mode="${mode}">${channel} ${mode==='head'?'头部':'尾部'}</button>`).join('')).join('')) + html`</div>`:'';}
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

type TimelineEvent={id:number;role:string;kind:string;body:Record<string,unknown>};
function timelineEvent(e:TimelineEvent){
  if(e.kind==='model_retry')return html`<article class="assistant-message"><small>系统</small><div>模型临时故障，将在 ${e.body.delayMs} ms 后进行第 ${e.body.attempt} 次请求；尚未执行工具。</div></article>`;
  const content=e.body.content??e.body.error??e.body.question;
  // 系统与模型侧的空内容/纯标点占位(如孤立的".")不渲染成消息气泡;用户原话始终保留。
  if(typeof content==='string'&&e.role!=='user'&&!content.replace(/[\p{P}\p{S}\s]/gu,''))return '';
  if(content)return html`<article class="assistant-message ${e.role==='user'?'from-user':''}" data-event-id="${e.id}"><small>${e.role==='user'?'你':e.role==='system'?'系统':'ApiX'}</small><div>` + (messageContent(content)) + html`</div></article>`;
  if(e.kind==='tool_started')return html`<details class="assistant-tool-detail"><summary>↗ ${e.body.tool}</summary><pre>${JSON.stringify(e.body.args,null,2)}</pre>` + (outputLink(e.body.args)) + html`</details>`;
  if(e.kind.startsWith('npm_validation_'))return html`<details class="assistant-tool-detail"><summary>Node/npm · ${e.body.status??e.kind}</summary><pre>${JSON.stringify(e.body,null,2)}</pre></details>`;
  if(e.kind==='command_intent')return html`<details class="assistant-tool-detail"><summary>命令已登记 · 等待托管启动</summary><code>${e.body.operationId}</code>` + (logLinks(e.body.operationId)) + html`</details>`;
  if(e.kind==='command_identity'){const identity=(e.body.identity??{}) as Record<string,unknown>;return html`<details class="assistant-tool-detail"><summary>${identity.pid?'命令已启动':'托管身份已保存'} · PID ${identity.pid??identity.ownerPid}</summary><code>${e.body.operationId}</code><pre>${JSON.stringify(identity,null,2)}</pre></details>`;}
  if(e.kind==='command_finished'){const log=(e.body.log??{}) as Record<string,unknown>,state=e.body.unknown?'进程结束未确认':e.body.sideEffectsNeedReview?'已结束 · 副作用待核对':'已结束';return html`<details class="assistant-tool-detail assistant-command-result"><summary>${toolResultSucceeded({result:e.body})?'✓':'!'} 命令${state} · 退出码 ${e.body.exitCode??'未知'}</summary><code>${e.body.operationId}</code><p>原因：${e.body.reason} · ${log.complete?'日志保存时完整（保留期内可读）':'日志不完整：'+String((log.reason??'未采集')??'')}</p>` + (logLinks(e.body.operationId)) + (outputLink(e.body)) + html`<pre>${JSON.stringify(e.body,null,2)}</pre></details>`;}
  if(e.kind==='command_log_anchor'||e.kind==='file_recovery_checked'||e.kind==='command_recovery_checked')return '';
  if(e.kind==='command_log_expired')return html`<p class="assistant-evidence-warning">日志已过期或按总容量清理：${e.body.operationId}</p>`;
  if(e.kind==='file_edit_intent')return html`<p class="assistant-system-note">正在提交文件修改：${e.body.path}</p>`;
  if(e.kind==='file_edit_result')return fileCard('实际文件变更',(e.body.result??e.body) as Record<string,unknown>);
  if(e.kind==='delivery_summary')return html`<details class="assistant-tool-detail"><summary>交付证据 · ${(e.body.verification as Record<string,unknown>)?.verificationStatus??'见引用'} · 尚未正式验收</summary><p>本次修改通过 get_diff 核对，实际检查与未验证项如下。</p><pre>${JSON.stringify(e.body,null,2)}</pre>` + (outputLink(e.body.result??e.body)) + html`</details>`;
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
export function assistantTimeline(events:TimelineEvent[]){
 let result='',records:TimelineEvent[]=[];
 const flush=()=>{if(!records.length)return;result+=html`<details class="assistant-run-records" data-execution-record="${records[0]!.id}"><summary>执行记录 · ${records.length} 项</summary>` + (records.map(timelineEvent).join('')) + html`</details>`;records=[];};
 for(const event of events){if(event.kind==='model_retry'||event.body.content||event.body.error||event.body.question){flush();result+=timelineEvent(event);}else records.push(event);}
 flush();return result;
}
