import { createHash } from 'node:crypto';
import { type Store, type Employee, type PlanStep, object, text } from './contracts.js';

export interface CapabilityProfile {
  model: string; tags: string[]; tools: string[]; languages: string[]; projectIds: string[];
  accountId: string | null; contextTokens: number | null; version: number; updatedAt: string | null;
  reasoningLevel?: number | null;
  reasoningEffort?: string | null;
  pricing?: {model:string;version:string;currency:string;inputMinorPerMillion:number;outputMinorPerMillion:number} | null;
}
export interface TaskProfile {
  kind: 'implementation' | 'testing' | 'review' | 'analysis' | 'docs';
  tags: string[]; tools: string[]; writePaths: string[]; contextTokens: number | null;
  fixedEmployeeId: string | null; estimateMinor: number | null; minutes: number | null;
  estimates: {employeeId:string;estimateMinor:number|null;minutes:number|null}[];
  difficulty?: number | null;
  workload?: {inputTokens:number;outputTokens:number;calls:number} | null;
}
interface Account {
  id: string; alias: string; type: 'subscription' | 'api'; currency: string | null;
  limitMinor: number | null; remainingPercent: number | null; reservePercent: number;
  observedAt: string | null; resetsAt: string | null; version: number;
}
interface Policy { version: number; quotaMaxAgeMinutes: number; requireFreshQuota: boolean; limitMinor: number | null; currency: string | null; managerAccountId:string|null;managerEstimateMinor:number|null }
const blankProfile: CapabilityProfile = { model:'',tags:[],tools:[],languages:[],projectIds:[],accountId:null,contextTokens:null,version:0,updatedAt:null };
export function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 30 || value.some(v=>typeof v!=='string' || !v.trim() || v.length>200)) throw new Error(`${name} 必须为最多 30 项的文本数组`);
  return [...new Set(value.map(v=>String(v).trim()))];
}
function integer(value: unknown, name: string, max = 1_000_000_000): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value)<0 || Number(value)>max) throw new Error(`${name} 必须为非负整数`);
  return Number(value);
}
function instant(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} 时间无效`);
  return new Date(value).toISOString();
}
function currency(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new Error('币种应为三位大写代码');
  return value;
}
export function taskProfile(value: unknown): TaskProfile {
  const v = value === undefined ? {} : object(value);
  const kind = v.kind ?? 'implementation';
  if (!['implementation','testing','review','analysis','docs'].includes(String(kind))) throw new Error('任务类型无效');
  const writePaths=list(v.writePaths ?? [],'写入范围');
  if (writePaths.some(p=>p.startsWith('/') || p.includes('\\') || /[*?\[\]{}]/.test(p) || p.split('/').some(s=>s==='..' || s==='.' || !s) || /^[a-z]:/i.test(p))) throw new Error('写入范围应为项目内相对路径，不支持通配符');
  if(v.estimates!==undefined && (!Array.isArray(v.estimates) || v.estimates.length>30))throw new Error('员工费用估计应为最多 30 项的数组');
  const estimates=(v.estimates as unknown[]|undefined ?? []).map(value=>{const e=object(value);return {employeeId:text(e.employeeId,100),estimateMinor:integer(e.estimateMinor,'员工费用上界'),minutes:integer(e.minutes,'员工预计分钟',10080)};});
  if(new Set(estimates.map(e=>e.employeeId)).size!==estimates.length)throw new Error('员工费用估计不能重复');
  const difficulty=integer(v.difficulty,'推理难度',5);if(difficulty===0)throw new Error('推理难度应为 1–5');
  let workload:TaskProfile['workload']=null;
  if(v.workload!=null){const w=object(v.workload);const inputTokens=integer(w.inputTokens,'输入 Token'),outputTokens=integer(w.outputTokens,'输出 Token'),calls=integer(w.calls,'调用次数',1000);if(inputTokens===null || outputTokens===null || !calls)throw new Error('工作量需要输入、输出 Token 及至少一次调用');workload={inputTokens,outputTokens,calls};}
  return {difficulty,workload,kind:kind as TaskProfile['kind'],tags:list(v.tags ?? [],'能力要求'),tools:list(v.tools ?? [],'工具要求'),writePaths,
    contextTokens:integer(v.contextTokens,'上下文量'),fixedEmployeeId:v.fixedEmployeeId==null?null:text(v.fixedEmployeeId,100),
    estimateMinor:integer(v.estimateMinor,'预计费用上界'),minutes:integer(v.minutes,'预计分钟',10080),estimates};
}
function forEmployee(spec:TaskProfile,employeeId:string):TaskProfile {const estimate=spec.estimates.find(e=>e.employeeId===employeeId);return estimate?{...spec,estimateMinor:estimate.estimateMinor,minutes:estimate.minutes}:spec;}
function forecast(profile:CapabilityProfile,spec:TaskProfile){const rate=profile.pricing?.model===profile.model?profile.pricing:null;const w=spec.workload;if(!rate||!w)return null;const amount=((BigInt(w.inputTokens)*BigInt(rate.inputMinorPerMillion)+BigInt(w.outputTokens)*BigInt(rate.outputMinorPerMillion))*BigInt(w.calls)+999999n)/1000000n;return amount<=BigInt(Number.MAX_SAFE_INTEGER)?Number(amount):null;}
export function overlaps(a: string[], b: string[]) { if(process.platform==='win32'){a=a.map(p=>p.toLowerCase());b=b.map(p=>p.toLowerCase());}return a.some(x=>b.some(y=>x===y || x.startsWith(y+'/') || y.startsWith(x+'/'))); }

export function createScheduling(store: Store, dependencies: {
  employees(): Employee[]; available(runtime: string): boolean; denied(projectId: string, employeeId: string, drafting?:boolean): boolean;
  waiting(task: {id:string;project_id:string;employee_id:string;runtime:string}): string | null;
  supportsModel?(runtime:string):boolean;
}) {
  const {db,row,rows,now}=store;
  const activeManagers=new Set<string>();
  db.exec(`CREATE TABLE IF NOT EXISTS scheduling_profiles(employee_id TEXT PRIMARY KEY REFERENCES employees(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_accounts(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_policies(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),body TEXT NOT NULL,decision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_attempts(run_id TEXT PRIMARY KEY REFERENCES runs(id),employee_id TEXT NOT NULL,model TEXT NOT NULL,kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_reservations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,account_id TEXT,amount INTEGER,currency TEXT,state TEXT NOT NULL,actual INTEGER,created_at TEXT NOT NULL);`);
  db.exec('CREATE TABLE IF NOT EXISTS scheduling_account_pauses(account_id TEXT PRIMARY KEY,reason TEXT NOT NULL,source_id TEXT NOT NULL,created_at TEXT NOT NULL)');
  if(!rows<{name:string}>('PRAGMA table_info(scheduling_attempts)').some(c=>c.name==='observed_model'))db.exec('ALTER TABLE scheduling_attempts ADD COLUMN observed_model TEXT');
  function profile(id: string): CapabilityProfile { const saved=row<{body:string}>('SELECT body FROM scheduling_profiles WHERE employee_id=?',id);return saved?JSON.parse(saved.body) as CapabilityProfile:{...blankProfile}; }
  function accounts(): Account[] {return rows<{body:string}>('SELECT body FROM scheduling_accounts ORDER BY id').map(r=>JSON.parse(r.body) as Account);}
  function policy(projectId: string): Policy {
    if (!row('SELECT id FROM projects WHERE id=?',projectId)) throw new Error('项目不存在');
    const saved=row<{body:string}>('SELECT body FROM scheduling_policies WHERE project_id=?',projectId);
    return saved?JSON.parse(saved.body) as Policy:{version:0,quotaMaxAgeMinutes:60,requireFreshQuota:false,limitMinor:null,currency:null,managerAccountId:null,managerEstimateMinor:null};
  }
  function saveProfile(id: string,input: Record<string,unknown>) {
    if (!row('SELECT id FROM employees WHERE id=? AND deleted_at IS NULL',id)) throw new Error('员工不存在');
    const previous=profile(id);if(input.version!==previous.version)throw new Error('能力档案已变化，请刷新');
    const accountId=input.accountId==null || input.accountId===''?null:text(input.accountId,100);
    if(accountId && !accounts().some(a=>a.id===accountId))throw new Error('账户不存在');
    const model=input.model==null?'':String(input.model).trim();if(model.length>200)throw new Error('模型名称过长');
    const reasoningLevel=integer(input.reasoningLevel,'推理能力',5);if(reasoningLevel===0)throw new Error('推理能力应为 1–5');
    const reasoningEffort=input.reasoningEffort===undefined?previous.reasoningEffort??null:input.reasoningEffort===''||input.reasoningEffort===null?null:String(input.reasoningEffort);
    if(reasoningEffort && !['auto','low','medium','high','xhigh'].includes(reasoningEffort))throw new Error('推理强度应为 auto、low、medium、high 或 xhigh');
    if(reasoningEffort && dependencies.employees().find(e=>e.id===id)?.runtime!=='codex')throw new Error('推理强度参数目前仅支持 Codex');
    let pricing:CapabilityProfile['pricing']=null;
    if(input.pricing!=null){const rate=object(input.pricing);const rateModel=text(rate.model,200);const rateCurrency=currency(rate.currency);const inputRate=integer(rate.inputMinorPerMillion,'输入费率'),outputRate=integer(rate.outputMinorPerMillion,'输出费率');if(!model || rateModel!==model || !rateCurrency || inputRate===null || outputRate===null)throw new Error('费率必须对应声明的模型并包含币种与输入/输出价格');pricing={model:rateModel,version:text(rate.version,100),currency:rateCurrency,inputMinorPerMillion:inputRate,outputMinorPerMillion:outputRate};}
    if(pricing && accountId){const account=accounts().find(a=>a.id===accountId)!;if(account.type!=='api'||account.currency!==pricing.currency)throw new Error('预测费率需要同币种 API 账户，订阅额度不能换算费用');}
    const projectIds=list(input.projectIds ?? [],'熟悉项目');if(projectIds.some(p=>!row('SELECT id FROM projects WHERE id=?',p)))throw new Error('熟悉项目不存在');
    const result:CapabilityProfile={reasoningEffort,reasoningLevel,pricing,model,tags:list(input.tags ?? [],'能力标签'),tools:list(input.tools ?? [],'工具'),languages:list(input.languages ?? [],'语言'),projectIds,
      contextTokens:integer(input.contextTokens,'上下文容量'),accountId,version:previous.version+1,updatedAt:now()};
    db.prepare('INSERT INTO scheduling_profiles VALUES (?,?) ON CONFLICT(employee_id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(result));return result;
  }
  function saveAccount(input: Record<string,unknown>) {
    const id=text(input.id,100);const previous=accounts().find(a=>a.id===id);
    if(input.version!==(previous?.version ?? 0))throw new Error('账户快照已变化，请刷新');
    if(!['subscription','api'].includes(String(input.type)))throw new Error('账户类型无效');
    const remainingPercent=integer(input.remainingPercent,'剩余额度百分比',100);const reservePercent=integer(input.reservePercent ?? 10,'保留额度百分比',100)!;
    const observedAt=instant(input.observedAt,'观测');const resetsAt=instant(input.resetsAt,'重置');
    if(remainingPercent!==null && !observedAt)throw new Error('额度数据需要观测时间');
    if(observedAt && Date.parse(observedAt)>Date.now()+60000)throw new Error('观测时间不能在未来');
    const result:Account={id,alias:text(input.alias,100),type:input.type as Account['type'],currency:currency(input.currency),limitMinor:integer(input.limitMinor,'账户费用预算'),remainingPercent,reservePercent,observedAt,resetsAt,version:(previous?.version ?? 0)+1};
    if(result.type==='subscription' && (result.currency || result.limitMinor!==null))throw new Error('订阅额度不能换算金额');
    if(result.type==='api' && !result.currency)throw new Error('API 账户需要声明费用币种；未知用量仍保持未知');
    if(result.limitMinor!==null && !result.currency)throw new Error('费用预算需要币种');
    if(previous && (previous.type!==result.type || previous.currency!==result.currency) && row("SELECT id FROM scheduling_reservations WHERE account_id=? AND state!='released' LIMIT 1",id))throw new Error('账户已有费用记录，不能更换计费类型或币种');
    db.prepare('INSERT INTO scheduling_accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(result));return result;
  }
  function pauseAccountId(accountId:string|null,sourceId:string) {if(accountId)db.prepare('INSERT INTO scheduling_account_pauses VALUES (?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET source_id=excluded.source_id,created_at=excluded.created_at').run(accountId,'运行时报告额度或速率限制，请核对后明确恢复',sourceId,now());}
  function pauseAccount(employeeId:string,sourceId:string) {pauseAccountId(profile(employeeId).accountId,sourceId);}
  function resumeAccount(input:Record<string,unknown>) {const id=text(input.id,100);const account=accounts().find(a=>a.id===id);if(!account || input.version!==account.version || input.reviewed!==true)throw new Error('请刷新账户并明确确认已核对额度');db.prepare('DELETE FROM scheduling_account_pauses WHERE account_id=?').run(id);return account;}
  function savePolicy(projectId: string,input: Record<string,unknown>) {
    const old=policy(projectId);if(input.version!==old.version)throw new Error('调度策略已变化，请刷新');
    if(typeof input.requireFreshQuota!=='boolean')throw new Error('严格额度检查必须为布尔值');
    const age=integer(input.quotaMaxAgeMinutes ?? 60,'额度有效分钟',10080);if(!age)throw new Error('额度有效分钟必须大于零');
    const managerAccountId=input.managerAccountId==null || input.managerAccountId===''?null:text(input.managerAccountId,100);
    if(managerAccountId && !accounts().some(a=>a.id===managerAccountId))throw new Error('ApiX 推理账户不存在');
    const result:Policy={version:old.version+1,quotaMaxAgeMinutes:age,requireFreshQuota:input.requireFreshQuota,limitMinor:integer(input.limitMinor,'项目费用预算'),currency:currency(input.currency),managerAccountId,managerEstimateMinor:integer(input.managerEstimateMinor,'ApiX 每次推理费用上界')};
    if(result.limitMinor!==null && !result.currency)throw new Error('项目预算需要币种');
    if(old.currency!==result.currency && row("SELECT id FROM scheduling_reservations WHERE project_id=? AND amount IS NOT NULL AND state!='released' AND currency IS NOT ? LIMIT 1",projectId,result.currency))throw new Error('项目已有其他币种的费用记录，不能隐式换汇');
    db.prepare('INSERT INTO scheduling_policies VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body').run(projectId,JSON.stringify(result));return result;
  }
  function quota(account: Account | undefined,p: Policy) {
    if(!account || account.remainingPercent===null || !account.observedAt)return 'unknown';
    if(Date.now()-Date.parse(account.observedAt)>p.quotaMaxAgeMinutes*60000 || account.resetsAt && Date.parse(account.resetsAt)<=Date.now())return 'stale';
    return account.remainingPercent<=account.reservePercent?'insufficient':'known';
  }
  function usage(projectId: string, accountId: string | null) {
    return row<{committed:number}>(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual WHEN state IN ('reserved','unmeasured') THEN amount ELSE 0 END),0) AS committed FROM scheduling_reservations WHERE ${accountId?'account_id=?':'project_id=?'}`,accountId ?? projectId)!.committed;
  }
  function check(projectId: string, employeeId: string, spec: TaskProfile, drafting=false): {reasons:string[];warnings:string[];account:Account|undefined} {
    spec=forEmployee(spec,employeeId);
    const p=policy(projectId);const e=dependencies.employees().find(e=>e.id===employeeId);const profileValue=profile(employeeId);const account=accounts().find(a=>a.id===profileValue.accountId);
    const reasons:string[]=[];const warnings:string[]=[];
    if(account && row('SELECT account_id FROM scheduling_account_pauses WHERE account_id=?',account.id))reasons.push('共享账户因额度或速率错误暂停，需明确恢复');
    if(!e || !e.enabled || !dependencies.available(e.runtime))reasons.push('员工停用或运行时不可用');
    if(dependencies.denied(projectId,employeeId,drafting))reasons.push('员工或管理者为只读权限');
    if(spec.fixedEmployeeId && spec.fixedEmployeeId!==employeeId)reasons.push('用户指定了另一员工');
    if(spec.tags.some(t=>!profileValue.tags.includes(t)))reasons.push('缺少用户声明的必要能力标签');
    if(spec.tools.some(t=>!profileValue.tools.includes(t)))reasons.push('缺少必要工具声明');
    if(spec.contextTokens!==null && (profileValue.contextTokens===null || profileValue.contextTokens<spec.contextTokens))reasons.push('上下文容量不足或未知');
    if(spec.difficulty!=null && (profileValue.reasoningLevel==null || profileValue.reasoningLevel<spec.difficulty))reasons.push('声明的推理能力不足或未知');
    if(spec.difficulty!=null && profileValue.model && e && dependencies.supportsModel?.(e.runtime)===false)reasons.push('适配器尚未验证显式模型选择，不能依据该档案路由');
    const predicted=forecast(profileValue,spec);if(predicted!==null && spec.estimateMinor!==null && predicted>spec.estimateMinor)reasons.push('预测费用超过用户批准的执行上界');
    const q=quota(account,p);
    if(q==='insufficient')reasons.push('剩余额度已触及保留线');
    else if(q!=='known'){warnings.push(q==='stale'?'额度快照已过期':'额度未知');if(p.requireFreshQuota)reasons.push('严格策略需要新鲜额度快照');}
    for(const [limit,spent,code,scope,scopeId] of [[p.limitMinor,usage(projectId,null),p.currency,'project_id',projectId],[account?.limitMinor ?? null,usage(projectId,account?.id ?? null),account?.currency ?? null,'account_id',account?.id ?? '']] as const) {
      if(limit===null)continue;
      if(!account || account.type!=='api' || account.currency!==code)reasons.push('预算币种或 API 账户不匹配');
      else if(row(`SELECT id FROM scheduling_reservations WHERE ${scope}=? AND currency IS NOT NULL AND state IN ('reserved','unmeasured') AND amount IS NULL LIMIT 1`,scopeId))reasons.push('历史费用未知，请核对结算后启用严格预算');
      else if(spec.estimateMinor===null)(drafting?warnings:reasons).push('严格费用预算需要用户批准的费用上界');
      else if(spent+spec.estimateMinor>limit)reasons.push('已用及预留费用超过预算');
    }
    if(!profileValue.model)warnings.push('模型版本未知');
    if(!spec.writePaths.length)warnings.push('文件范围未声明，不能据此保证并行写入互不重叠');
    if(spec.estimateMinor!==null && account?.type!=='api')reasons.push('费用上界需要 API 账户');
    return {reasons:[...new Set(reasons)],warnings,account};
  }
  function history(employeeId: string, model: string, kind: string) {
    return row<{samples:number;accepted:number;rework:number;averageMs:number|null}>(`SELECT COUNT(*) AS samples,COALESCE(SUM(json_extract(e.payload,'$.accepted')=1),0) AS accepted,COALESCE(SUM(json_extract(e.payload,'$.accepted')=0),0) AS rework,AVG(CASE WHEN r.ended_at IS NOT NULL THEN (julianday(r.ended_at)-julianday(r.started_at))*86400000 END) AS averageMs FROM scheduling_attempts a JOIN runs r ON r.id=a.run_id JOIN events e ON e.run_id=r.id AND e.kind='task_reviewed' AND e.source='user' AND json_type(e.payload,'$.type') IS NULL AND json_type(e.payload,'$.accepted') IN ('true','false') WHERE a.employee_id=? AND a.model=? AND a.model!='' AND a.observed_model=a.model AND a.kind=?`,employeeId,model,kind)!;
  }
  function candidates(projectId: string, spec: TaskProfile, preferred: string | null = null) {
    const items=dependencies.employees().map(e=>{
      const p=profile(e.id);const gate=check(projectId,e.id,spec,true);const stats=history(e.id,p.model,spec.kind);
      const wait=dependencies.waiting({id:'',project_id:projectId,employee_id:e.id,runtime:e.runtime});
      const tasks=row<{count:number}>("SELECT COUNT(*) AS count FROM tasks WHERE employee_id=? AND status IN ('running','stopping','queued','unknown')",e.id)!.count;
      const estimate=forEmployee(spec,e.id);
      const rate=p.pricing?.model===p.model?p.pricing:null;
      const forecastMinor=forecast(p,spec);
      return {employeeId:e.id,name:e.name,eligible:gate.reasons.length===0,reasons:gate.reasons,warnings:gate.warnings,waiting:wait,model:p.model || null,reasoningLevel:p.reasoningLevel??null,forecastMinor,forecastCurrency:rate?.currency??null,forecastSource:forecastMinor===null?'unknown':'declared_rates_and_estimated_workload',rateVersion:rate?.version??null,profileVersion:p.version,capabilitySource:'user_declared',history:stats,projectFamiliar:p.projectIds.includes(projectId),queuedTasks:tasks,preferred:e.id===preferred,estimateMinor:estimate.estimateMinor,minutes:estimate.minutes ?? (stats.samples>=3 && stats.averageMs!==null?Math.ceil(stats.averageMs/60000):null),timeSource:estimate.minutes!==null?'user_estimate':stats.samples>=3?'accepted_history':'unknown',currency:gate.account?.currency ?? null};
    });
    const measured=items.filter(i=>i.eligible && i.estimateMinor!==null);
    const comparable=measured.length>0 && measured.every(i=>i.currency && i.currency===measured[0]!.currency);
    if(spec.difficulty!=null){
      const forecasts=items.filter(i=>i.eligible && i.forecastMinor!==null);const comparableForecast=forecasts.length>0 && forecasts.every(i=>i.forecastCurrency===forecasts[0]!.forecastCurrency);
      return items.sort((a,b)=>Number(b.eligible)-Number(a.eligible) || (comparableForecast?(Number(a.forecastMinor===null)-Number(b.forecastMinor===null) || (a.forecastMinor??0)-(b.forecastMinor??0)):0) || Number(!!a.waiting)-Number(!!b.waiting) || b.history.accepted/Math.max(1,b.history.samples)-a.history.accepted/Math.max(1,a.history.samples) || a.queuedTasks-b.queuedTasks || Number(b.preferred)-Number(a.preferred) || a.employeeId.localeCompare(b.employeeId));
    }
    // Missing fees are never zero, and different currencies are never converted implicitly.
    return items.sort((a,b)=>Number(b.eligible)-Number(a.eligible) || Number(!!a.waiting)-Number(!!b.waiting) || Number(b.history.samples>=3 && b.history.accepted===b.history.samples)-Number(a.history.samples>=3 && a.history.accepted===a.history.samples) || Number(b.projectFamiliar)-Number(a.projectFamiliar) || (comparable?(Number(a.estimateMinor===null)-Number(b.estimateMinor===null) || (a.estimateMinor ?? 0)-(b.estimateMinor ?? 0)):0) || Number(a.minutes===null)-Number(b.minutes===null) || (a.minutes ?? 0)-(b.minutes ?? 0) || a.queuedTasks-b.queuedTasks || Number(b.preferred)-Number(a.preferred) || a.employeeId.localeCompare(b.employeeId));
  }
  function assign(projectId: string, steps: PlanStep[], reselect: boolean) {
    if(steps.some((s,i)=>s.dependsOn.some(n=>!Number.isInteger(n) || n<0 || n>=i)))throw new Error('依赖只能引用前序步骤');
    const selected=steps.map(step=>{const spec=taskProfile(step.scheduling);const options=candidates(projectId,spec,step.employeeId);const chosen=reselect?options.find(e=>e.eligible):options.find(e=>e.employeeId===step.employeeId && e.eligible);
      if(!chosen)throw new Error('没有满足任务能力、权限及预算约束的员工，请检查候选原因');
      return {...step,employeeId:chosen.employeeId,scheduling:spec,decision:{strategy:'balanced',selectedEmployeeId:chosen.employeeId,candidates:options,estimateSource:'user_approved_upper_bound'}};
    });
    for(const step of selected)if(step.scheduling.kind==='review'){
      const authors=step.dependsOn.map(n=>selected[n]!.employeeId);
      if(reselect){const independent=step.decision.candidates.find(e=>e.eligible && !authors.includes(e.employeeId));if(independent){step.employeeId=independent.employeeId;step.decision.selectedEmployeeId=independent.employeeId;}}
      Object.assign(step.decision,{reviewMode:!authors.length?'unverified_independence':authors.includes(step.employeeId)?'self_review':'independent'});
    }
    function depends(index:number,other:number):boolean{return selected[index]!.dependsOn.some(n=>n===other || depends(n,other));}
    for(let i=0;i<selected.length;i++)for(let j=0;j<i;j++)if(!depends(i,j) && overlaps(selected[i]!.scheduling.writePaths,selected[j]!.scheduling.writePaths))throw new Error('并行任务写入范围重叠，请增加依赖或调整文件归属');
    return selected;
  }
  function bind(taskId: string,spec: unknown,decision: unknown,projectId?:string) {const d=object(decision);db.prepare('INSERT INTO scheduling_tasks VALUES (?,?,?)').run(taskId,JSON.stringify(taskProfile(spec)),JSON.stringify({...d,configuration:projectId?fingerprint(projectId,[String(d.selectedEmployeeId)]):null}));}
  function approveBinding(taskId:string,projectId:string,employeeId:string) {
    const saved=row<{decision:string}>('SELECT decision FROM scheduling_tasks WHERE task_id=?',taskId);
    if(saved)db.prepare('UPDATE scheduling_tasks SET decision=? WHERE task_id=?').run(JSON.stringify({...JSON.parse(saved.decision),selectedEmployeeId:employeeId,configuration:fingerprint(projectId,[employeeId])}),taskId);
  }
  function taskSpec(taskId:string):TaskProfile {const saved=row<{body:string}>('SELECT body FROM scheduling_tasks WHERE task_id=?',taskId);return taskProfile(saved?JSON.parse(saved.body):undefined);}
  function assertBinding(taskId:string,projectId:string,employeeId:string){const saved=row<{decision:string}>('SELECT decision FROM scheduling_tasks WHERE task_id=?',taskId);const binding=saved?JSON.parse(saved.decision).configuration as string|null:null;if(binding && binding!==fingerprint(projectId,[employeeId]))throw new Error('能力、账户或调度配置已变化，请检查后重新批准任务');}
  function admission(task:{id:string;project_id:string;employee_id:string}) {
    const saved=row<{decision:string}>('SELECT decision FROM scheduling_tasks WHERE task_id=?',task.id);const binding=saved?JSON.parse(saved.decision).configuration as string|null:null;
    if(binding && binding!==fingerprint(task.project_id,[task.employee_id]))return '能力、账户或调度配置已变化，请检查后重新批准任务';
    return check(task.project_id,task.employee_id,taskSpec(task.id)).reasons.join('；') || null;
  }
  function reserve(id:string,projectId:string,employeeId:string,spec:TaskProfile) {
    spec=forEmployee(spec,employeeId);
    db.exec('SAVEPOINT budget_admission');
    try{
      const existing=row<{state:string}>('SELECT state FROM scheduling_reservations WHERE id=?',id);if(existing)throw new Error('预算预留已存在，不能重复启动');
      const checked=check(projectId,employeeId,spec);if(checked.reasons.length)throw new Error(checked.reasons.join('；'));
      if(spec.estimateMinor!==null && checked.account?.type!=='api')throw new Error('费用上界需要 API 账户，不能用于订阅额度');
      db.prepare('INSERT INTO scheduling_reservations VALUES (?,?,?,?,?,?,?,?)').run(id,projectId,checked.account?.id ?? null,spec.estimateMinor,checked.account?.currency ?? null,'reserved',null,now());
      db.exec('RELEASE budget_admission');
    }catch(error){db.exec('ROLLBACK TO budget_admission');db.exec('RELEASE budget_admission');throw error;}
  }
  function settle(id:string,actual:number|null,unused=false) {
    activeManagers.delete(id);
    const amount=integer(actual,'观测费用');
    db.prepare("UPDATE scheduling_reservations SET state=?,actual=? WHERE id=? AND state='reserved'").run(unused?'released':amount===null?'unmeasured':'settled',amount,id);
  }
  function settleReported(projectId:string,input:Record<string,unknown>) {
    const id=text(input.id,200);const existing=row<{state:string}>('SELECT state FROM scheduling_reservations WHERE id=? AND project_id=?',id,projectId);
    if(!existing || !['unmeasured','reserved'].includes(existing.state) || input.reviewed!==true)throw new Error('只能明确审查后结算尚未测量的记录');
    if(existing.state==='reserved'){
      const run=row<{status:string}>('SELECT status FROM runs WHERE id=?',id);
      const meeting=row('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'planning_meetings\'')?row<{status:string}>('SELECT status FROM planning_meetings WHERE id=?',id.split(':')[0]!):undefined;
      const ended=run && ['unknown','cancelled','completed','failed','blocked'].includes(run.status) || meeting?.status==='interrupted' || /^(apix|assistant):/.test(id) && !activeManagers.has(id);
      if(!ended || input.confirmedStopped!==true)throw new Error('预留仍可能有运行进程；请确认原进程已停止，活动运行不能结算');
    }
    const amount=integer(input.actualMinor,'人工核对费用');if(amount===null)throw new Error('需要核对费用，不能把未知当成零');
    const updated=db.prepare("UPDATE scheduling_reservations SET state='settled',actual=? WHERE id=? AND state=?").run(amount,id,existing.state);
    if(updated.changes!==1)throw new Error('此费用记录已由其他请求处理，请刷新');
    return view(projectId);
  }
  function reserveManager(id:string,projectId:string) {
    const p=policy(projectId);const account=accounts().find(a=>a.id===p.managerAccountId);
    const unresolved=rows<{id:string}>("SELECT id FROM scheduling_reservations WHERE state='reserved' AND id LIKE 'assistant:%' AND (project_id=? OR account_id=?)",projectId,p.managerAccountId).find(r=>!activeManagers.has(r.id));
    if(unresolved)throw new Error('历史推理预留的账本状态未确认，请先核对并结算');
    if(!account){if(p.limitMinor!==null || p.requireFreshQuota)throw new Error('严格预算或额度策略需要先指定 ApiX 推理账户及费用上界');return false;}
    db.exec('SAVEPOINT manager_budget');
    try{
      if(row('SELECT account_id FROM scheduling_account_pauses WHERE account_id=?',account.id))throw new Error('ApiX 共享账户已暂停，请核对额度后明确恢复');
      const q=quota(account,p);if(q==='insufficient' || p.requireFreshQuota && q!=='known')throw new Error('ApiX 推理账户额度不足、未知或已过期');
      if(p.managerEstimateMinor!==null && account.type!=='api')throw new Error('订阅推理账户不能换算费用');
      for(const [limit,code,scope,scopeId] of [[p.limitMinor,p.currency,'project_id',projectId],[account.limitMinor,account.currency,'account_id',account.id]] as const){
        if(limit===null)continue;
        if(account.type!=='api' || account.currency!==code || p.managerEstimateMinor===null)throw new Error('ApiX 推理预算需要匹配币种的 API 账户及每次费用上界');
        if(row(`SELECT id FROM scheduling_reservations WHERE ${scope}=? AND currency IS NOT NULL AND amount IS NULL AND state IN ('reserved','unmeasured') LIMIT 1`,scopeId))throw new Error('历史推理费用未知，请先核对');
        if(usage(projectId,scope==='account_id'?account.id:null)+p.managerEstimateMinor>limit)throw new Error('ApiX 推理费用预留超过预算');
      }
      db.prepare('INSERT INTO scheduling_reservations VALUES (?,?,?,?,?,?,?,?)').run(id,projectId,account.id,p.managerEstimateMinor,account.currency,'reserved',null,now());
      db.exec('RELEASE manager_budget');activeManagers.add(id);return true;
    }catch(error){db.exec('ROLLBACK TO manager_budget');db.exec('RELEASE manager_budget');throw error;}
  }
  function attempt(runId:string,taskId:string,employeeId:string) {const p=profile(employeeId);db.prepare('INSERT INTO scheduling_attempts(run_id,employee_id,model,kind) VALUES (?,?,?,?)').run(runId,employeeId,p.model,taskSpec(taskId).kind);}
  function observeModel(runId:string,item:Record<string,unknown>) {
    const message=item.message && typeof item.message==='object'?item.message as Record<string,unknown>:{};
    const model=item.model ?? message.model;if(typeof model!=='string' || !model.trim() || model.length>200)return;
    db.prepare("UPDATE scheduling_attempts SET observed_model=CASE WHEN observed_model IS NULL OR observed_model=? THEN ? ELSE '[mixed models]' END WHERE run_id=?").run(model,model,runId);
  }
  function view(projectId:string) {const p=policy(projectId);const currencies=rows<{currency:string}>("SELECT DISTINCT currency FROM scheduling_reservations WHERE project_id=? AND amount IS NOT NULL AND state!='released'",projectId);return {strategy:'balanced',policy:p,accounts:accounts().map(a=>({...a,source:'manual',confidence:'user_reported',quotaState:quota(a,p),pause:row('SELECT * FROM scheduling_account_pauses WHERE account_id=?',a.id)??null,committedMinor:usage(projectId,a.id)})),profiles:dependencies.employees().map(e=>({employeeId:e.id,...profile(e.id)})),committedMinor:currencies.length>1?null:usage(projectId,null),ledger:rows('SELECT * FROM scheduling_reservations WHERE project_id=? ORDER BY rowid DESC LIMIT 100',projectId)};}
  function reports(planId:string) {return rows<{task_id:string;body:string;decision:string}>('SELECT s.* FROM scheduling_tasks s JOIN tasks t ON t.id=s.task_id WHERE t.plan_id=?',planId).map(r=>({taskId:r.task_id,profile:JSON.parse(r.body),decision:JSON.parse(r.decision)}));}
  function fingerprint(projectId:string,employeeIds?:string[]) {const p=policy(projectId);const employees=dependencies.employees().filter(e=>!employeeIds || employeeIds.includes(e.id)).map(e=>({id:e.id,enabled:e.enabled,runtime:e.runtime,denied:dependencies.denied(projectId,e.id),available:dependencies.available(e.runtime),profile:profile(e.id)}));const accountIds=employees.map(e=>e.profile.accountId).concat(p.managerAccountId);return createHash('sha256').update(JSON.stringify({policy:p,accounts:accounts().filter(a=>accountIds.includes(a.id)),employees})).digest('hex');}
  return {profile,saveProfile,accounts,saveAccount,pauseAccount,pauseAccountId,resumeAccount,policy,savePolicy,candidates,assign,bind,approveBinding,taskSpec,assertBinding,admission,reserve,reserveManager,settle,settleReported,attempt,observeModel,view,reports,fingerprint};
}
export type Scheduling = ReturnType<typeof createScheduling>;
