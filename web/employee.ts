type Task = {id:string;prompt:string;status:string;project_name:string;created_at:string;updated_at:string};
type Run = {id:string;task_id:string;status:string;started_at:string;ended_at:string|null;input_tokens:number|null;output_tokens:number|null;cached_tokens:number|null;usage_source:string|null};
type Report = {id:string;taskId:string;summary:string;blocked:boolean;createdAt:string};
type Detail = {employee:{id:string;name:string;role:string;runtime:string;department:string;enabled:number};tasks:Task[];runs:Run[];reports:Report[];usage:{inputTokens:number;outputTokens:number;cachedTokens:number;measuredRuns:number;totalRuns:number}};
const parent=document.querySelector('#page-missions')!;
parent.insertAdjacentHTML('afterend',`<main id="page-employee" class="page settings-page"><div class="page-intro"><button class="text-action" data-page-target="missions">← 返回任务与员工</button><div class="eyebrow">APIX · EMPLOYEE</div><h1 id="employee-name">员工详情</h1><p id="employee-role"></p></div><section class="employee-metrics"><article class="surface-card"><strong id="employee-state">—</strong><span>当前状态</span></article><article class="surface-card"><strong id="employee-tokens">—</strong><span>已记录 Token</span></article><article class="surface-card"><strong id="employee-task-count">—</strong><span>历史任务</span></article></section><section class="surface-card section-block"><h2>正在进行</h2><div id="employee-active"></div></section><section class="surface-card section-block"><h2>历史任务</h2><div id="employee-history"></div></section></main>`);
const root=document.querySelector<HTMLElement>('#page-employee')!;
const find=(selector:string)=>root.querySelector<HTMLElement>(selector)!;
const esc=(value:unknown)=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const date=(value:string)=>new Date(value).toLocaleString('zh-CN');
const status:Record<string,string>={running:'运行中',stopping:'正在停止',queued:'等待前置任务',awaiting_approval:'等待批准',completed:'待验收',accepted:'已验收',failed:'失败',cancelled:'已取消',blocked:'阻塞',needs_revision:'需要修改',unknown:'状态未知'};
let selected=''; let version=0;
async function load(){const id=selected;const current=++version;if(!id)return;
  try{const response=await fetch(`/api/employees/${encodeURIComponent(id)}/details`);const data=await response.json() as Detail & {error?:string};if(!response.ok)throw new Error(data.error ?? `HTTP ${response.status}`);if(current!==version||id!==selected)return;render(data);}
  catch(error){if(current===version)find('#employee-active').textContent=String(error instanceof Error?error.message:error);}
}
function render(data:Detail){
  find('#employee-name').textContent=data.employee.name;
  find('#employee-role').textContent=`${data.employee.role} · ${data.employee.department || '未分组'} · ${data.employee.runtime}`;
  const active=data.tasks.filter(task=>['running','stopping'].includes(task.status));
  find('#employee-state').textContent=!data.employee.enabled?'已停用':active.length?`${active.length} 个任务运行中`:'待命';
  find('#employee-task-count').textContent=String(data.tasks.length);
  find('#employee-tokens').textContent=data.usage.measuredRuns?`${(data.usage.inputTokens+data.usage.outputTokens).toLocaleString('zh-CN')} / ${data.usage.totalRuns} Run 中 ${data.usage.measuredRuns} 个有数据`:'暂无用量数据';
  const usage=(run:Run|undefined)=>run?.input_tokens==null&&run?.output_tokens==null?'Token 用量未知':`输入 ${Number(run.input_tokens??0).toLocaleString('zh-CN')} · 输出 ${Number(run.output_tokens??0).toLocaleString('zh-CN')} · 缓存 ${Number(run.cached_tokens??0).toLocaleString('zh-CN')}`;
  const card=(task:Task)=>{const run=data.runs.find(item=>item.task_id===task.id);const report=data.reports.find(item=>item.taskId===task.id);return `<article class="employee-task"><div><strong>${esc(task.prompt)}</strong><span class="coord-pill">${esc(status[task.status]??task.status)}</span></div><p>${esc(task.project_name)} · ${date(task.created_at)}${run?` · Run ${esc(run.id.slice(0,8))}`:''}</p><p>${report?`${report.blocked?'阻塞报告':'最近进度'}：${esc(report.summary)} · ${date(report.createdAt)}`:'暂无员工进度报告'}</p><small>${usage(run)}</small></article>`;};
  find('#employee-active').innerHTML=active.map(card).join('')||'<p class="coord-muted">当前没有运行中的任务。</p>';
  find('#employee-history').innerHTML=data.tasks.map(card).join('')||'<p class="coord-muted">暂无历史任务。</p>';
}
document.addEventListener('apix:open-employee',((event:CustomEvent<string>)=>{selected=event.detail;find('#employee-active').textContent='正在加载…';void load();}) as EventListener);
document.addEventListener('apix:snapshot',()=>{if(selected&&root.classList.contains('active-page'))void load();});
