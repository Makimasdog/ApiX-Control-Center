import {escapeAssistant as esc} from './assistant-view.js';

export type GraphTask={id:string;prompt:string;employee_id:string;status:string;statusLabel?:string;result?:string;queue_reason?:string;employeeName?:string;runtime?:string};
export type GraphDependency={task_id:string;depends_on_id:string};
type GraphData={id:string;title:string;derivedStatus:string;requirements?:Record<string,string>;tasks:GraphTask[];dependencies:GraphDependency[]};
const labels:Record<string,string>={running:'执行中',starting:'启动中',stopping:'正在停止',completed:'待验收',accepted:'已验收',failed:'执行失败',blocked:'已阻塞',unknown:'状态未知',queued:'排队中',awaiting_approval:'待批准',needs_revision:'需要修改',cancelled:'已取消',rejected:'已拒绝'};
export function taskTone(status:string){return ['running','starting','stopping'].includes(status)?'active':status==='accepted'?'done':['completed','queued','awaiting_approval'].includes(status)?'waiting':'attention';}
const short=(value:string,max=64)=>{const chars=Array.from(value.trim().split(/\n/)[0]??'');return chars.length>max?chars.slice(0,max).join('')+'…':chars.join('');};

// Layer the actual dependency graph. Invalid legacy topology remains visible, never repaired here.
export function layoutWorkflow(tasks:GraphTask[],dependencies:GraphDependency[]){
  const ids=new Set(tasks.map(t=>t.id)),parents=new Map(tasks.map(t=>[t.id,new Set<string>()])),children=new Map(tasks.map(t=>[t.id,new Set<string>()]));
  let missing=0;
  for(const edge of dependencies){if(!ids.has(edge.task_id)||!ids.has(edge.depends_on_id)){missing++;continue;}parents.get(edge.task_id)!.add(edge.depends_on_id);children.get(edge.depends_on_id)!.add(edge.task_id);}
  const remaining=new Map([...parents].map(([id,p])=>[id,p.size])),levels=new Map<string,number>();
  const queue=tasks.filter(t=>!remaining.get(t.id)).map(t=>t.id);
  for(let head=0;head<queue.length;head++){
    const id=queue[head]!;levels.set(id,Math.max(0,...[...parents.get(id)!].map(p=>(levels.get(p)??0)+1)));
    for(const next of children.get(id)!){remaining.set(next,remaining.get(next)!-1);if(!remaining.get(next))queue.push(next);}
  }
  const unresolved=tasks.filter(t=>!levels.has(t.id));const fallback=Math.max(-1,...levels.values())+1;
  for(const task of unresolved)levels.set(task.id,fallback);
  const columns=new Map<number,string[]>();for(const t of tasks){const column=levels.get(t.id)!+1;columns.set(column,[...(columns.get(column)??[]),t.id]);}
  const rows=Math.max(1,...[...columns.values()].map(c=>c.length)),height=rows*184+80;
  const nodes=tasks.map(task=>{const column=levels.get(task.id)!+1,list=columns.get(column)!;return {id:task.id,x:32+column*316,y:40+(rows-list.length)*92+list.indexOf(task.id)*184,width:252,height:144};});
  const goal={x:32,y:(height-144)/2,width:252,height:144};const byId=new Map(nodes.map(n=>[n.id,n]));
  const curve=(from:typeof goal,to:typeof goal)=>{const x=from.x+from.width,y=from.y+72,end=to.x,endY=to.y+72,bend=Math.max(32,Math.abs(end-x)/2);return `M ${x} ${y} C ${x+bend} ${y}, ${end-bend} ${endY}, ${end} ${endY}`;};
  const edges=[...parents].flatMap<{from:string|null;to:string;path:string}>(([id,p])=>p.size?[...p].map(parent=>({from:parent,to:id,path:curve(byId.get(parent)!,byId.get(id)!)})):[{from:null,to:id,path:curve(goal,byId.get(id)!)}]);
  return {nodes,goal,edges,width:tasks.length?Math.max(...nodes.map(n=>n.x+n.width))+32:632,height,missing,unresolved:unresolved.length};
}

