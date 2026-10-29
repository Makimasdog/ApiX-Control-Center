/**
 * 项目 IO 池 - 管理文件操作的 Worker 线程池，提供超时控制和并发限制
 *
 * 所属层级：项目层
 * 核心功能：
 *   - 创建最多 2 个 Worker 线程处理文件系统密集型操作
 *   - 队列化管理 IO 请求，限制排队上限为 32
 *   - 为每个 IO 操作提供可配置超时（默认 120 秒）
 *   - 处理 Windows 环境变量大小写差异
 *   - 提供 projectBaseline 的串行化缓存，避免重复基线操作
 * 依赖关系：
 *   - 依赖 → [→ 见 src/projects/project-io-worker.mjs] 工作线程实现
 *   - 被 ← control-plane.mjs / server.mjs 等上层模块调用
 */
import {Worker} from 'node:worker_threads';

/** 队列中等待执行的 IO 任务 */
interface Job {operation:string;args:unknown[];resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}
/** 一个 Worker 线程槽位，包含线程引用、当前任务、是否正在停止 */
interface Slot {worker:Worker;job:Job|null;stopping:boolean}
// Two workers bound filesystem pressure; queued work has the same finite deadline.
/**
 * createProjectIo - 创建项目 IO 线程池，返回一个统一的异步调用入口
 * @param workerUrl - Worker 脚本路径，默认为 ./project-io-worker.mjs
 * @param timeoutMs - 单次 IO 操作超时时间（毫秒），默认 120000
 * @returns 函数 (operation, args) => Promise，用于向线程池提交任务
 */
export function createProjectIo({workerUrl=new URL('../../../src/projects/project-io-worker.mjs',import.meta.url),timeoutMs=120000}={}){
  const workers=new Set<Slot>(),queue:Job[]=[];
  /** drain - 尝试将队列中的任务分配给空闲 Worker；若无空闲 Worker 且未达上限则创建新 Worker */
  function drain(){
    while(queue.length){
      let slot=[...workers].find(w=>!w.job&&!w.stopping);
      if(!slot){
        if(workers.size>=2)return;
        // Worker 环境变量在 Windows 上区分大小写，而宿主进程环境变量不区分
        // 此处将 PATH、SystemRoot 等关键变量按 Worker 期望的名称重新赋值
        const env={...process.env};if(process.platform==='win32')for(const name of ['PATH','SystemRoot','WINDIR','ComSpec','PATHEXT']){const key=Object.keys(env).find(k=>k.toLowerCase()===name.toLowerCase());if(key)env[name]=env[key];}
        const worker=new Worker(workerUrl,{env}),created:Slot={worker,job:null,stopping:false};slot=created;workers.add(created);
        // Worker 返回消息时：清除超时计时器，解除 Worker 引用（允许进程退出），分发结果或错误
        worker.on('message',message=>{const job=created.job;if(!job||created.stopping)return;created.job=null;clearTimeout(job.timer);worker.unref();message.error?job.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):job.resolve(message.result);drain();});
        // Worker 发生未捕获错误时：标记为停止中，拒绝当前任务
        worker.on('error',error=>{created.stopping=true;if(created.job){clearTimeout(created.job.timer);created.job.reject(error);created.job=null;}});
        // Worker 退出时：从池中移除，若还有未完成任务则拒绝，并尝试调度队列
        worker.on('exit',()=>{workers.delete(created);if(created.job){clearTimeout(created.job.timer);created.job.reject(new Error('项目文件检查进程中断'));}drain();});
        worker.unref();
      }
      const job=queue.shift()!;slot.job=job;slot.worker.ref();
      try{slot.worker.postMessage({operation:job.operation,args:job.args});}catch(error){slot.job=null;clearTimeout(job.timer);job.reject(error as Error);slot.worker.unref();}
    }
  }
  return (operation:string,args:unknown[]):Promise<any>=>new Promise((resolve,reject)=>{
    // 队列满时直接拒绝，防止内存无限增长
    if(queue.length>=32){reject(new Error('项目文件检查繁忙，请稍后重试'));return;}
    const job:Job={operation,args,resolve,reject,timer:setTimeout(()=>{
      // 超时处理：从队列移除任务，终止对应 Worker
      const index=queue.indexOf(job);if(index!==-1)queue.splice(index,1);const slot=[...workers].find(w=>w.job===job);
      if(slot){slot.stopping=true;slot.job=null;void slot.worker.terminate();}reject(new Error('项目文件检查超时，请核对项目后重试'));
    },timeoutMs)};
    queue.push(job);drain();
  });
}
/** 默认全局 IO 池实例，供各模块直接引用 */
export const projectIo=createProjectIo();
/** 基线操作缓存：相同参数的基线操作串行执行，避免并发冲突 */
const baselines=new Map<string,Promise<any>>();
/**
 * projectBaseline - 串行化执行基线操作，相同参数的并发调用会排队等待
 * @param args - 传递给 projectIo('projectBaseline', ...) 的参数
 * @returns 基线操作结果
 */
export async function projectBaseline(...args:unknown[]){
  const key=JSON.stringify(args.slice(0,3)),previous=baselines.get(key),job=(previous??Promise.resolve()).catch(()=>{}).then(()=>projectIo('projectBaseline',args));
  baselines.set(key,job);try{return await job;}finally{if(baselines.get(key)===job)baselines.delete(key);}
}
/** projectSourceVersion - 获取项目源版本标识（Git commit 或目录哈希） */
export const projectSourceVersion=(...args:unknown[])=>projectIo('projectSourceVersion',args);
