/**
 * 交付检查调度器 - 在 Worker 线程中执行任务交付前的代码质量检查
 *
 * 所属层级：项目层
 * 核心功能：
 *   - 限制最多 2 个并发检查任务
 *   - 在独立 Worker 线程中执行检查，避免阻塞主线程
 *   - 120 秒超时保护
 *   - 检查前后进行 TOCTOU 验证：确保任务版本在检查期间未变化
 *   - 检查结果包含检查报告、最新运行状态、进程存活信息等
 * 依赖关系：
 *   - 依赖 → [→ 见 src/projects/task-delivery.mjs] 获取 deliveryVersion 版本快照
 *   - 依赖 → [→ 见 src/projects/delivery-inspection-worker.mjs] Worker 线程实现
 *   - 被 ← control-plane.mjs 调用，用于任务交付前的质量门禁
 */
import {Worker} from 'node:worker_threads';
import {deliveryVersion} from './task-delivery.mjs';
/**
 * createDeliveryInspection - 创建交付检查函数
 * @param database - SQLite 数据库路径
 * @param dataDir - ApiX 数据目录
 * @param row - 数据库查询函数
 * @param isActive - 判断运行实例是否活跃的回调函数
 * @param workerUrl - Worker 脚本路径
 * @returns 异步检查函数 (id, quality) => Promise<检查结果>
 */
export function createDeliveryInspection({database,dataDir,row,isActive=()=>false,workerUrl=new URL('./delivery-inspection-worker.mjs',import.meta.url)}){
  let active=0;
  return async (id,quality=false)=>{
    if(!row('SELECT id FROM tasks WHERE id=?',id))throw new Error('任务不存在');
    // 并发上限为 2
    if(active>=2)throw new Error('代码检查正在进行，请稍后重试');
    // 记录检查前的任务版本快照，用于 TOCTOU 校验
    const version=deliveryVersion(row,id);active++;
    return await new Promise((resolve,reject)=>{
      let worker;try{worker=new Worker(workerUrl,{workerData:{database,dataDir,id,version,quality}});}catch(error){active--;reject(error);return;}let settled=false;
      /** finish - 统一的结果处理：清除超时计时器，确保只回调一次 */
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
      // 120 秒超时：终止 Worker 并拒绝 Promise
      const timer=setTimeout(()=>{finish(new Error('代码检查超时，请检查 Git 状态后重试'));void worker.terminate().catch(()=>{});},120000);
      // Worker 返回结果：再次校验版本未变化，附加 managedActive 标记
      worker.once('message',message=>{try{if(message.error){finish(new Error(message.error));return;}if(deliveryVersion(row,id)!==version){finish(new Error('检查期间任务状态已变化，请重新检查'));return;}const result=message.result;result.managedActive=!!(result.latestRun&&isActive(result.latestRun.id));finish(null,result);}catch(error){finish(error);}});
      worker.once('error',error=>finish(error));worker.once('exit',()=>{active--;if(!settled)finish(new Error('代码检查进程中断，请重试'));});
    });
  };
}
