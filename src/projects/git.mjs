/**
 * Git 操作队列 - 封装 git 命令调用，提供并发控制和排队超时机制
 *
 * 所属层级：项目层
 * 核心功能：
 *   - 限制同时运行的 git 进程数量上限为 4
 *   - 排队队列上限 64，超出直接拒绝
 *   - 排队超时和执行超时双重保护，避免 git 命令永久挂起
 *   - 支持通过 stdin 传入数据（如 git apply --check 的 patch 输入）
 * 依赖关系：
 *   - 被 ← [→ 见 src/projects/code-handoffs.mjs] 代码交接中的 Git 操作
 *   - 被 ← control-plane.mjs / server.mjs 等模块调用
 */
import {execFile} from 'node:child_process';

/** 当前正在执行的 git 进程数 */
let active=0;const queue=[];
/** drain - 从队列中取出任务执行，直到达到并发上限或队列为空 */
function drain(){
  while(active<4&&queue.length){
    const job=queue.shift();clearTimeout(job.timer);const timeout=job.deadline-performance.now();
    // 如果排队期间已超时，直接拒绝
    if(timeout<=0){job.reject(Object.assign(new Error('Git 排队超时，请重新检查'),{code:'ETIMEDOUT'}));continue;}
    active++;
    try{
      // 执行 git 命令：设置工作目录、编码、输出上限、超时等参数
      const child=execFile('git',job.args,{cwd:job.cwd,encoding:'utf8',maxBuffer:10000000,windowsHide:true,...job.options,timeout:Math.ceil(timeout)},(error,stdout,stderr)=>{
        active--;if(error){error.stderr=stderr;job.reject(error);}else job.resolve(stdout);drain();
      });
      // 如果有 stdin 输入（如 patch 数据），写入后关闭
      if(child.stdin){child.stdin.on('error',()=>{});child.stdin.end(job.input);}
    }catch(error){active--;job.reject(error);}
  }
}
/**
 * git - 提交一个 git 命令到执行队列
 * @param cwd - 工作目录（Git 仓库路径）
 * @param args - git 命令参数数组，如 ['rev-parse', 'HEAD']
 * @param options - 可选参数，支持 input（stdin 数据）、timeout（超时毫秒数，默认 20000）等
 * @returns Promise<string> - git 命令的 stdout 输出
 */
export function git(cwd,args,{input,...options}={}){
  return new Promise((resolve,reject)=>{
    // 排队队列满时直接拒绝
    if(queue.length>=64){reject(Object.assign(new Error('Git 操作繁忙，请稍后重试'),{code:'GIT_BUSY'}));return;}
    const budget=options.timeout??20000,job={cwd,args,input,options,resolve,reject,deadline:performance.now()+budget,timer:null};
    // 排队超时计时器：超时后从队列移除并拒绝
    job.timer=setTimeout(()=>{const index=queue.indexOf(job);if(index!==-1){queue.splice(index,1);reject(Object.assign(new Error('Git 排队超时，请重新检查'),{code:'ETIMEDOUT'}));}},budget);
    queue.push(job);drain();
  });
}
