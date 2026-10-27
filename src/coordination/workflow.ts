/**
 * 自动协作工作流 - 管理项目级自动协作设置的开启、关闭与默认约束
 *
 * 所属层级：协调层 - 工作流与恢复
 * 核心功能：
 *   1. 持久化每个项目的自动协作配置（启用/禁用、版本号、授权员工列表）
 *   2. 开启时自动将相关员工权限提升为 full_access
 *   3. 提供项目级默认约束（范围、约束、交付物、验收标准）
 * 依赖关系：
 *   - 依赖 [→ 见 src/coordination/contracts.ts] 的 Store / Permissions 类型
 *   - 被 [→ 见 src/coordination/workflow-recovery.mjs] 调用以读取协作配置
 */
import {type Store,object,text} from './contracts.js';
import type {Permissions} from './permissions.js';

/**
 * createWorkflow - 创建自动协作工作流管理器
 * @param store - 数据库访问层，提供 db / row / rows / now 等基础方法 [→ 见 src/coordination/contracts.ts]
 * @param permissions - 权限管理模块，用于查询和保存员工权限 [→ 见 src/coordination/permissions.ts]
 * @param employees - 返回当前可用员工列表的工厂函数
 * @returns 包含 get / save / defaults 三个方法的工作流对象
 */
export function createWorkflow(store:Store,permissions:Permissions,employees:()=>{id:string}[]) {
  const {db,row}=store;
  // 初始化工作流配置表：每个项目一条记录，body 为 JSON 序列化的配置
  db.exec('CREATE TABLE IF NOT EXISTS apix_workflows(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL)');

  /**
   * get - 读取指定项目的自动协作配置
   * @param projectId - 项目 ID
   * @returns 协作配置对象 { enabled, version, employeeIds }；若未配置则返回默认关闭状态
   */
  function get(projectId:string) {
    if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new Error('项目不存在');
    const saved=row<{body:string}>('SELECT body FROM apix_workflows WHERE project_id=?',projectId);
    return saved?JSON.parse(saved.body) as {enabled:boolean;version:number;employeeIds:string[]}: {enabled:false,version:0,employeeIds:[]};
  }

  /**
   * save - 保存（开启/关闭）自动协作配置，开启时自动提升权限
   * @param projectId - 项目 ID
   * @param input - 用户提交的配置，包含 enabled / version / employees / approved 等字段
   * @returns 更新后的协作配置
   *
   * 关键流程：
   *   1. 乐观锁校验 version，防止并发覆盖
   *   2. 开启时校验授权批准、员工数量与去重
   *   3. 将非 full_access 的员工/ApiX 权限自动提升（前提是无活跃任务）
   *   4. 使用 SAVEPOINT 保证原子性
   */
  function save(projectId:string,input:Record<string,unknown>) {
    const previous=get(projectId);
    // 乐观锁：版本号必须匹配，且 enabled 必须是布尔值
    if(input.version!==previous.version || typeof input.enabled!=='boolean')throw new Error('自动协作设置已变化或输入无效，请刷新');
    let employeeIds=previous.employeeIds;
    db.exec('SAVEPOINT workflow');
    try{
      if(input.enabled){
        // 开启自动协作的前置条件：用户明确批准 + 至少 1 位且不超过 30 位员工
        if(input.approved!==true || !Array.isArray(input.employees) || !input.employees.length || input.employees.length>30)throw new Error('开启自动协作需要明确授权 ApiX 和至少一位可用员工');
        const selected=input.employees.map(value=>object(value));employeeIds=selected.map(e=>text(e.id,100));
        // 校验员工 ID 不重复且全部存在于当前可用员工列表中
        if(new Set(employeeIds).size!==employeeIds.length || employeeIds.some(id=>!employees().some(e=>e.id===id)))throw new Error('授权员工不可用或重复');
        // 构造权限变更清单：ApiX 自身 + 每位被选中的员工
        const subjects=[{id:'apix',version:Number(input.managerVersion)},...selected.map(e=>({id:String(e.id),version:Number(e.version)}))];
        const changes=subjects.filter(subject=>{
          const policy=permissions.get(projectId,subject.id);
          if(policy.version!==subject.version)throw new Error('权限已更新，请刷新后重试');
          return policy.mode!=='full_access';
        });
        // 复用现有权限时不能撤销已排队/运行中任务的授权
        if(changes.length){
          // 存在活跃任务时禁止提升权限，防止干扰正在执行的工作
          const active=row<{id:string;status:string}>("SELECT id,status FROM tasks WHERE project_id=? AND status IN ('running','starting','stopping','queued','unknown') LIMIT 1",projectId);
          if(active)throw new Error(`本项目任务 ${active.id}（${active.status}）尚未处理，不能提升执行权限；请在原对话的工作详情中检查并停止或恢复任务后重试。已有完全访问权限时可直接开启自动协作。`);
          // 逐一将权限提升为 full_access
          for(const subject of changes)permissions.save(projectId,subject.id,'full_access',subject.version);
        }
      }
      // 版本号递增并持久化到数据库
      const result={enabled:input.enabled,version:previous.version+1,employeeIds};
      db.prepare('INSERT INTO apix_workflows VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body').run(projectId,JSON.stringify(result));
      db.exec('RELEASE workflow');return result;
    }catch(error){db.exec('ROLLBACK TO workflow');db.exec('RELEASE workflow');throw error;}
  }

  /**
   * defaults - 获取项目级默认约束模板（范围、约束、交付物、验收标准）
   * @param projectId - 项目 ID
   * @returns 包含 scope / constraints / deliverable / acceptance 四个默认字段的对象
   */
  function defaults(projectId:string) {
    const project=row<{name:string;path:string}>('SELECT name,path FROM projects WHERE id=?',projectId)!;
    return {scope:`当前项目 ${project.name}（${project.path}），仅处理本次对话目标相关内容`,constraints:'遵守项目规则和现有权限、额度及预算；不扩大任务，不执行未授权发布或删除操作；代码交付必须经过审查',deliverable:'与用户目标对应的可检查成果、变更说明和验证证据',acceptance:'执行与任务相符的检查或测试，提交证据；代码由用户审查后冻结验收，不自动通过验收'};
  }
  return {get,save,defaults};
}
