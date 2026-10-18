export type Readiness={projectId:string|null;checkedAt:string;checks:{id:string;state:string;message:string;action:string}[];canPlan:boolean;canExecute:boolean;authenticationVerified:boolean};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function readinessView(data:Readiness) {
  const issues=data.checks.filter(c=>c.state!=='ready');
  const actionNames:Record<string,string>={projects:'项目管理',model:'配置与测试模型',missions:'配置员工',budget:'能力与预算',permissions:'检查权限'};
  return `<details class="setup-check" ${data.checks.some(c=>c.state==='missing')?'open':''}><summary>${data.canExecute?'基础入口已就绪':'完成工作前的配置'} · ${issues.length} 项待核对</summary><p>入口发现不证明登录、额度或推理可用。连接测试可能产生费用。</p>${data.checks.map(c=>`<div class="setup-row"><span class="setup-state ${c.state==='ready'?'ready':'pending'}">${c.state==='ready'?'✓':c.state==='missing'?'待配置':'待核对'}</span><span>${escape(c.message)}</span>${Object.hasOwn(actionNames,c.action)?`<button type="button" class="text-action" data-setup-action="${escape(c.action)}">${actionNames[c.action]}</button>`:''}</div>`).join('')}<button type="button" class="outline-button" data-setup-refresh>重新检查</button></details>`;
}
