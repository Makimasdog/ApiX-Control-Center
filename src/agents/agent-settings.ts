/**
 * Agent Settings - Codex 额度查询、CLI 参数构建与推理强度控制
 *
 * 所属层级：员工适配层（src/agents/）
 * 核心功能：
 *   1. 构建不同运行时的 CLI 启动参数，并根据任务难度映射 Codex 推理强度
 *   2. 通过 spawn Codex app-server 子进程，以 JSON-RPC 协议查询账户额度与模型列表
 *   3. 将 Codex 返回的原始额度数据规范化为统一的 quota 结构
 * 依赖关系：
 *   - 被 src/control-plane.mjs 调用，用于任务执行前构建参数和查询额度
 *   - 依赖 runtime-adapters.ts 的 Command 接口 [→ 见 src/agents/runtime-adapters.ts]
 */
import {spawn,execFile} from 'node:child_process';
import type {Command} from './runtime-adapters.js';

/**
 * executionArgs - 根据运行时、配置文件和任务难度，构建传给 AI CLI 的启动参数
 * @param runtime - 运行时标识，如 'codex'、'claude' 等
 * @param profile - 员工配置，包含模型名称和可选的推理强度设置
 * @param difficulty - 任务难度（1-5），用于在 'auto' 模式下自动选择推理强度
 * @param modelArgs - 回调函数，由调用方提供每个运行时特有的模型参数
 * @returns 拼接好的 CLI 参数数组
 * 设计意图：推理强度（reasoning effort）目前只有 Codex 支持，所以其他运行时会直接报错；
 *   'auto' 模式会将数字难度映射为 low/medium/high，让简单任务省 token、复杂任务更仔细
 */
