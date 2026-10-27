/**
 * 任务交付 - 汇总任务交付状态，生成恢复指纹和检查报告
 *
 * 所属层级：项目层
 * 核心功能：
 *   - deliveryVersion：生成任务版本快照（包含任务、运行、交接三表状态），用于 TOCTOU 校验
 *   - createTaskDelivery：创建交付检查函数，汇总工作区状态、Git 检查、进程存活等信息
 *   - recoveryFingerprint：计算恢复指纹，用于判断任务状态是否发生变化需要恢复
 *   - 检测源项目版本（Git HEAD 或目录哈希）
 * 依赖关系：
 *   - 依赖 → [→ 见 src/projects/project-baseline.mjs] 获取项目源版本
 *   - 被 ← [→ 见 src/projects/delivery-inspection.mjs] 交付检查调用
 *   - 被 ← control-plane.mjs 调用，获取任务交付状态
 */
import {createHash} from 'node:crypto';

import {projectSourceVersion} from './project-baseline.mjs';

/**
 * deliveryVersion - 生成任务的版本快照字符串，用于 TOCTOU 并发校验
 * @param row - 数据库查询函数
 * @param id - 任务 ID
 * @returns JSON 字符串，包含任务记录、最新运行记录和交接记录
 */
export function deliveryVersion(row,id){return JSON.stringify({task:row('SELECT * FROM tasks WHERE id=?',id),run:row('SELECT id,status,pid,started_at,ended_at,exit_code FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',id),handoff:row('SELECT * FROM code_handoffs WHERE task_id=?',id)});}
/**
 * createTaskDelivery - 创建任务交付检查函数
 * @param row - 数据库查询函数
 * @param codeHandoffs - 代码交接处理器（提供 inspect 方法）
 * @param dataDir - ApiX 数据目录
 * @param isActive - 判断运行实例是否活跃的回调
 * @returns 异步函数 (id) => Promise<交付状态对象>
 */
export function createTaskDelivery({row,codeHandoffs,dataDir,isActive=()=>false}){
  return async function taskDelivery(id){
    const task=row('SELECT * FROM tasks WHERE id=?',id);if(!task)throw new Error('任务不存在');
    const handoff=row('SELECT * FROM code_handoffs WHERE task_id=?',id);let inspection=null;let error=null;
    // 对有工作区的任务，调用 inspect 检查工作区 Git 状态（冲突、文件列表、指纹、diff 预览）
    if(task.workspace_path && ['queued','completed','accepted','unknown','failed','blocked','needs_revision','cancelled'].includes(task.status)){try{inspection=(await codeHandoffs.inspect(task));}catch(e){error=String(e.message);}}
    // 获取最新运行记录
    const latestRun=row('SELECT id,status,pid,started_at,ended_at,exit_code FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',id)??null;
    // 检测进程是否可能仍然存在（通过发送信号 0 探测）
    let processMayExist=null;if(latestRun?.pid){try{process.kill(latestRun.pid,0);processMayExist=true;}catch(e){processMayExist=e.code==='ESRCH'?false:null;}}
    const managedActive=!!(latestRun && isActive(latestRun.id));let sourceHead=null;
    // 对没有工作区的任务（非托管任务），获取源项目的版本标识
    if(!task.workspace_path){const project=row('SELECT path FROM projects WHERE id=?',task.project_id);const repository=task.repository_id?row('SELECT path FROM project_repositories WHERE id=? AND project_id=?',task.repository_id,task.project_id):null;try{sourceHead=projectSourceVersion(repository?.path??project.path,dataDir);}catch{error='源项目无法检查，不能恢复';}}
    // 计算恢复指纹：综合任务状态、运行记录、文件指纹等，用于判断是否需要恢复
    const recoveryFingerprint=(!error && (!task.workspace_path || inspection?.fingerprint))?createHash('sha256').update(JSON.stringify({taskId:id,status:task.status,employeeId:task.employee_id,runtime:task.runtime,prompt:task.prompt,input:task.input_commit,run:latestRun,files:inspection?.fingerprint,sourceHead,handoffStatus:handoff?.status})).digest('hex'):null;
    return {taskId:id,status:task.status,workspacePath:task.workspace_path,inputCommit:task.input_commit,deliveryCommit:task.delivery_commit,inspection,error,latestRun,processMayExist,managedActive,recoveryFingerprint,sourceHead,handoff:handoff?{...handoff,report:JSON.parse(handoff.report)}:null};
  };
}
