import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const git = (cwd,args,options={}) => execFileSync('git',args,{cwd,encoding:'utf8',timeout:20000,maxBuffer:10000000,windowsHide:true,stdio:['pipe','pipe','pipe'],...options});
const parts = value => value.split('\0').filter(Boolean);
export function createCodeHandoffs({db,row,rows,now,dataDir,recordTask}) {
  const indexDir=resolve(dataDir,'inspection-indexes'); mkdirSync(indexDir,{recursive:true});
  function workspace(task) {
    const w=row('SELECT * FROM workspaces WHERE task_id=?',task.id);
    const expected=resolve(dataDir,'workspaces',task.id);
    if(!w || w.kind!=='git-worktree' || resolve(w.path)!==expected || resolve(task.workspace_path ?? '')!==expected || !existsSync(expected)) throw new Error('任务没有可验证的托管工作区');
    const path=realpathSync.native(expected);
    if(path!==join(realpathSync.native(resolve(dataDir,'workspaces')),task.id) || realpathSync.native(git(path,['rev-parse','--show-toplevel']).trim())!==path) throw new Error('工作区路径已变化');
    const common=realpathSync.native(resolve(path,git(path,['rev-parse','--git-common-dir']).trim()));
    let expectedCommon=w.common_dir;
    if(!expectedCommon) {
      const source=task.repository_id ? row('SELECT path FROM project_repositories WHERE id=? AND project_id=?',task.repository_id,task.project_id) : row('SELECT path FROM projects WHERE id=?',task.project_id);
      if(!source)throw new Error('工作区源项目不存在');
      expectedCommon=realpathSync.native(resolve(source.path,git(source.path,['rev-parse','--git-common-dir']).trim()));
    }
    if(common!==realpathSync.native(expectedCommon)) throw new Error('工作区 Git 目录已变化，请重新审查');
    const gitDir=git(path,['rev-parse','--absolute-git-dir']).trim();
    if(!existsSync(join(gitDir,'gitdir')) || realpathSync.native(resolve(readFileSync(join(gitDir,'gitdir'),'utf8').trim()))!==realpathSync.native(join(path,'.git'))) throw new Error('Git worktree 登记与任务目录不一致');
    if(!w.common_dir)db.prepare('UPDATE workspaces SET common_dir=? WHERE task_id=?').run(common,task.id);
    return {path,common,base:w.base_sha,input:task.input_commit ?? w.base_sha};
  }
  function inspect(task) {
    const w=workspace(task);
    const conflicts=parts(git(w.path,['diff','--name-only','--diff-filter=U','-z']));
    if(conflicts.length) return {conflicts,files:conflicts,fingerprint:null,preview:'工作区仍有未解决的合并冲突'};
    const head=git(w.path,['rev-parse','HEAD']).trim();
    const index=join(indexDir,randomUUID());
    const env={...process.env,GIT_INDEX_FILE:index,GIT_LITERAL_PATHSPECS:'1'};
    try {
      git(w.path,['read-tree',head],{env});
      const files=[...new Set([...parts(git(w.path,['ls-files','-z','--modified','--deleted','--others','--exclude-standard'])),...parts(git(w.path,['diff','--cached','--name-only','-z',head]))])];
      if(files.length)git(w.path,['add','--pathspec-from-file=-','--pathspec-file-nul'],{env,input:files.join('\0')+'\0'});
      const tree=git(w.path,['write-tree'],{env}).trim();
      const patch=git(w.path,['diff','--binary',w.input,tree]);
      return {conflicts:[],head,tree,inputCommit:w.input,files:parts(git(w.path,['diff','--name-only','-z',w.input,tree])),fingerprint:createHash('sha256').update(`${head}:${w.input}:${tree}`).digest('hex'),preview:patch.slice(0,12000),previewTruncated:patch.length>12000};
    } finally {
      for(const path of [index,index+'.lock'])if(existsSync(path))unlinkSync(path);
    }
  }
  function commitTree(path,tree,parent,message) {
    return git(path,['-c','user.name=ApiX','-c','user.email=apix@local.invalid','-c','commit.gpgSign=false','commit-tree',tree,'-p',parent,'-m',message]).trim();
  }
  function freeze(task,expectedFingerprint) {
    const preview=inspect(task);
    if(preview.conflicts.length)throw new Error('交付仍有 Git 冲突，不能通过验收');
    if(expectedFingerprint && expectedFingerprint!==preview.fingerprint)throw new Error('工作区已变化，请重新查看交付差异再验收');
    const w=workspace(task);
    const commit=commitTree(w.path,preview.tree,w.input,`ApiX reviewed delivery ${task.id}`);
    const run=row('SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
    git(w.path,['update-ref',`refs/apix/deliveries/${task.id}/${run?.id ?? randomUUID()}`,commit]);
    db.prepare('UPDATE tasks SET delivery_commit=?,delivery_fingerprint=?,updated_at=? WHERE id=?').run(commit,preview.fingerprint,now(),task.id);
    recordTask(task.id,'delivery.frozen',{commit,inputCommit:w.input,files:preview.files,fingerprint:preview.fingerprint});
    return {commit,...preview};
  }
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
  function patch(source) {
    const w=workspace(source);
    if(!source.delivery_commit)throw new Error('前置交付没有冻结版本，请重新审查并冻结该交付');
    return git(w.path,['diff','--binary',w.input,source.delivery_commit]);
  }
  function populate(task) {
    const w=workspace(task);const sources=ancestors(task);
    const report={sources:[],files:[],conflicts:[]};
    try {
      for(const source of sources) {
        const sw=workspace(source);const diff=patch(source);
        if(sw.common!==w.common && diff)throw new Error('跨仓库代码依赖需在对应仓库集成后重新安排，不能向当前仓库应用');
        if(sw.common===w.common && sw.base!==w.base)throw new Error('前置工作区基线不一致，请重新审查');
        report.sources.push({taskId:source.id,commit:source.delivery_commit,inputCommit:sw.input});
        if(!diff)continue;
        git(w.path,['apply','--3way','--index','-'],{input:diff});
        report.files.push(...parts(git(w.path,['diff','--name-only','-z',sw.input,source.delivery_commit])));
      }
      const tree=git(w.path,['write-tree']).trim();
      const input=sources.length ? commitTree(w.path,tree,w.input,`ApiX accepted inputs ${task.id}`) : w.input;
      if(input!==w.input)git(w.path,['update-ref','HEAD',input,w.input]);
      db.prepare('UPDATE tasks SET input_commit=?,updated_at=? WHERE id=?').run(input,now(),task.id);
      report.files=[...new Set(report.files)];
      db.prepare('INSERT INTO code_handoffs VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,input_commit=excluded.input_commit,report=excluded.report,updated_at=excluded.updated_at').run(task.id,'ready',w.base,input,JSON.stringify(report),now());
      recordTask(task.id,'handoff.ready',{...report,inputCommit:input});
      return {inputCommit:input,report};
    } catch(error) {
      report.conflicts=parts(git(w.path,['diff','--name-only','--diff-filter=U','-z']));
      report.error=String(error.stderr ?? error.message).slice(0,1500);
      db.prepare('INSERT INTO code_handoffs VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,report=excluded.report,updated_at=excluded.updated_at').run(task.id,'conflict',w.base,w.input,JSON.stringify(report),now());
      recordTask(task.id,'handoff.conflict',report);
      const failure=new Error('前置代码交接失败，工作区已保留，请检查冲突与基线后重新批准'); failure.code='HANDOFF_CONFLICT';throw failure;
    }
  }
  function approveResolution(task,fingerprint) {
    const h=row("SELECT * FROM code_handoffs WHERE task_id=? AND status='conflict'",task.id);
    if(!h)return;
    const w=workspace(task);const preview=inspect(task);
    if(preview.conflicts.length || preview.fingerprint!==fingerprint)throw new Error('冲突尚未解决或检查后内容已变化');
    const input=commitTree(w.path,preview.tree,w.input,`ApiX user reviewed conflict resolution ${task.id}`);
    git(w.path,['update-ref','HEAD',input,preview.head]);
    git(w.path,['read-tree',input]);
    const report={...JSON.parse(h.report),conflicts:[],error:null,resolution:'用户检查并批准当前解决结果',files:preview.files};
    db.prepare('UPDATE tasks SET input_commit=? WHERE id=?').run(input,task.id);
    db.prepare("UPDATE code_handoffs SET status='ready',input_commit=?,report=?,updated_at=? WHERE task_id=?").run(input,JSON.stringify(report),now(),task.id);
    recordTask(task.id,'handoff.resolved',{inputCommit:input,files:preview.files});
    return {tree:preview.tree,inputCommit:input};
  }
  return {workspace,inspect,freeze,patch,populate,ancestors,approveResolution};
}
