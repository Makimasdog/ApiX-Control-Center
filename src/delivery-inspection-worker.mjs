import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createCodeHandoffs} from './code-handoffs.mjs';
import {createTaskDelivery,deliveryVersion} from './task-delivery.mjs';
const db=new DatabaseSync(workerData.database,{readOnly:true});
const row=(sql,...params)=>db.prepare(sql).get(...params);const rows=(sql,...params)=>db.prepare(sql).all(...params);
try{
  if(deliveryVersion(row,workerData.id)!==workerData.version)throw new Error('检查期间任务状态已变化，请重新检查');
  const codeHandoffs=createCodeHandoffs({db,row,rows,dataDir:workerData.dataDir,persistWorkspace:false});
  const result=createTaskDelivery({row,codeHandoffs})(workerData.id);
  if(deliveryVersion(row,workerData.id)!==workerData.version)throw new Error('检查期间任务状态已变化，请重新检查');
  parentPort.postMessage({result});
}catch(error){parentPort.postMessage({error:String(error.message)});}finally{db.close();}
