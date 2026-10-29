/**
 * 代码交接 - 管理 Agent 任务间的代码传递、冲突检测和交付冻结
 *
 * 所属层级：项目层
 * 核心功能：
 *   - workspace：验证任务工作区的完整性（Git worktree 路径、基线、Git 目录一致性）
 *   - inspect：检查工作区 Git 状态，返回冲突列表、文件变更、diff 预览和指纹
 *   - freeze：冻结交付版本，创建 Git commit 并写入 refs/apix/deliveries/ 引用
 *   - populate：将前置任务的交付代码应用到当前任务工作区（三方合并）
 *   - approveResolution：用户批准冲突解决后，更新 HEAD 和交接记录
 *   - ancestors：递归收集任务的所有已验收前置依赖
 *   - qualityContext：收集质量审查所需的项目文件内容
 * 依赖关系：
 *   - 依赖 → [→ 见 src/projects/git.mjs] Git 命令队列
 *   - 被 ← [→ 见 src/projects/delivery-inspection-worker.mjs] 交付检查调用
 *   - 被 ← [→ 见 src/projects/task-delivery.mjs] 任务交付检查
 *   - 被 ← control-plane.mjs 调用，处理代码交接流程
 */
import { createHash, randomUUID } from 'node:crypto';
import {git} from './git.mjs';
import { existsSync, mkdirSync, realpathSync, unlinkSync, readFileSync,statSync } from 'node:fs';
import { join, resolve,relative,isAbsolute } from 'node:path';

/** parts - 将 NUL 分隔的 Git 输出拆分为数组 */
const parts = value => value.split('\0').filter(Boolean);
/**
 * createCodeHandoffs - 创建代码交接处理器
 * @param db - SQLite 数据库实例（可写）
 * @param row - 单行查询函数
 * @param rows - 多行查询函数
 * @param now - 返回当前时间戳的函数
 * @param dataDir - ApiX 数据目录
 * @param recordTask - 任务事件记录函数
 * @param persistWorkspace - 是否持久化工作区元数据，默认 true
 * @returns 包含 workspace / inspect / freeze / patch / populate / ancestors / approveResolution / qualityContext 方法的对象
 */