export function createWorkflowGraph(container:HTMLElement,actions:{inspect(id:string):void;overview():void;select():void}){
  container.classList.add('workflow-explorer');
  container.innerHTML=`<div data-graph-overview><header class="workflow-toolbar"><div><span class="workflow-eyebrow">WORKFLOW MAP</span><h3>任务协作图</h3><p>点击节点进入详情 · 连线表示前置依赖</p></div><div class="workflow-zoom"><button type="button" data-graph-zoom="out" aria-label="缩小流程图">−</button><output aria-live="polite" data-graph-scale>100%</output><button type="button" data-graph-zoom="in" aria-label="放大流程图">＋</button><button type="button" data-graph-zoom="fit">适应宽度</button></div></header><div class="workflow-summary" data-graph-summary></div><p class="workflow-topology-warning" data-graph-warning role="status" hidden></p><div class="workflow-viewport" tabindex="0" role="region" aria-label="任务依赖图，可滚动查看并通过 Tab 选择节点"><div class="workflow-stage"><div class="workflow-canvas"></div></div></div><footer class="workflow-legend"><span class="graph-tone-active">● 执行中</span><span class="graph-tone-waiting">● 等待 / 待验收</span><span class="graph-tone-attention">● 需处理</span><span class="graph-tone-done">● 已验收</span><small>状态来自实际任务记录</small></footer></div><section data-node-view hidden><nav class="workflow-breadcrumb" aria-label="节点位置"><button type="button" data-graph-back>← 返回协作图</button><span>/</span><span data-node-crumb></span></nav><div data-node-content></div><div data-node-inspection></div></section>`;
  const find=<T extends HTMLElement=HTMLElement>(query:string)=>container.querySelector<T>(query)!;
  let data:GraphData|null=null,selected:string|null=null,key='',zoom=1,graphWidth=632,graphHeight=264,autoFit=true;
  const badge=(task:GraphTask)=>`<span class="workflow-badge graph-tone-${taskTone(task.status)}">${esc(task.statusLabel??labels[task.status]??'状态未知')}</span>`;
  function scale(){if(autoFit&&find('.workflow-viewport').clientWidth>0){zoom=Math.max(.75,Math.min(1,find('.workflow-viewport').clientWidth/graphWidth));autoFit=false;}find('.workflow-stage').style.width=graphWidth*zoom+'px';find('.workflow-stage').style.height=graphHeight*zoom+'px';find('.workflow-canvas').style.transform=`scale(${zoom})`;find('[data-graph-scale]').textContent=Math.round(zoom*100)+'%';}
  function show(id:string|null,focus=false){
    if(id!==null&&id!=='@goal'&&!data?.tasks.some(t=>t.id===id))return;
    if(selected!==id){find('[data-node-inspection]').replaceChildren();actions.select();}selected=id;
    find('[data-graph-overview]').hidden=id!==null;find('[data-node-view]').hidden=id===null;
    if(id===null)scale();
    if(id!==null)details();
    if(focus){if(id===null){const node=[...container.querySelectorAll<HTMLButtonElement>('[data-graph-task]')].find(n=>n.dataset.graphTask===lastSelected);(node??find<HTMLDivElement>('.workflow-viewport')).focus();}else {const heading=find('[data-node-content] h2');heading.tabIndex=-1;heading.focus({preventScroll:true});container.scrollIntoView({block:'start'});}}
  }
  let lastSelected='';
  function related(ids:string[],empty:string){return ids.length?ids.map(id=>{const task=data!.tasks.find(t=>t.id===id);return task?`<button type="button" class="workflow-related" data-graph-task="${esc(id)}"><span>${esc(task.employeeName??'历史员工')}<strong>${esc(short(task.prompt,44))}</strong></span>${badge(task)}<span aria-hidden="true">→</span></button>`:`<p class="coord-muted">关联任务缺失，未推断依赖状态。</p>`;}).join(''):`<p class="coord-muted">${empty}</p>`;}
  function details(){
    if(selected==='@goal'){
      find('[data-node-crumb]').textContent='协作目标';const target=find('[data-node-content]');const signature=JSON.stringify([data!.title,data!.requirements,data!.derivedStatus]);if(target.dataset.signature===signature)return;target.dataset.signature=signature;
      const names:Record<string,string>={goal:'目标',scope:'范围与边界',constraints:'约束',deliverable:'交付物',acceptance:'验收标准'};
      target.innerHTML=`<header class="workflow-detail-hero"><div class="workflow-avatar" aria-hidden="true">A</div><div><span class="workflow-eyebrow">APIX · WORKFLOW</span><h2>${esc(data!.title)}</h2><p>任务从目标出发，沿依赖推进到可检查的交付。</p></div></header><div class="workflow-detail-grid">${Object.entries(names).map(([key,label])=>`<section class="workflow-detail-card"><h3>${label}</h3><div class="workflow-task-prompt">${esc(data!.requirements?.[key]||'尚未确认')}</div></section>`).join('')}</div><button type="button" class="outline-button" data-graph-goal-settings>管理需求与验收标准</button>`;return;
    }
    const task=data!.tasks.find(t=>t.id===selected);if(!task)return;
    const index=data!.tasks.indexOf(task)+1,up=[...new Set(data!.dependencies.filter(d=>d.task_id===task.id).map(d=>d.depends_on_id))],down=[...new Set(data!.dependencies.filter(d=>d.depends_on_id===task.id).map(d=>d.task_id))];
    find('[data-node-crumb]').textContent=`步骤 ${index} · ${task.employeeName??'历史员工'}`;
    const signature=JSON.stringify([task,up,down,data!.tasks.map(t=>[t.id,t.status,t.employeeName])]);const target=find('[data-node-content]');if(target.dataset.signature===signature)return;target.dataset.signature=signature;const reportExpanded=target.querySelector<HTMLDetailsElement>('.workflow-report')?.open??false;
    target.innerHTML=`<header class="workflow-detail-hero"><div class="workflow-avatar" aria-hidden="true">${esc((task.employeeName??'A').slice(0,1))}</div><div><span class="workflow-eyebrow">STEP ${String(index).padStart(2,'0')} · ${esc(task.runtime??'AGENT')}</span><h2>${esc(task.employeeName??'历史员工')}</h2><p>${esc(short(task.prompt,90))}</p></div>${badge(task)}</header><div class="workflow-detail-metrics"><div><span>当前状态</span><strong>${esc(task.statusLabel??labels[task.status]??'状态未知')}</strong></div><div><span>执行员工</span><strong>${esc(task.employeeName??'历史员工')}</strong></div><div><span>前置依赖</span><strong>${up.length} 项</strong></div><div><span>后续步骤</span><strong>${down.length} 项</strong></div></div><div class="workflow-detail-grid"><section class="workflow-detail-card"><h3>任务目标与约束</h3><div class="workflow-task-prompt">${esc(task.prompt)}</div></section><section class="workflow-detail-card"><h3>执行与交付</h3><p>${esc(task.queue_reason||(['failed','blocked','unknown'].includes(task.status)?'需要检查实际运行记录及原进程状态。图中状态不会自动解除阻塞。':'检查工作区变更、运行证据与当前任务的验收状态。'))}</p><button type="button" class="primary-button" data-graph-inspect="${esc(task.id)}">检查代码、验收与恢复</button><p class="workflow-help">检查只读取证据；恢复或验收仍需按原规则确认。</p>${task.status==='completed'?`<button type="button" class="outline-button" data-coord-reject="${esc(task.id)}">要求修改</button>`:''}</section><section class="workflow-detail-card"><h3>前置步骤</h3>${related(up,'这是起始步骤，没有前置任务。')}</section><section class="workflow-detail-card"><h3>后续步骤</h3>${related(down,'这是当前依赖链的最后一步。')}</section></div><details class="workflow-detail-card workflow-report"><summary>最近保存的运行报告${task.result?'':' · 尚无报告'}</summary><pre>${esc(task.result??'尚未保存运行报告，请以真实运行记录为准。')}</pre></details>`;
    target.querySelector<HTMLDetailsElement>('.workflow-report')!.open=reportExpanded;
  }
  function update(next:GraphData){
    if(data?.id!==next.id){selected=null;zoom=1;autoFit=true;find('[data-node-inspection]').replaceChildren();find('[data-node-content]').dataset.signature='';}
    data=next;const nextKey=JSON.stringify(next);if(nextKey===key){scale();return;}key=nextKey;
    const topology=layoutWorkflow(next.tasks,next.dependencies);graphWidth=topology.width;graphHeight=topology.height;
    const counts={done:0,active:0,attention:0,waiting:0};for(const task of next.tasks)counts[taskTone(task.status)]++;
    find('[data-graph-summary]').innerHTML=`<span><strong>${next.tasks.length}</strong> 个步骤</span><span class="graph-tone-active">${counts.active} 执行中</span><span class="graph-tone-attention">${counts.attention} 需处理</span><span class="graph-tone-done">${counts.done} 已验收</span>`;
    const warning=find('[data-graph-warning]');warning.hidden=!topology.missing&&!topology.unresolved;warning.textContent=`依赖数据需要核对：${topology.missing} 条关联缺少任务，${topology.unresolved} 个步骤的依赖顺序无法确定。连线仅展示现有记录，不表示可以执行。`;
    const card=(node:typeof topology.goal,task:GraphTask|null,index:number)=>`<button type="button" class="workflow-node ${task?'graph-node-'+taskTone(task.status):'workflow-goal'}" style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px" ${task?`data-graph-task="${esc(task.id)}" aria-label="步骤 ${index}，${esc(task.employeeName??'历史员工')}，${esc(task.statusLabel??labels[task.status]??'状态未知')}，${esc(short(task.prompt))}"`:'data-graph-goal aria-label="查看当前协作目标与验收"'}><div class="workflow-node-top"><span>${task?'STEP '+String(index).padStart(2,'0'):'APIX · 协作目标'}</span>${task?badge(task):'<span class="workflow-node-arrow" aria-hidden="true">↗</span>'}</div><strong>${esc(task?task.employeeName??'历史员工':short(next.title,38))}</strong><p>${esc(task?short(task.prompt,66):'协调任务 · 检查交付 · 跟踪结果')}</p><span class="workflow-node-footer">${task?'查看节点详情':'查看目标与验收'} <span aria-hidden="true">→</span></span></button>`;
    const canvas=find('.workflow-canvas');const focused=document.activeElement instanceof HTMLElement?document.activeElement.dataset.graphTask:undefined;
    canvas.style.width=graphWidth+'px';canvas.style.height=graphHeight+'px';canvas.innerHTML=`<svg class="workflow-edges" width="${graphWidth}" height="${graphHeight}" aria-hidden="true"><defs><marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="context-stroke"/></marker></defs>${topology.edges.map(edge=>`<path d="${edge.path}" class="workflow-edge ${taskTone(next.tasks.find(t=>t.id===edge.to)!.status)}" marker-end="url(#workflow-arrow)"/>`).join('')}</svg>${card(topology.goal,null,0)}${topology.nodes.map(n=>card(n,next.tasks.find(t=>t.id===n.id)!,next.tasks.findIndex(t=>t.id===n.id)+1)).join('')}${!next.tasks.length?'<p class="workflow-no-tasks">尚未安排员工步骤。点击协作目标查看需求与验收标准。</p>':''}`;
    scale();if(focused)[...container.querySelectorAll<HTMLButtonElement>('[data-graph-task]')].find(n=>n.dataset.graphTask===focused)?.focus({preventScroll:true});
    if(selected&&selected!=='@goal'&&!next.tasks.some(t=>t.id===selected))show(null);
    show(selected);
  }
  container.addEventListener('click',event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('button');if(!button||!container.contains(button))return;
    if(button.dataset.graphTask){lastSelected=button.dataset.graphTask;show(lastSelected,true);}
    if(button.hasAttribute('data-graph-back'))show(null,true);
    if(button.hasAttribute('data-graph-goal')){lastSelected='';show('@goal',true);}
    if(button.hasAttribute('data-graph-goal-settings'))actions.overview();
    if(button.dataset.graphInspect)actions.inspect(button.dataset.graphInspect);
    if(button.dataset.graphZoom){zoom=button.dataset.graphZoom==='fit'?Math.max(.4,Math.min(1,find('.workflow-viewport').clientWidth/graphWidth)):Math.max(.4,Math.min(1.6,zoom+(button.dataset.graphZoom==='in'?.1:-.1)));scale();}
  });
  return {update,inspectionHost(id:string){show(id);return find('[data-node-inspection]');},reset(){selected=null;data=null;key='';find('[data-node-inspection]').replaceChildren();}};
}
