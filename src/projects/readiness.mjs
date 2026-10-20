import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat} from 'node:fs/promises';
const exec=promisify(execFile);
export async function projectReadiness({project,employees,runtimes,settings,managerAvailable,policy,budget,inspect=async path=>{
  if(!(await stat(path)).isDirectory())throw new Error('项目不是目录');
  try{await exec('git',['rev-parse','--verify','HEAD'],{cwd:path,timeout:5000,windowsHide:true});return 'git';}catch(error){if(['ENOENT','EACCES','EPERM'].includes(error.code) || error.killed)throw error;return 'snapshot';}
}}) {
  const checks=[];const add=(id,state,message,action)=>checks.push({id,state,message,action});
  if(!project)add('project','missing','先添加或选择一个本机项目','projects');
  else{try{const kind=await inspect(project.path);add('project','ready',kind==='snapshot'?'项目目录可用；执行时建立托管 Git 快照，原目录保持不变':'项目 Git 提交可用','projects');}catch{add('project','missing','项目目录或 Git 入口不可用，请检查路径及 Git 安装','projects');}}
  add('manager',managerAvailable?'ready':'missing',managerAvailable?'ApiX 模型 API 配置可用，认证与模型仍需连接测试':'请配置 ApiX 的模型 API 地址、模型 ID 与密钥；Pi、Codex、Claude 仅为可选执行 Agent，无需安装 Pi 即可对话','model');
  const keyMissing=settings.apiKeyEnv&&!process.env[settings.apiKeyEnv];
  add('model',keyMissing?'missing':'check',keyMissing?'模型密钥环境变量未设置，请设置后重启服务':settings.model?'已保存模型 '+settings.model+'，请进行连接测试':'尚未配置模型 API，请保存后进行连接测试','model');
  const usable=employees.filter(e=>e.enabled && !e.deleted_at && runtimes.some(r=>r.id===e.runtime && r.available && r.managed));
  add('employees',usable.length?'ready':'missing',usable.length?`${usable.length} 位员工入口可用；登录、额度和能力需分别核对`:'没有可执行员工，请在任务与员工中注册并验证 CLI','missions');
  const account=budget?.accounts.find(a=>a.id===budget.policy.managerAccountId);
  const strict=budget && (budget.policy.limitMinor!==null || budget.policy.requireFreshQuota);
  if(account?.pause || strict&&!account)add('budget','missing',account?.pause?'管理者账户已暂停，请核对额度后恢复':'严格策略需要配置管理者账户与费用上界','budget');
  else if(account?.quotaState==='insufficient' || budget?.policy.requireFreshQuota && account?.quotaState!=='known')add('budget','missing','管理者额度不足、未知或已过期，请更新额度快照','budget');
  else if(account && (budget.policy.limitMinor!==null || account.limitMinor!==null) && (account.type!=='api' || budget.policy.managerEstimateMinor===null || budget.policy.limitMinor!==null && account.currency!==budget.policy.currency))add('budget','missing','费用预算需要匹配币种的 API 账户及每次推理费用上界','budget');
  if(policy)add('permission',policy.mode==='read_only'?'check':'ready',policy.mode==='full_access'?'工具已授权，成果仍需审查':policy.mode==='read_only'?'当前只读，不能派发员工任务':'按计划请求批准；需要项目工具时另行授权','permissions');
  return {projectId:project?.id??null,checkedAt:new Date().toISOString(),checks,canPlan:checks.filter(c=>['project','manager','model','budget'].includes(c.id)).every(c=>c.state!=='missing'),canExecute:usable.length>0&&policy?.mode!=='read_only'&&checks.every(c=>c.state!=='missing'),authenticationVerified:false};
}