export function createCodeHandoffs({db,row,rows,now,dataDir,recordTask,persistWorkspace=true}) {
  const indexDir=resolve(dataDir,'inspection-indexes'); mkdirSync(indexDir,{recursive:true});
  /**
   * unchanged - 创建任务状态未变化校验函数
   * @param tasks - 需要监控的任务列表
   * @returns 校验函数，若任务状态已变化则抛出 TASK_CHANGED 错误
   */
  function unchanged(tasks){
    const versions=tasks.map(task=>[task.id,JSON.stringify(row('SELECT * FROM tasks WHERE id=?',task.id))]);
    return ()=>{if(versions.some(([id,version])=>JSON.stringify(row('SELECT * FROM tasks WHERE id=?',id))!==version)){const error=new Error('代码处理期间任务状态已变化，请重新检查');error.code='TASK_CHANGED';throw error;}};
  }
  /**
   * workspace - 验证并返回任务的 Git worktree 工作区信息
   *
   * 严格校验 worktree 路径、Git 公共目录、gitdir 文件等，确保工作区未被外部篡改。
   * @param task - 任务记录
   * @returns {path, common, base, input} 工作区路径、Git 公共目录、基线 SHA、输入 commit
   */
  async function workspace(task) {
    const w=row('SELECT * FROM workspaces WHERE task_id=?',task.id);
    const expected=resolve(dataDir,'workspaces',task.id);
    // 多重校验：worktree 类型、路径一致性、目录存在性
    if(!w || w.kind!=='git-worktree' || resolve(w.path)!==expected || resolve(task.workspace_path ?? '')!==expected || !existsSync(expected)) throw new Error('任务没有可验证的托管工作区');
    const path=realpathSync.native(expected);
    // 校验 worktree 的 Git 顶层目录和公共目录
    if(path!==join(realpathSync.native(resolve(dataDir,'workspaces')),task.id) || realpathSync.native((await git(path,['rev-parse','--show-toplevel'])).trim())!==path) throw new Error('工作区路径已变化');
    const common=realpathSync.native(resolve(path,(await git(path,['rev-parse','--git-common-dir'])).trim()));
    let expectedCommon=w.common_dir;
    if(!expectedCommon) {
      // 从源项目推导预期的 Git 公共目录
      const source=task.repository_id ? row('SELECT path FROM project_repositories WHERE id=? AND project_id=?',task.repository_id,task.project_id) : row('SELECT path FROM projects WHERE id=?',task.project_id);
      if(!source)throw new Error('工作区源项目不存在');
      expectedCommon=realpathSync.native(resolve(source.path,(await git(source.path,['rev-parse','--git-common-dir'])).trim()));
    }
    if(common!==realpathSync.native(expectedCommon)) throw new Error('工作区 Git 目录已变化，请重新审查');
    // 校验 gitdir 文件指向正确的 .git 目录
    const gitDir=(await git(path,['rev-parse','--absolute-git-dir'])).trim();
    if(!existsSync(join(gitDir,'gitdir')) || realpathSync.native(resolve(readFileSync(join(gitDir,'gitdir'),'utf8').trim()))!==realpathSync.native(join(path,'.git'))) throw new Error('Git worktree 登记与任务目录不一致');
    // 最终 TOCTOU 校验：路径和数据库记录都未变化
    if(realpathSync.native(expected)!==path||JSON.stringify(row('SELECT * FROM workspaces WHERE task_id=?',task.id))!==JSON.stringify(w))throw new Error('检查期间工作区记录或路径已变化');
    // 补充 common_dir 字段到数据库
    if(!w.common_dir && persistWorkspace)db.prepare('UPDATE workspaces SET common_dir=? WHERE task_id=?').run(common,task.id);
    return {path,common,base:w.base_sha,input:task.input_commit ?? w.base_sha};
  }
  /**
   * inspect - 检查工作区 Git 状态，生成变更报告和指纹
   *
   * 使用独立 Git 索引文件避免影响工作区的 .git/index。
   * @param task - 任务记录
   * @returns 冲突列表、HEAD、tree hash、文件列表、指纹、diff 预览
   */
  async function inspect(task) {
    const w=(await workspace(task));
    // 检查未解决的合并冲突
    const conflicts=parts((await git(w.path,['diff','--name-only','--diff-filter=U','-z'])));
    if(conflicts.length) return {conflicts,files:conflicts,fingerprint:null,preview:'工作区仍有未解决的合并冲突'};
    const head=(await git(w.path,['rev-parse','HEAD'])).trim();
    // 使用临时索引文件，避免干扰工作区的 Git 状态
    const index=join(indexDir,randomUUID());
    const env={...process.env,GIT_INDEX_FILE:index,GIT_LITERAL_PATHSPECS:'1'};
    try {
      (await git(w.path,['read-tree',head],{env}));
      // 收集修改、删除和未跟踪的文件
      const files=[...new Set([...parts((await git(w.path,['ls-files','-z','--modified','--deleted','--others','--exclude-standard']))),...parts((await git(w.path,['diff','--cached','--name-only','-z',head])))])];
      if(files.length)(await git(w.path,['add','--pathspec-from-file=-','--pathspec-file-nul'],{env,input:files.join('\0')+'\0'}));
      // 写入 tree 对象并生成 diff
      const tree=(await git(w.path,['write-tree'],{env})).trim();
      const patch=(await git(w.path,['diff','--binary',w.input,tree]));
      return {conflicts:[],head,tree,inputCommit:w.input,files:parts((await git(w.path,['diff','--name-only','-z',w.input,tree]))),fingerprint:createHash('sha256').update(`${head}:${w.input}:${tree}`).digest('hex'),preview:patch.slice(0,12000),previewTruncated:patch.length>12000};
    } finally {
      // 清理临时索引文件
      for(const path of [index,index+'.lock'])if(existsSync(path))unlinkSync(path);
    }
  }
  /**
   * commitTree - 创建 Git commit 对象（不修改 HEAD）
   * @param path - 仓库路径
   * @param tree - tree 对象 hash
   * @param parent - 父 commit hash
   * @param message - commit 消息
   * @returns commit hash
   */
  async function commitTree(path,tree,parent,message) {
    return (await git(path,['-c','user.name=ApiX','-c','user.email=apix@local.invalid','-c','commit.gpgSign=false','commit-tree',tree,'-p',parent,'-m',message])).trim();
  }
  /**
   * freeze - 冻结交付版本
   *
   * 验证无冲突、指纹匹配后，创建交付 commit 并写入 refs/apix/deliveries/ 引用。
   * 冻结前后进行双重 TOCTOU 校验。
   * @param task - 任务记录
   * @param expectedFingerprint - 预期的工作区指纹（防并发修改）
   * @param assertAllowed - 额外的权限校验函数
   * @returns 冻结结果（commit hash、文件列表、指纹等）
   */
  async function freeze(task,expectedFingerprint,assertAllowed=()=>{}) {
    const assertCurrent=unchanged([task]);
    const preview=(await inspect(task));
    if(preview.conflicts.length)throw new Error('交付仍有 Git 冲突，不能通过验收');
    if(expectedFingerprint && expectedFingerprint!==preview.fingerprint)throw new Error('工作区已变化，请重新查看交付差异再验收');
    const w=(await workspace(task));
    const commit=(await commitTree(w.path,preview.tree,w.input,`ApiX reviewed delivery ${task.id}`));
    const run=row('SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
    // Keep Git ref lock paths short on Windows; consumers use the stored commit.
    // 使用短 hash 作为 ref 名称，避免 Windows 上路径过长
    const ref=createHash('sha256').update(`${task.id}:${run?.id ?? randomUUID()}`).digest('hex').slice(0,32);
    assertCurrent();assertAllowed();
    (await git(w.path,['update-ref',`refs/apix/deliveries/${ref}`,commit]));
    // 冻结后再次检查指纹，确保工作区未被并发修改
    if((await inspect(task)).fingerprint!==preview.fingerprint)throw new Error('冻结期间工作区已变化，请重新检查');
    assertCurrent();assertAllowed();
    db.prepare('UPDATE tasks SET delivery_commit=?,delivery_fingerprint=?,updated_at=? WHERE id=?').run(commit,preview.fingerprint,now(),task.id);
    recordTask(task.id,'delivery.frozen',{commit,inputCommit:w.input,files:preview.files,fingerprint:preview.fingerprint});
    return {commit,...preview};
  }
  /**
   * ancestors - 递归收集任务的所有已验收前置依赖（拓扑排序）
   * @param task - 任务记录
   * @returns 前置任务记录数组（按依赖顺序）
   * @throws 循环依赖或前置任务未验收时抛出错误
   */
  function ancestors(task) {
    const seen=new Set();const visiting=new Set();const selected=[];
    function visit(id) {
      if(seen.has(id))return;
      if(visiting.has(id))throw new Error('任务依赖存在循环');
      visiting.add(id);
      const source=row('SELECT * FROM tasks WHERE id=?',id);
      if(!source || source.project_id!==task.project_id || source.plan_id!==task.plan_id || source.status!=='accepted')throw new Error('前置任务尚未验收或不属于当前计划');
      for(const d of rows('SELECT depends_on_id FROM task_dependencies WHERE task_id=? ORDER BY rowid',id))visit(d.depends_on_id);
      visiting.delete(id);seen.add(id);selected.push(source);
    }
    for(const d of rows('SELECT depends_on_id FROM task_dependencies WHERE task_id=? ORDER BY rowid',task.id))visit(d.depends_on_id);
    return selected;
  }
  /**
   * patch - 获取前置任务从输入到交付的二进制 diff
   * @param source - 前置任务记录
   * @returns 二进制 diff 字符串
   */
  async function patch(source) {
    const w=(await workspace(source));
    if(!source.delivery_commit)throw new Error('前置交付没有冻结版本，请重新审查并冻结该交付');
    return (await git(w.path,['diff','--binary',w.input,source.delivery_commit]));
  }
  /**
   * populate - 将前置任务的交付代码应用到当前任务工作区
   *
   * 按依赖顺序逐个应用 patch，支持跨仓库检测（不同 Git 仓库的代码不能直接 apply）。
   * 成功时更新 input_commit 和 code_handoffs 表；冲突时记录冲突文件。
   * @param task - 当前任务记录
   * @param assertAllowed - 额外的权限校验函数
   * @returns {inputCommit, report} 输入 commit 和交接报告
   */
  async function populate(task,assertAllowed=()=>{}) {
    const w=(await workspace(task));const sources=ancestors(task);
    const assertCurrent=unchanged([task,...sources]);
    const report={sources:[],files:[],conflicts:[]};
    try {
      for(const source of sources) {
        const sw=(await workspace(source));const diff=(await patch(source));
        // 跨仓库的代码依赖不能直接应用，需要先集成对应仓库
        if(sw.common!==w.common && diff)throw new Error('跨仓库代码依赖需在对应仓库集成后重新安排，不能向当前仓库应用');
        if(sw.common===w.common && sw.base!==w.base)throw new Error('前置工作区基线不一致，请重新审查');
        report.sources.push({taskId:source.id,commit:source.delivery_commit,inputCommit:sw.input});
        if(!diff)continue;
        assertCurrent();assertAllowed();(await git(w.path,['apply','--3way','--index','-'],{input:diff}));
        report.files.push(...parts((await git(w.path,['diff','--name-only','-z',sw.input,source.delivery_commit]))));
      }
      const tree=(await git(w.path,['write-tree'])).trim();
      const input=sources.length ? (await commitTree(w.path,tree,w.input,`ApiX accepted inputs ${task.id}`)) : w.input;
      assertCurrent();assertAllowed();
      // 使用 CAS 方式更新 HEAD（指定旧值防止并发覆盖）
      if(input!==w.input)(await git(w.path,['update-ref','HEAD',input,w.input]));
      assertCurrent();assertAllowed();
      db.prepare('UPDATE tasks SET input_commit=?,updated_at=? WHERE id=?').run(input,now(),task.id);
      report.files=[...new Set(report.files)];
      db.prepare('INSERT INTO code_handoffs VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,input_commit=excluded.input_commit,report=excluded.report,updated_at=excluded.updated_at').run(task.id,'ready',w.base,input,JSON.stringify(report),now());
      recordTask(task.id,'handoff.ready',{...report,inputCommit:input});
      return {inputCommit:input,report};
    } catch(error) {
      // 冲突时记录冲突文件和错误信息
      report.conflicts=parts((await git(w.path,['diff','--name-only','--diff-filter=U','-z'])));
      report.error=String(error.stderr ?? error.message).slice(0,1500);
      db.prepare('INSERT INTO code_handoffs VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,report=excluded.report,updated_at=excluded.updated_at').run(task.id,'conflict',w.base,w.input,JSON.stringify(report),now());
      recordTask(task.id,'handoff.conflict',report);
      const failure=new Error('前置代码交接失败，工作区已保留，请检查冲突与基线后重新批准'); failure.code='HANDOFF_CONFLICT';throw failure;
    }
  }
  /**
   * approveResolution - 用户批准冲突解决结果后，更新 HEAD 和交接记录
   *
   * 验证冲突已解决（无合并冲突且指纹匹配），创建新的 input commit。
   * @param task - 任务记录
   * @param fingerprint - 预期的工作区指纹
   * @param assertAllowed - 额外的权限校验函数
   * @returns {tree, inputCommit} tree hash 和新的输入 commit
   */
  async function approveResolution(task,fingerprint,assertAllowed=()=>{}) {
    const assertCurrent=unchanged([task]);
    const h=row("SELECT * FROM code_handoffs WHERE task_id=? AND status='conflict'",task.id);
    if(!h)return;
    const w=(await workspace(task));const preview=(await inspect(task));
    if(preview.conflicts.length || preview.fingerprint!==fingerprint)throw new Error('冲突尚未解决或检查后内容已变化');
    const input=(await commitTree(w.path,preview.tree,w.input,`ApiX user reviewed conflict resolution ${task.id}`));
    assertCurrent();assertAllowed();
    (await git(w.path,['update-ref','HEAD',input,preview.head]));
    (await git(w.path,['read-tree',input]));
    // 再次验证 tree 未被并发修改
    if((await inspect(task)).tree!==preview.tree)throw new Error('解决冲突期间工作区已变化，请重新检查');
    const report={...JSON.parse(h.report),conflicts:[],error:null,resolution:'用户检查并批准当前解决结果',files:preview.files};
    assertCurrent();assertAllowed();
    db.prepare('UPDATE tasks SET input_commit=? WHERE id=?').run(input,task.id);
    db.prepare("UPDATE code_handoffs SET status='ready',input_commit=?,report=?,updated_at=? WHERE task_id=?").run(input,JSON.stringify(report),now(),task.id);
    recordTask(task.id,'handoff.resolved',{inputCommit:input,files:preview.files});
    return {tree:preview.tree,inputCommit:input};
  }
  /**
   * qualityContext - 收集质量审查所需的项目文件内容
   *
   * 根据任务的架构绑定（autonomy_tasks），收集相关模块路径下的文件内容。
   * 限制总大小 70KB、最多 100 个文件，超出部分标记 truncated。
   * @param task - 任务记录（需包含 plan_id 和 module_id）
   * @returns {files, truncated} 文件列表和是否截断
   */
  async function qualityContext(task){
    const binding=row('SELECT a.module_id,p.body FROM autonomy_tasks a JOIN autonomy_plans p ON p.plan_id=? WHERE a.task_id=?',task.plan_id,task.id);if(!binding)throw new Error('任务没有冻结架构');
    const architecture=JSON.parse(binding.body);const selected=binding.module_id==='integration'?architecture.modules:architecture.modules.filter(m=>m.id===binding.module_id);const paths=selected.flatMap(m=>m.paths);
    const w=(await workspace(task));const normalize=value=>process.platform==='win32'?value.toLowerCase():value;const all=[...new Set(parts((await git(w.path,['ls-files','--cached','--others','--exclude-standard','-z']))))].filter(file=>paths.some(path=>normalize(file)===normalize(path)||normalize(file).startsWith(normalize(path)+'/')));
    const files=[];let size=0;let truncated=false;
    for(const file of all){const path=resolve(w.path,file);if(!existsSync(path))continue;const rel=relative(w.path,realpathSync.native(path));if(rel.startsWith('..')||isAbsolute(rel))throw new Error('审查文件通过链接越过工作区');const bytes=statSync(path).size;if(size+bytes>70000 || files.length>=100){truncated=true;continue;}const body=readFileSync(path,'utf8');if(body.includes('\0')){truncated=true;continue;}size+=bytes;files.push({path:file,content:body});}
    return {files,truncated};
  }
  return {workspace,inspect,freeze,patch,populate,ancestors,approveResolution,qualityContext};
}
