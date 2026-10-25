import {createHash} from 'node:crypto';

import {projectSourceVersion} from './project-baseline.mjs';

export function deliveryVersion(row,id){return JSON.stringify({task:row('SELECT * FROM tasks WHERE id=?',id),run:row('SELECT id,status,pid,started_at,ended_at,exit_code FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',id),handoff:row('SELECT * FROM code_handoffs WHERE task_id=?',id)});}
export function createTaskDelivery({row,codeHandoffs,dataDir,isActive=()=>false}){
  return async function taskDelivery(id){
    const task=row('SELECT * FROM tasks WHERE id=?',id);if(!task)throw new Error('任务不存在');
    const handoff=row('SELECT * FROM code_handoffs WHERE task_id=?',id);let inspection=null;let error=null;
    if(task.workspace_path && ['queued','completed','accepted','unknown','failed','blocked','needs_revision','cancelled'].includes(task.status)){try{inspection=(await codeHandoffs.inspect(task));}catch(e){error=String(e.message);}}
    const latestRun=row('SELECT id,status,pid,started_at,ended_at,exit_code FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',id)??null;
    let processMayExist=null;if(latestRun?.pid){try{process.kill(latestRun.pid,0);processMayExist=true;}catch(e){processMayExist=e.code==='ESRCH'?false:null;}}
    const managedActive=!!(latestRun && isActive(latestRun.id));let sourceHead=null;
    if(!task.workspace_path){const project=row('SELECT path FROM projects WHERE id=?',task.project_id);const repository=task.repository_id?row('SELECT path FROM project_repositories WHERE id=? AND project_id=?',task.repository_id,task.project_id):null;try{sourceHead=projectSourceVersion(repository?.path??project.path,dataDir);}catch{error='源项目无法检查，不能恢复';}}
    const recoveryFingerprint=(!error && (!task.workspace_path || inspection?.fingerprint))?createHash('sha256').update(JSON.stringify({taskId:id,status:task.status,employeeId:task.employee_id,runtime:task.runtime,prompt:task.prompt,input:task.input_commit,run:latestRun,files:inspection?.fingerprint,sourceHead,handoffStatus:handoff?.status})).digest('hex'):null;
    return {taskId:id,status:task.status,workspacePath:task.workspace_path,inputCommit:task.input_commit,deliveryCommit:task.delivery_commit,inspection,error,latestRun,processMayExist,managedActive,recoveryFingerprint,sourceHead,handoff:handoff?{...handoff,report:JSON.parse(handoff.report)}:null};
  };
}
