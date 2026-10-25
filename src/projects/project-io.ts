import {Worker} from 'node:worker_threads';

interface Job {operation:string;args:unknown[];resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}
interface Slot {worker:Worker;job:Job|null;stopping:boolean}
// Two workers bound filesystem pressure; queued work has the same finite deadline.
export function createProjectIo({workerUrl=new URL('../../../src/projects/project-io-worker.mjs',import.meta.url),timeoutMs=120000}={}){
  const workers=new Set<Slot>(),queue:Job[]=[];
  function drain(){
    while(queue.length){
      let slot=[...workers].find(w=>!w.job&&!w.stopping);
      if(!slot){
        if(workers.size>=2)return;
        // Worker environments are case-sensitive on Windows; host process.env is not.
        const env={...process.env};if(process.platform==='win32')for(const name of ['PATH','SystemRoot','WINDIR','ComSpec','PATHEXT']){const key=Object.keys(env).find(k=>k.toLowerCase()===name.toLowerCase());if(key)env[name]=env[key];}
        const worker=new Worker(workerUrl,{env}),created:Slot={worker,job:null,stopping:false};slot=created;workers.add(created);
        worker.on('message',message=>{const job=created.job;if(!job||created.stopping)return;created.job=null;clearTimeout(job.timer);worker.unref();message.error?job.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):job.resolve(message.result);drain();});
        worker.on('error',error=>{created.stopping=true;if(created.job){clearTimeout(created.job.timer);created.job.reject(error);created.job=null;}});
        worker.on('exit',()=>{workers.delete(created);if(created.job){clearTimeout(created.job.timer);created.job.reject(new Error('项目文件检查进程中断'));}drain();});
        worker.unref();
      }
      const job=queue.shift()!;slot.job=job;slot.worker.ref();
      try{slot.worker.postMessage({operation:job.operation,args:job.args});}catch(error){slot.job=null;clearTimeout(job.timer);job.reject(error as Error);slot.worker.unref();}
    }
  }
  return (operation:string,args:unknown[]):Promise<any>=>new Promise((resolve,reject)=>{
    if(queue.length>=32){reject(new Error('项目文件检查繁忙，请稍后重试'));return;}
    const job:Job={operation,args,resolve,reject,timer:setTimeout(()=>{
      const index=queue.indexOf(job);if(index!==-1)queue.splice(index,1);const slot=[...workers].find(w=>w.job===job);
      if(slot){slot.stopping=true;slot.job=null;void slot.worker.terminate();}reject(new Error('项目文件检查超时，请核对项目后重试'));
    },timeoutMs)};
    queue.push(job);drain();
  });
}
export const projectIo=createProjectIo();
const baselines=new Map<string,Promise<any>>();
export async function projectBaseline(...args:unknown[]){
  const key=JSON.stringify(args.slice(0,3)),previous=baselines.get(key),job=(previous??Promise.resolve()).catch(()=>{}).then(()=>projectIo('projectBaseline',args));
  baselines.set(key,job);try{return await job;}finally{if(baselines.get(key)===job)baselines.delete(key);}
}
export const projectSourceVersion=(...args:unknown[])=>projectIo('projectSourceVersion',args);
