import {type Store,object,text} from './contracts.js';
import type {Permissions} from './permissions.js';
export function createWorkflow(store:Store,permissions:Permissions,employees:()=>{id:string}[]) {
  const {db,row}=store;
  db.exec('CREATE TABLE IF NOT EXISTS apix_workflows(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL)');
  function get(projectId:string) {
    if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new Error('项目不存在');
    const saved=row<{body:string}>('SELECT body FROM apix_workflows WHERE project_id=?',projectId);
    return saved?JSON.parse(saved.body) as {enabled:boolean;version:number;employeeIds:string[]}: {enabled:false,version:0,employeeIds:[]};
  }
  function save(projectId:string,input:Record<string,unknown>) {
    const previous=get(projectId);
    if(input.version!==previous.version || typeof input.enabled!=='boolean')throw new Error('自动协作设置已变化或输入无效，请刷新');
    let employeeIds=previous.employeeIds;
    db.exec('SAVEPOINT workflow');
    try{
      if(input.enabled){
        if(input.approved!==true || !Array.isArray(input.employees) || !input.employees.length || input.employees.length>30)throw new Error('开启自动协作需要明确授权 ApiX 和至少一位可用员工');
        const selected=input.employees.map(value=>object(value));employeeIds=selected.map(e=>text(e.id,100));
        if(new Set(employeeIds).size!==employeeIds.length || employeeIds.some(id=>!employees().some(e=>e.id===id)))throw new Error('授权员工不可用或重复');
        const subjects=[{id:'apix',version:Number(input.managerVersion)},...selected.map(e=>({id:String(e.id),version:Number(e.version)}))];
        const changes=subjects.filter(subject=>{
          const policy=permissions.get(projectId,subject.id);
          if(policy.version!==subject.version)throw new Error('权限已更新，请刷新后重试');
          return policy.mode!=='full_access';
        });
        // Reusing current permissions must not revoke existing queued/running task grants.
        if(changes.length){
          const active=row<{id:string;status:string}>("SELECT id,status FROM tasks WHERE project_id=? AND status IN ('running','starting','stopping','queued','unknown') LIMIT 1",projectId);
          if(active)throw new Error(`本项目任务 ${active.id}（${active.status}）尚未处理，不能提升执行权限；请在原对话的工作详情中检查并停止或恢复任务后重试。已有完全访问权限时可直接开启自动协作。`);
          for(const subject of changes)permissions.save(projectId,subject.id,'full_access',subject.version);
        }
      }
      const result={enabled:input.enabled,version:previous.version+1,employeeIds};
      db.prepare('INSERT INTO apix_workflows VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body').run(projectId,JSON.stringify(result));
      db.exec('RELEASE workflow');return result;
    }catch(error){db.exec('ROLLBACK TO workflow');db.exec('RELEASE workflow');throw error;}
  }
  function defaults(projectId:string) {
    const project=row<{name:string;path:string}>('SELECT name,path FROM projects WHERE id=?',projectId)!;
    return {scope:`当前项目 ${project.name}（${project.path}），仅处理本次对话目标相关内容`,constraints:'遵守项目规则和现有权限、额度及预算；不扩大任务，不执行未授权发布或删除操作；代码交付必须经过审查',deliverable:'与用户目标对应的可检查成果、变更说明和验证证据',acceptance:'执行与任务相符的检查或测试，提交证据；代码由用户审查后冻结验收，不自动通过验收'};
  }
  return {get,save,defaults};
}
