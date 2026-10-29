import {html} from './html.js';
export function instructionState(status: string) {
  return ({queued:'待接收',delivered:'已送达，待确认',processing:'员工已确认接收',completed:'员工已报告处理',failed:'处理失败',expired:'已超时',rejected:'已拒绝'} as Record<string,string>)[status] ?? status;
}

export interface RecoveryDelivery {
  status:string;
  latestRun?:{id:string;status:string;pid:number|null};
  processMayExist:boolean|null;
  managedActive:boolean;
  recoveryFingerprint:string|null;
}


export function recoveryForm(d:RecoveryDelivery, task:{employee_id:string;queue_reason?:string}, employees:{id:string;name:string;runtime:string}[], dependenciesAccepted:boolean) {
  const queued=d.status==='queued';
  const neverRun=queued && !d.latestRun;
  const canSubmit=!!d.recoveryFingerprint && !d.managedActive && dependenciesAccepted;
  const note=queued?html`<p>排队原因：${task.queue_reason || '未提供，请核对任务和项目执行状态'}。前置任务全部验收后才能换员工；重新排队仍受权限、预算、并发及暂停限制。</p>`:'';
  const runInfo=neverRun?'<p>未启动过，无历史运行记录。</p>':html`<p>最近运行：${d.latestRun?.id ?? '未启动'} · ${d.latestRun?.status ?? '无'} · PID ${d.latestRun?.pid ?? '无'}。PID 探测：${d.processMayExist===true?'可能仍存在':d.processMayExist===false?'未发现原 PID':'无法确定'}；PID 可能被其他进程复用。</p>`;
  const review=neverRun?'依赖验收状态、换员工原因':'最新代码、运行报告';
  const disabledReason=d.managedActive?'任务正在运行，等待结束后再操作。':!dependenciesAccepted?'请先验收全部前置任务，再重新打开检查。':!d.recoveryFingerprint?'暂时无法取得恢复指纹，请检查错误信息并重新打开检查。':'';
  return html`<h3>${queued?'换员工':'检查后重新批准'}</h3>` + (note) + (runInfo) + (neverRun?'':'<p>检查完整代码和运行报告，必要时先在工作区解决并暂存冲突，再重新打开检查。恢复会生成新运行，不重放旧凭据或旧指导消息。</p>') + html`<form id="coord-recovery"><label>重新分配给员工<select name="employeeId">` + (employees.map(e=>html`<option value="${e.id}" ${e.id===task.employee_id?'selected':''}>${e.name} · ${e.runtime}</option>`).join('')) + html`</select></label><label><input type="checkbox" name="reviewed" required>已检查${review}与验收要求</label>` + (d.status==='unknown'?'<label><input type="checkbox" name="confirmedStopped" required>已人工确认原进程停止</label>':'') + html`<button class="primary-button" ${canSubmit?'':'disabled'}>${queued?'换员工并重新排队':'重新批准并排队执行'}</button></form>` + (canSubmit?'':html`<p class="coord-muted">${disabledReason}</p>`);
}
