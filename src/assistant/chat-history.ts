/**
 * chat-history.ts - 对话历史管理：管理助手和协调两种会话的归档、删除与恢复
 *
 * 所属层级：助手层 - 对话管理
 * 核心功能：
 *   1. 对话列表查询——支持 active / archived / deleted 三种视图
 *   2. 对话状态变更——归档、删除、恢复操作，带版本乐观锁
 *   3. 自动迁移——为历史表添加 archived_at / deleted_at 列（如不存在）
 *   4. 跨会话类型统一管理——assistant_sessions 和 coordination_sessions 共用逻辑
 * 依赖关系：
 *   - 被前端对话列表页面调用
 *   - 依赖 [→ 见 src/coordination/contracts.ts] 的 Store 接口访问数据库
 */
import type {Store} from '../coordination/contracts.js';

/** 两种会话表名映射：assistant 为助手对话，coordination 为协调对话 */
const tables={assistant:'assistant_sessions',coordination:'coordination_sessions'} as const;

/**
 * historyColumns - 确保会话表包含 archived_at 和 deleted_at 列
 * 若缺失则自动 ALTER TABLE 添加，实现平滑迁移。
 * @param store - 数据库 Store
 * @param kind - 会话类型（'assistant' 或 'coordination'）
 */
export function historyColumns(store:Store,kind:keyof typeof tables){const table=tables[kind];for(const name of ['archived_at','deleted_at'])if(!store.rows<{name:string}>(`PRAGMA table_info(${table})`).some(c=>c.name===name))store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);}

/**
 * 创建对话历史管理器
 * @param store - 数据库 Store
 * @param active - 判断某个会话是否仍在运行中的回调函数（用于阻止归档/删除活跃会话）
 * @returns 包含 list 和 change 两个方法的历史管理器
 */
export function createChatHistory(store:Store,active:(kind:string,id:string)=>boolean){
  // 初始化时确保两张表都有归档/删除列
  for(const kind of ['assistant','coordination'] as const)historyColumns(store,kind);
  return {
    /**
     * list - 列出指定项目的对话历史
     * @param projectId - 项目 ID
     * @param view - 视图类型：'active'（未归档未删除）、'archived'（已归档未删除）、'deleted'（已删除）
     * @returns 按更新时间倒序排列的对话列表，合并 assistant 和 coordination 两种类型
     */
    list(projectId:string,view='active'){if(!store.row('SELECT id FROM projects WHERE id=?',projectId))throw new Error('项目不存在');if(!['active','archived','deleted'].includes(view))throw new Error('历史筛选无效');const where=view==='deleted'?'deleted_at IS NOT NULL':view==='archived'?'deleted_at IS NULL AND archived_at IS NOT NULL':'deleted_at IS NULL AND archived_at IS NULL';return (Object.entries(tables).flatMap(([kind,table])=>store.rows<{updated_at:string;[key:string]:unknown}>(`SELECT id,project_id,title,status,${kind==='assistant'?'version':'revision'} AS version,updated_at,archived_at,deleted_at FROM ${table} WHERE project_id=? AND ${where} ORDER BY updated_at DESC LIMIT 500`,projectId).map(s=>({...s,kind})))).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));},

    /**
     * change - 对对话执行归档、删除或恢复操作
     *
     * 操作前会进行多重校验：
     *   1. 版本乐观锁——input.version 必须匹配当前版本，防止并发覆盖
     *   2. 活跃检查——归档或删除前必须先停止该对话的所有运行中任务
     *   3. 操作合法性——只允许 archive / delete / restore 三种操作
     *
     * @param kind - 会话类型（'assistant' 或 'coordination'）
     * @param id - 对话 ID
     * @param input - 操作参数，包含 action 和 version
     * @returns 操作结果摘要
     */
    change(kind:string,id:string,input:Record<string,unknown>){if(!(kind in tables)||!Object.hasOwn(tables,kind))throw new Error('历史类型无效');const table=tables[kind as keyof typeof tables],column=kind==='assistant'?'version':'revision';const s=store.row<{version:number;deleted_at:string|null;archived_at:string|null}>(`SELECT *,${column} AS version FROM ${table} WHERE id=?`,id);if(!s||input.version!==s.version)throw new Error('对话已变化，请刷新');if(typeof input.action!=='string'||!['archive','delete','restore'].includes(input.action))throw new Error('历史操作无效');if(input.action!=='restore'&&active(kind,id))throw new Error('请先停止或处理该对话的运行、待审批、排队及状态未知任务，再归档或删除');const stamp=store.now();store.db.prepare(`UPDATE ${table} SET archived_at=?,deleted_at=?,${column}=${column}+1,updated_at=? WHERE id=?`).run(input.action==='archive'?stamp:input.action==='delete'?s.archived_at:null,input.action==='delete'?stamp:null,stamp,id);return {id,kind,action:input.action};}
  };
}
