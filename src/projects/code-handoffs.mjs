import { createHash, randomUUID } from 'node:crypto';
import {git} from './git.mjs';
import { existsSync, mkdirSync, realpathSync, unlinkSync, readFileSync,statSync } from 'node:fs';
import { join, resolve,relative,isAbsolute } from 'node:path';

const parts = value => value.split('\0').filter(Boolean);
export function createCodeHandoffs({db,row,rows,now,dataDir,recordTask,persistWorkspace=true}) {
  const indexDir=resolve(dataDir,'inspection-indexes'); mkdirSync(indexDir,{recursive:true});
  function unchanged(tasks){
    const versions=tasks.map(task=>[task.id,JSON.stringify(row('SELECT * FROM tasks WHERE id=?',task.id))]);
    return ()=>{if(versions.some(([id,version])=>JSON.stringify(row('SELECT * FROM tasks WHERE id=?',id))!==version)){const error=new Error('代码处理期间任务状态已变化，请重新检查');error.code='TASK_CHANGED';throw error;}};
  }
  async function workspace(task) {
    const w=row('SELECT * FROM workspaces WHERE task_id=?',task.id);
    const expected=resolve(dataDir,'workspaces',task.id);
    if(!w || w.kind!=='git-worktree' || resolve(w.path)!==expected || resolve(task.workspace_path ?? '')!==expected || !existsSync(expected)) throw new Error('任务没有可验证的托管工作区');
    const path=realpathSync.native(expected);
    if(path!==join(realpathSync.native(resolve(dataDir,'workspaces')),task.id) || realpathSync.native((await git(path,['rev-parse','--show-toplevel'])).trim())!==path) throw new Error('工作区路径已变化');
    const common=realpathSync.native(resolve(path,(await git(path,['rev-parse','--git-common-dir'])).trim()));
    let expectedCommon=w.common_dir;
    if(!expectedCommon) {
      const source=task.repository_id ? row('SELECT path FROM project_repositories WHERE id=? AND project_id=?',task.repository_id,task.project_id) : row('SELECT path FROM projects WHERE id=?',task.project_id);
      if(!source)throw new Error('工作区源项目不存在');
      expectedCommon=realpathSync.native(resolve(source.path,(await git(source.path,['rev-parse','--git-common-dir'])).trim()));
    }
    if(common!==realpathSync.native(expectedCommon)) throw new Error('工作区 Git 目录已变化，请重新审查');
    const gitDir=(await git(path,['rev-parse','--absolute-git-dir'])).trim();
    if(!existsSync(join(gitDir,'gitdir')) || realpathSync.native(resolve(readFileSync(join(gitDir,'gitdir'),'utf8').trim()))!==realpathSync.native(join(path,'.git'))) throw new Error('Git worktree 登记与任务目录不一致');
    if(realpathSync.native(expected)!==path||JSON.stringify(row('SELECT * FROM workspaces WHERE task_id=?',task.id))!==JSON.stringify(w))throw new Error('检查期间工作区记录或路径已变化');
    if(!w.common_dir && persistWorkspace)db.prepare('UPDATE workspaces SET common_dir=? WHERE task_id=?').run(common,task.id);
    return {path,common,base:w.base_sha,input:task.input_commit ?? w.base_sha};
  }
  async function inspect(task) {
    const w=(await workspace(task));
    const conflicts=parts((await git(w.path,['diff','--name-only','--diff-filter=U','-z'])));
    if(conflicts.length) return {conflicts,files:conflicts,fingerprint:null,preview:'工作区仍有未解决的合并冲突'};
    const head=(await git(w.path,['rev-parse','HEAD'])).trim();
    const index=join(indexDir,randomUUID());
    const env={...process.env,GIT_INDEX_FILE:index,GIT_LITERAL_PATHSPECS:'1'};
    try {
      (await git(w.path,['read-tree',head],{env}));
      const files=[...new Set([...parts((await git(w.path,['ls-files','-z','--modified','--deleted','--others','--exclude-standard']))),...parts((await git(w.path,['diff','--cached','--name-only','-z',head])))])];
      if(files.length)(await git(w.path,['add','--pathspec-from-file=-','--pathspec-file-nul'],{env,input:files.join('\0')+'\0'}));
      const tree=(await git(w.path,['write-tree'],{env})).trim();
      const patch=(await git(w.path,['diff','--binary',w.input,tree]));
      return {conflicts:[],head,tree,inputCommit:w.input,files:parts((await git(w.path,['diff','--name-only','-z',w.input,tree]))),fingerprint:createHash('sha256').update(`${head}:${w.input}:${tree}`).digest('hex'),preview:patch.slice(0,12000),previewTruncated:patch.length>12000};
    } finally {
      for(const path of [index,index+'.lock'])if(existsSync(path))unlinkSync(path);
    }
  }
  async function commitTree(path,tree,parent,message) {
    return (await git(path,['-c','user.name=ApiX','-c','user.email=apix@local.invalid','-c','commit.gpgSign=false','commit-tree',tree,'-p',parent,'-m',message])).trim();
  }
  async function freeze(task,expectedFingerprint,assertAllowed=()=>{}) {
    const assertCurrent=unchanged([task]);
    const preview=(await inspect(task));
    if(preview.conflicts.length)throw new Error('交付仍有 Git 冲突，不能通过验收');
    if(expectedFingerprint && expectedFingerprint!==preview.fingerprint)throw new Error('工作区已变化，请重新查看交付差异再验收');
    const w=(await workspace(task));
    const commit=(await commitTree(w.path,preview.tree,w.input,`ApiX reviewed delivery ${task.id}`));
    const run=row('SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
    // Keep Git ref lock paths short on Windows; consumers use the stored commit.
    const ref=createHash('sha256').update(`${task.id}:${run?.id ?? randomUUID()}`).digest('hex').slice(0,32);
    assertCurrent();assertAllowed();
    (await git(w.path,['update-ref',`refs/apix/deliveries/${ref}`,commit]));
    if((await inspect(task)).fingerprint!==preview.fingerprint)throw new Error('冻结期间工作区已变化，请重新检查');
    assertCurrent();assertAllowed();
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
  async function patch(source) {
    const w=(await workspace(source));
    if(!source.delivery_commit)throw new Error('前置交付没有冻结版本，请重新审查并冻结该交付');
    return (await git(w.path,['diff','--binary',w.input,source.delivery_commit]));
  }
  async function populate(task,assertAllowed=()=>{}) {
    const w=(await workspace(task));const sources=ancestors(task);
    const assertCurrent=unchanged([task,...sources]);
    const report={sources:[],files:[],conflicts:[]};
    try {
      for(const source of sources) {
        const sw=(await workspace(source));const diff=(await patch(source));
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
      if(input!==w.input)(await git(w.path,['update-ref','HEAD',input,w.input]));
      assertCurrent();assertAllowed();
      db.prepare('UPDATE tasks SET input_commit=?,updated_at=? WHERE id=?').run(input,now(),task.id);
      report.files=[...new Set(report.files)];
      db.prepare('INSERT INTO code_handoffs VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,input_commit=excluded.input_commit,report=excluded.report,updated_at=excluded.updated_at').run(task.id,'ready',w.base,input,JSON.stringify(report),now());
      recordTask(task.id,'handoff.ready',{...report,inputCommit:input});
      return {inputCommit:input,report};
    } catch(error) {
      report.conflicts=parts((await git(w.path,['diff','--name-only','--diff-filter=U','-z'])));
      report.error=String(error.stderr ?? error.message).slice(0,1500);
      db.prepare('INSERT INTO code_handoffs VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,report=excluded.report,updated_at=excluded.updated_at').run(task.id,'conflict',w.base,w.input,JSON.stringify(report),now());
      recordTask(task.id,'handoff.conflict',report);
      const failure=new Error('前置代码交接失败，工作区已保留，请检查冲突与基线后重新批准'); failure.code='HANDOFF_CONFLICT';throw failure;
    }
  }
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
    if((await inspect(task)).tree!==preview.tree)throw new Error('解决冲突期间工作区已变化，请重新检查');
    const report={...JSON.parse(h.report),conflicts:[],error:null,resolution:'用户检查并批准当前解决结果',files:preview.files};
    assertCurrent();assertAllowed();
    db.prepare('UPDATE tasks SET input_commit=? WHERE id=?').run(input,task.id);
    db.prepare("UPDATE code_handoffs SET status='ready',input_commit=?,report=?,updated_at=? WHERE task_id=?").run(input,JSON.stringify(report),now(),task.id);
    recordTask(task.id,'handoff.resolved',{inputCommit:input,files:preview.files});
    return {tree:preview.tree,inputCommit:input};
  }
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
