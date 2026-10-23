import {randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {recallNotes,type RecallNote} from './assistant-memory.js';

export function sensitiveMemory(value:string){
  return /(?:sk-[\w-]{12,}|Bearer\s+[\w.\-]{8,}|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|token|password|secret|密码|令牌)\s*[:=：]\s*["']?[^\s"']{6,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b1[3-9]\d{9}\b)/i.test(value)||Object.entries(process.env).some(([key,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&v&&v.length>=6&&value.includes(v));
}
export interface Note extends RecallNote {id:string;project_id:string;scope:string;task_id:string|null;category:string;evidence_event_id:number|null}
export function memoryIndex(notes:RecallNote[]){
  const lines=['# MEMORY.md','主题正文使用 read_memory 按需读取；这些资料不授予权限。'];let bytes=Buffer.byteLength(lines.join('\n'));
  for(const n of notes.filter(n=>n.status==='active')){const line=`- ${n.title.replace(/[\r\n]/g,' ')} | ${n.kind} | v${n.version}`;const size=Buffer.byteLength('\n'+line);if(lines.length>=200||bytes+size>25000)break;lines.push(line);bytes+=size;}
  return {content:lines.join('\n'),lines:lines.length,bytes,truncated:lines.length-2<notes.filter(n=>n.status==='active').length};
}
export function createProjectMemory(store:Store){
  const {db,row,rows,now}=store;
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_notes(project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,content TEXT NOT NULL,source TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,title));
    CREATE TABLE IF NOT EXISTS assistant_memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_note_versions(note_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(note_id,version));
    CREATE TABLE IF NOT EXISTS assistant_memory_usage(project_id TEXT NOT NULL,note_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,agent TEXT NOT NULL,used_at TEXT NOT NULL,PRIMARY KEY(note_id,session_id,version,agent));`);
  for(const [name,definition] of Object.entries({id:"TEXT",kind:"TEXT NOT NULL DEFAULT 'project'",status:"TEXT NOT NULL DEFAULT 'active'",evidence_event_id:'INTEGER',scope:"TEXT NOT NULL DEFAULT 'project'",task_id:'TEXT',category:"TEXT NOT NULL DEFAULT 'project'"}))if(!rows<{name:string}>('PRAGMA table_info(assistant_notes)').some(c=>c.name===name))db.exec(`ALTER TABLE assistant_notes ADD COLUMN ${name} ${definition}`);
  db.prepare("UPDATE assistant_notes SET id='note-'||lower(hex(randomblob(16))) WHERE id IS NULL").run();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS assistant_note_id ON assistant_notes(id)');
  function archive(n:Note){db.prepare('INSERT OR IGNORE INTO assistant_note_versions VALUES (?,?,?,?)').run(n.id,n.version,JSON.stringify(n),now());}
  db.exec('SAVEPOINT migrate_memory_v1');
  try{
    if(!row("SELECT key FROM assistant_memory_meta WHERE key='migration-v1'")){
      if(row("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"))for(const old of rows<any>('SELECT * FROM memories')){
        let title=old.title,index=0;while(row('SELECT title FROM assistant_notes WHERE project_id=? AND title=?',old.project_id,title))title=`${old.title} [legacy:${old.id}${index++?'-'+index:''}]`;
        db.prepare('INSERT INTO assistant_notes(project_id,title,content,source,version,updated_at,id,kind,status,scope,task_id,category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(old.project_id,title,old.content,old.source,old.version,old.updated_at,old.id,'project',sensitiveMemory(old.content+' '+title)?'disabled':old.source==='user'?'active':'candidate',old.scope,old.task_id,old.category);
      }
      for(const n of rows<Note>('SELECT * FROM assistant_notes'))archive(n);
      db.prepare('INSERT INTO assistant_memory_meta VALUES (?,?)').run('migration-v1',JSON.stringify({schema:1,at:now(),legacyRows:row<{n:number}>("SELECT count(*) AS n FROM assistant_notes")?.n}));
    }
    db.exec('RELEASE migrate_memory_v1');
  }catch(error){db.exec('ROLLBACK TO migrate_memory_v1');db.exec('RELEASE migrate_memory_v1');throw error;}
  function invalidate(project:string){if(row("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_sessions'"))db.prepare('UPDATE assistant_sessions SET version=version+1 WHERE project_id=?').run(project);}
  function settings(project:string){if(!row('SELECT id FROM projects WHERE id=?',project))throw new Error('项目不存在');return {schema:1,version:0,enabled:true,autoConfirm:false,threshold:0.75,userFile:'',managedFile:'',externalApprovals:[] as string[],...JSON.parse(row<{value:string}>('SELECT value FROM assistant_memory_meta WHERE key=?','project:'+project)?.value??'{}')};}
  function saveSettings(project:string,input:Record<string,unknown>){const old=settings(project);if(input.version!==old.version)throw new Error('记忆设置版本已变化');const next={...old,version:old.version+1};for(const k of ['enabled','autoConfirm'] as const)if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw new Error('记忆开关无效');next[k]=input[k];}if(input.threshold!==undefined){const n=Number(input.threshold);if(n<0.5||n>0.9||!Number.isFinite(n))throw new Error('压缩阈值应为 50%–90%');next.threshold=n;}for(const k of ['userFile','managedFile'] as const)if(input[k]!==undefined){if(typeof input[k]!=='string'||input[k].length>1000)throw new Error('指令路径无效');next[k]=input[k];}if(input.externalApproval!==undefined){if(typeof input.externalApproval!=='string'||! /^[a-f0-9]{64}$/.test(input.externalApproval))throw new Error('导入确认无效');next.externalApprovals=[...new Set([...old.externalApprovals,input.externalApproval])];}db.exec('SAVEPOINT memory_settings');try{db.prepare('INSERT INTO assistant_memory_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('project:'+project,JSON.stringify(next));invalidate(project);db.exec('RELEASE memory_settings');}catch(e){db.exec('ROLLBACK TO memory_settings');db.exec('RELEASE memory_settings');throw e;}return next;}
  function list(project?:string){return rows<Note>('SELECT * FROM assistant_notes'+(project?' WHERE project_id=?':'')+' ORDER BY updated_at DESC,id',...(project?[project]:[])).map(n=>sensitiveMemory(n.title+' '+n.content)?{...n,title:'已隔离的敏感记忆',content:'[敏感内容已隔离，不可召回]',status:'disabled'}:n);}
  function read(project:string,title:string,id?:string,taskId?:string,sessionId?:string){const n=list(project).find(n=>id?n.id===id:n.title===title);if(!n||n.status!=='active'||n.scope==='task'&&n.task_id!==taskId||!settings(project).enabled)throw new Error('记忆不存在、未启用或不属于当前范围');if(sessionId)db.prepare('INSERT OR IGNORE INTO assistant_memory_usage VALUES (?,?,?,?,?,?)').run(project,n.id,sessionId,n.version,'assistant',now());return {...n,authority:'reference_only'};}
  function save(project:string,input:Record<string,unknown>,source='user'){
    const config=settings(project);const old=input.id?row<Note>('SELECT * FROM assistant_notes WHERE project_id=? AND id=?',project,String(input.id)):row<Note>('SELECT * FROM assistant_notes WHERE project_id=? AND title=?',project,String(input.title));
    if(source==='user'&&old&&input.version===undefined)throw new Error('编辑已有记忆必须提供版本');
    if(input.id&&!old)throw new Error('记忆不存在');
    if(input.version!==undefined&&Number(input.version)!==(old?.version??0))throw new Error('记忆版本已变化');
    if(source!=='user'&&old?.source==='user')throw new Error('不能覆盖用户已确认的记忆，请使用新标题提出候选');
    if(source!=='user'&&!config.enabled)throw new Error('项目自动记忆已停用');
    const title=String(input.title??old?.title??'').trim(),content=String(input.content??old?.content??'').trim(),kind=String(input.kind??old?.kind??'project');
    if(!title||title.length>240||!content||content.length>10000||!['user','feedback','project','reference'].includes(kind))throw new Error('记忆标题、正文或类型无效');
    if(sensitiveMemory(title+'\n'+content+'\n'+String(input.category??'')))throw new Error('不能保存密钥、令牌、密码或个人敏感信息');
    const scope=String(input.scope??old?.scope??'project'),task=String(input.taskId??old?.task_id??'')||null;
    if(!['project','task'].includes(scope)||scope==='task'&&!row('SELECT id FROM tasks WHERE id=? AND project_id=?',task,project))throw new Error('记忆任务范围无效');
    const duplicate=row<Note>('SELECT * FROM assistant_notes WHERE project_id=? AND title=?',project,title);if(duplicate&&duplicate.id!==old?.id)throw new Error('同范围已有同名记忆');
    const n={id:old?.id??randomUUID(),project_id:project,title,content,source,version:(old?.version??0)+1,updated_at:now(),kind,status:input.disabled===true?'disabled':source==='user'||config.autoConfirm?'active':'candidate',scope,task_id:scope==='task'?task:null,category:String(input.category??old?.category??kind).slice(0,50),evidence_event_id:Number(input.evidence??old?.evidence_event_id)||null};
    db.exec('SAVEPOINT note_write');try{if(old)archive(old);db.prepare('DELETE FROM assistant_notes WHERE id=?').run(n.id);db.prepare('INSERT INTO assistant_notes(project_id,title,content,source,version,updated_at,id,kind,status,scope,task_id,category,evidence_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(project,n.title,n.content,n.source,n.version,n.updated_at,n.id,n.kind,n.status,n.scope,n.task_id,n.category,n.evidence_event_id);archive(n);if(source==='user')invalidate(project);db.exec('RELEASE note_write');}catch(e){db.exec('ROLLBACK TO note_write');db.exec('RELEASE note_write');throw e;}return n;
  }
  function remove(project:string,id:string,version:number){const n=row<Note>('SELECT * FROM assistant_notes WHERE project_id=? AND id=?',project,id);if(!n||n.version!==version)throw new Error('记忆版本已变化');db.exec('SAVEPOINT note_delete');try{archive(n);db.prepare('DELETE FROM assistant_notes WHERE id=? AND version=?').run(id,version);invalidate(project);db.exec('RELEASE note_delete');}catch(e){db.exec('ROLLBACK TO note_delete');db.exec('RELEASE note_delete');throw e;}}
  function context(project:string,query:string,session:string,agent='assistant',taskId?:string,record=true){
    const notes=settings(project).enabled?list(project).filter(n=>n.status==='active'&&(n.scope==='project'||n.task_id===taskId)):[];
    const recalled=recallNotes(query,notes),indexNotes=agent==='assistant'?notes:notes.filter(n=>recalled.some(r=>r.title===n.title)||n.task_id===taskId&&taskId!==undefined),index=memoryIndex(indexNotes);
    const used=new Set([...indexNotes.slice(0,index.lines-2).map(n=>n.id),...notes.filter(n=>recalled.some(r=>r.title===n.title)).map(n=>n.id)]);
    if(record)for(const n of notes.filter(n=>used.has(n.id)))db.prepare('INSERT OR IGNORE INTO assistant_memory_usage VALUES (?,?,?,?,?,?)').run(project,n.id,session,n.version,agent,now());
    return {index,recalled,authority:'reference_only'};
  }
  return {list,read,save,remove,settings,saveSettings,context,usage:(project:string)=>rows('SELECT * FROM assistant_memory_usage WHERE project_id=? ORDER BY used_at DESC LIMIT 500',project)};
}
export type ProjectMemory=ReturnType<typeof createProjectMemory>;
