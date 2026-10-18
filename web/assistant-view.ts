import {hostResultSucceeded} from '../src/assistant-result.js';
export function escapeAssistant(value:unknown){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
function outputLink(value:unknown){if(!value||typeof value!=='object'||!('outputRef' in value))return '';return `<button type="button" class="text-action" data-output-reference="${escapeAssistant(value.outputRef)}">分段查看完整内容</button>`;}
export function approvalLabel(kind:string,tool?:string){return kind==='approval'?(tool==='configure_agents'?'授权此项目并继续':tool==='configure_verification'?'批准此验收契约':'仅批准这一次'):'提交选择';}
export function toolResultSucceeded(body:Record<string,unknown>){return body.ok!==false&&hostResultSucceeded(body.result);}
export function assistantTimeline(events:{id:number;role:string;kind:string;body:Record<string,unknown>}[]){return events.map(e=>{
  const content=e.body.content??e.body.error??e.body.question;
  if(content)return `<article class="assistant-message ${e.role==='user'?'from-user':''}" data-event-id="${e.id}"><small>${e.role==='user'?'你':e.role==='system'?'系统':'ApiX'}</small><div>${escapeAssistant(content)}</div></article>`;
  if(e.kind==='tool_started')return `<details class="assistant-tool-detail"><summary>↗ ${escapeAssistant(e.body.tool)}</summary><pre>${escapeAssistant(JSON.stringify(e.body.args,null,2))}</pre>${outputLink(e.body.args)}</details>`;
  if(e.kind==='command_started')return `<details class="assistant-tool-detail"><summary>进程启动 · PID ${escapeAssistant(e.body.pid)}</summary><pre>${escapeAssistant(JSON.stringify(e.body,null,2))}</pre></details>`;
  if(e.kind==='verification_evidence')return `<details class="assistant-tool-detail"><summary>${e.body.passed===true?'✓':'!'} 可信检查 ${escapeAssistant(e.body.checkId)} · ${escapeAssistant(e.body.verificationStatus)}</summary><pre>${escapeAssistant(JSON.stringify(e.body,null,2))}</pre>${outputLink(e.body)}</details>`;
  if(e.kind==='tool_result'||e.kind==='delegation_result')return `<details class="assistant-tool-detail"><summary>${toolResultSucceeded(e.body)?'✓':'!'} ${escapeAssistant(e.body.tool??'员工验收结果')}</summary><pre>${escapeAssistant(JSON.stringify(e.body.result??e.body,null,2))}</pre>${outputLink(e.body.result)}</details>`;
  if(e.kind==='request_answer')return `<p class="assistant-system-note">已收到你的${'approved'in e.body?(e.body.approved?'批准':'拒绝'):'选择'}，ApiX 将继续处理。</p>`;
  return `<p class="assistant-system-note">${escapeAssistant(({compacted:'已整理上下文，原始记录仍可回看',stopped:'已请求停止',resumed:'已确认继续',memory_edited:'项目记忆已更新'} as Record<string,string>)[e.kind]??e.kind)}</p>`;
}).join('');}
