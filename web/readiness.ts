import {html} from './html.js';
export type Readiness={projectId:string|null;checkedAt:string;checks:{id:string;state:string;message:string;action:string}[];canPlan:boolean;canExecute:boolean;authenticationVerified:boolean};
export function readinessView(data:Readiness) {
  const issues=data.checks.filter(c=>c.state!=='ready');
  const actionNames:Record<string,string>={projects:'项目管理',model:'配置与测试模型',missions:'配置员工',budget:'能力与预算',permissions:'检查权限'};
  return html`<details class="setup-check" ${data.checks.some(c=>c.state==='missing')?'open':''}><summary>${data.canExecute?'基础入口已就绪':'完成工作前的配置'} · ${issues.length} 项待核对</summary><p>入口发现不证明登录、额度或推理可用。连接测试可能产生费用。</p>` + (data.checks.map(c=>html`<div class="setup-row"><span class="setup-state ${c.state==='ready'?'ready':'pending'}">${c.state==='ready'?'✓':c.state==='missing'?'待配置':'待核对'}</span><span>${c.message}</span>` + (Object.hasOwn(actionNames,c.action)?html`<button type="button" class="text-action" data-setup-action="${c.action}">${actionNames[c.action]}</button>`:'') + html`</div>`).join('')) + html`<button type="button" class="outline-button" data-setup-refresh>重新检查</button></details>`;
}
