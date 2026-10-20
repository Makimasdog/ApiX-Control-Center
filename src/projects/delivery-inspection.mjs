import {Worker} from 'node:worker_threads';
import {deliveryVersion} from './task-delivery.mjs';
export function createDeliveryInspection({database,dataDir,row,isActive=()=>false,workerUrl=new URL('./delivery-inspection-worker.mjs',import.meta.url)}){
  let active=0;
  return async (id,quality=false)=>{
    if(!row('SELECT id FROM tasks WHERE id=?',id))throw new Error('任务不存在');
    if(active>=2)throw new Error('代码检查正在进行，请稍后重试');
    const version=deliveryVersion(row,id);active++;
    return await new Promise((resolve,reject)=>{
      let worker;try{worker=new Worker(workerUrl,{workerData:{database,dataDir,id,version,quality}});}catch(error){active--;reject(error);return;}let settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{finish(new Error('代码检查超时，请检查 Git 状态后重试'));void worker.terminate().catch(()=>{});},120000);
      worker.once('message',message=>{try{if(message.error){finish(new Error(message.error));return;}if(deliveryVersion(row,id)!==version){finish(new Error('检查期间任务状态已变化，请重新检查'));return;}const result=message.result;result.managedActive=!!(result.latestRun&&isActive(result.latestRun.id));finish(null,result);}catch(error){finish(error);}});
      worker.once('error',error=>finish(error));worker.once('exit',()=>{active--;if(!settled)finish(new Error('代码检查进程中断，请重试'));});
    });
  };
}