export function executionArgs(runtime:string,profile:{model:string;reasoningEffort?:string|null},difficulty:number|null|undefined,modelArgs:(runtime:string,model:string)=>string[]){
  const args=modelArgs(runtime,profile.model);
  if(profile.reasoningEffort){
    if(runtime!=='codex')throw new Error('推理强度参数目前仅支持 Codex');
    // auto 模式：根据难度自动选择——≤2 用 low 省额度，≤3 用 medium 平衡，>3 用 high 全力推理
    const effort=profile.reasoningEffort==='auto'?(difficulty==null?'medium':difficulty<=2?'low':difficulty<=3?'medium':'high'):profile.reasoningEffort;
    if(!['low','medium','high','xhigh'].includes(effort))throw new Error('推理强度参数无效');
    // Codex 通过 -c 传递配置项，值用 JSON 字符串包裹
    args.push('-c',`model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  return args;
}

/**
 * inspectCodex - 启动 Codex app-server 子进程，查询当前登录账户的额度与可用模型
 * @param command - Codex CLI 的可执行路径和前缀参数 [→ 见 src/agents/runtime-adapters.ts Command 接口]
 * @param env - 传递给子进程的环境变量
 * @param timeoutMs - 查询超时时间（毫秒），默认 12 秒
 * @returns 包含额度信息（quota）和模型列表（models）的结构化对象
 * 设计意图：Codex 的 app-server 使用 JSON-RPC over stdio 协议通信，
 *   我们通过 stdin 发请求、从 stdout 逐行读 JSON 响应，实现只读查询（不会触发推理或修改配置）
 */
// Read-only app-server requests: no inference turn, login, config write or token-file access.
export async function inspectCodex(command:Command,env:NodeJS.ProcessEnv,timeoutMs=12000){
  // 启动 Codex app-server 子进程，使用 stdio 管道进行 JSON-RPC 通信
  const child=spawn(command.executable,[...command.prefix,'app-server','--listen','stdio://'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');child.stderr.resume();
  // pending: 等待响应的请求 Map（id → resolve/reject）；buffer: 用于逐行拼接 stdout 输出
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();let id=0,buffer='',bytes=0,closed=false;
  // fail - 统一拒绝所有待处理请求并清理
  const fail=(error:Error)=>{for(const p of pending.values())p.reject(error);pending.clear();};
  // kill - 强制终止子进程，Windows 用 taskkill /T 杀整棵进程树
  const kill=()=>{if(child.exitCode!==null||child.signalCode!==null)return;if(process.platform==='win32'&&child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:3000},()=>{});else child.kill('SIGKILL');};
  // 超时保护：防止 Codex 卡死导致查询永远挂起
  const timer=setTimeout(()=>{closed=true;fail(new Error('Codex 额度查询超时，请检查 CLI 登录和网络'));kill();},timeoutMs);
  child.on('error',()=>{closed=true;fail(new Error('无法启动 Codex，请检查 CLI 安装'));});
  child.on('close',()=>{closed=true;fail(new Error('Codex 查询进程已退出'));});
  child.stdin.on('error',()=>{closed=true;fail(new Error('Codex 查询连接已关闭'));});
  child.stdout.on('data',(chunk:string)=>{
    // 安全限制：响应超过 2MB 就终止，防止异常输出撑爆内存
    bytes+=Buffer.byteLength(chunk);if(bytes>2_000_000){closed=true;fail(new Error('Codex 查询响应过大'));kill();return;}
    buffer+=chunk;let index;
    // 逐行解析 JSON-RPC 响应，匹配请求 id 后 resolve 对应的 Promise
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const value=JSON.parse(line);const p=pending.get(value.id);if(p){pending.delete(value.id);if(value.error)p.reject(new Error('Codex 不支持此查询或当前登录无法提供数据'));else p.resolve(value.result);}}catch{/* CLI diagnostic line is not protocol data. */}}
  });
  // request - 发送一条 JSON-RPC 请求并返回 Promise，实现异步请求-响应匹配
  const request=(method:string,params?:unknown)=>new Promise<any>((resolve,reject)=>{if(closed){reject(new Error('Codex 查询连接已关闭'));return;}const next=++id;pending.set(next,{resolve,reject});child.stdin.write(JSON.stringify({id:next,method,...(params===undefined?{}:{params})})+'\n');});
  try{
    // JSON-RPC 握手：先 initialize 再发 initialized 通知，然后并行查询额度和模型列表
    await request('initialize',{clientInfo:{name:'apix_control_center',title:'ApiX',version:'0.1.0'},capabilities:{}});
    child.stdin.write('{"method":"initialized"}\n');
    // Promise.allSettled 保证即使其中一个查询失败，另一个的结果仍然可用
    const [limits,catalog]=await Promise.allSettled([request('account/rateLimits/read'),request('model/list',{limit:100})]);
    const quota=limits.status==='fulfilled'?normalizeQuota(limits.value):{state:'unknown',windows:[],message:limits.reason.message};
    // 模型列表：最多取 100 个，提取模型标识、显示名和支持的推理强度等级
    const models=catalog.status==='fulfilled'&&Array.isArray(catalog.value?.data)?catalog.value.data.slice(0,100).map((m:any)=>({model:String(m.model??m.id??'').slice(0,200),name:String(m.displayName??m.model??'').slice(0,200),efforts:Array.isArray(m.supportedReasoningEfforts)?m.supportedReasoningEfforts.map((e:any)=>String(e.reasoningEffort)).filter((e:string)=>['none','minimal','low','medium','high','xhigh','max','ultra'].includes(e)):[]})):[];
    return {source:'codex-app-server',observedAt:new Date().toISOString(),quota,models,modelMessage:catalog.status==='rejected'?catalog.reason.message:null};
  }finally{clearTimeout(timer);child.stdin.end();kill();}
}

/**
 * normalizeQuota - 将 Codex 返回的原始额度数据转换为统一的窗口结构
 * @param value - Codex account/rateLimits/read 的原始返回值
 * @returns 包含 state（known/unknown）和 windows 数组的规范化额度对象
 * 设计意图：Codex 的额度按 bucket（如 'codex'）和 window（primary/secondary）分层，
 *   我们只关心「剩余百分比」，所以用 100 - usedPercent 转换，并过滤掉无效数据
 */
export function normalizeQuota(value:any){
  // 兼容两种返回格式：rateLimitsByLimitId（多 bucket）和 rateLimits（单 bucket）
  const buckets:[string,any][]=value?.rateLimitsByLimitId&&typeof value.rateLimitsByLimitId==='object'?Object.entries(value.rateLimitsByLimitId):value?.rateLimits?[['codex',value.rateLimits]]:[];
  // 展开每个 bucket 的 primary/secondary 窗口，提取剩余百分比和重置时间
  const windows=buckets.flatMap(([id,bucket]:[string,any])=>['primary','secondary'].flatMap(key=>{
    const w=bucket?.[key];if(typeof w?.usedPercent!=='number'||!Number.isFinite(w.usedPercent))return [];
    return [{bucket:String(id).slice(0,100),window:key,remainingPercent:Math.max(0,Math.min(100,100-w.usedPercent)),windowDurationMins:typeof w.windowDurationMins==='number'?w.windowDurationMins:null,resetsAt:typeof w.resetsAt==='number'?w.resetsAt:null}];
  }));
  return {state:windows.length?'known':'unknown',windows,message:windows.length?null:'此登录未返回订阅额度；API Key 登录不能查询订阅额度'};
}
