/**
 * 交付检查工作线程 - 在独立线程中执行任务交付的代码检查和版本校验
 *
 * 所属层级：项目层
 * 核心功能：
 *   - 以只读方式打开数据库，避免与主线程写操作冲突
 *   - 执行前后双重 TOCTOU 版本校验，确保检查期间任务状态未被修改
 *   - 调用 codeHandoffs.inspect 检查工作区 Git 状态（冲突、文件变更、指纹等）
 *   - 可选地附加质量上下文（qualityContext），提供代码审查所需的项目文件内容
 * 依赖关系：
 *   - 被 ← [→ 见 src/projects/delivery-inspection.mjs] 作为 Worker 线程调用
 *   - 依赖 → [→ 见 src/projects/code-handoffs.mjs] 代码交接检查
 *   - 依赖 → [→ 见 src/projects/task-delivery.mjs] 任务交付版本
 */
import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createCodeHandoffs} from './code-handoffs.mjs';
import {createTaskDelivery,deliveryVersion} from './task-delivery.mjs';
// 以只读模式打开数据库，Worker 线程内不执行写操作
const db=new DatabaseSync(workerData.database,{readOnly:true});
const row=(sql,...params)=>db.prepare(sql).get(...params);const rows=(sql,...params)=>db.prepare(sql).all(...params);
try{
  // 前置 TOCTOU 校验：确认任务版本与调度时一致
  if(deliveryVersion(row,workerData.id)!==workerData.version)throw new Error('检查期间任务状态已变化，请重新检查');
  // 创建代码交接处理器（persistWorkspace=false 表示不修改工作区记录）
  const codeHandoffs=createCodeHandoffs({db,row,rows,dataDir:workerData.dataDir,persistWorkspace:false});
  // 执行任务交付检查：获取工作区状态、冲突列表、文件指纹、diff 预览等
  const result=(await createTaskDelivery({row,codeHandoffs,dataDir:workerData.dataDir})(workerData.id));
  // 如果请求了质量检查（quality=true），附加项目文件内容作为审查上下文
  if(workerData.quality && result.inspection)result.inspection.context=(await codeHandoffs.qualityContext(row('SELECT * FROM tasks WHERE id=?',workerData.id)));
  // 后置 TOCTOU 校验：确保检查期间任务未被并发修改
  if(deliveryVersion(row,workerData.id)!==workerData.version)throw new Error('检查期间任务状态已变化，请重新检查');
  parentPort.postMessage({result});
}catch(error){parentPort.postMessage({error:String(error.message)});}finally{db.close();}
