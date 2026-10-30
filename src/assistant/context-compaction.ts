import {createHash} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {canonical} from './tool-governance.js';

interface Checkpoint {id:string;summary:string;compacted_through:number}
interface Input {sessionId:string;signature:string;effectiveWatermark:number;through:number}
type Reason='in_progress'|'failed'|'no_gain';
interface Block {input_signature:string;effective_watermark:number;generation:string|null;reason:Reason;created_at:string}
const userKinds=['message','request_answer','intent_confirmed','task_started','memory_edited','delivery_changes_requested','delivery_accepted'];
const toolKinds=['tool_result','file_edit_result','verification_contract','verification_evidence','command_finished','npm_validation_prepared','npm_validation_finished','delegation_result','supervision_event'];

export class CompactionNoGainError extends Error {
  constructor(){super('压缩没有缩小稳定上下文，原检查点未改变；请缩小输入或检查摘要');}
}

/** 维护记录不进入有效输入签名；调用前先落进行中状态，进程中断也不能自动重复消费。 */
export function createContextCompaction({db,row,rows,now}:Store){
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_compaction_blocks(
    session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    input_signature TEXT NOT NULL,effective_watermark INTEGER NOT NULL,checkpoint_through INTEGER NOT NULL,
    generation TEXT,reason TEXT NOT NULL CHECK(reason IN ('in_progress','failed','no_gain')),created_at TEXT NOT NULL);`);
  function input(s:Checkpoint):Input{
    const hash=createHash('sha256').update(canonical([s.compacted_through,s.summary]));let cursor=s.compacted_through,effectiveWatermark=cursor;
    const kinds=[...userKinds,...toolKinds];
    for(;;){
      const page=rows<{id:number;role:string;kind:string;body:string}>(`SELECT id,role,kind,body FROM assistant_events WHERE session_id=? AND id>? AND ((role='user' AND kind IN (${userKinds.map(()=>'?').join(',')})) OR kind IN (${toolKinds.map(()=>'?').join(',')})) ORDER BY id LIMIT 200`,s.id,cursor,...kinds);
      for(const e of page){hash.update('\n'+canonical(e));effectiveWatermark=e.id;}
      if(page.length<200)break;cursor=page.at(-1)!.id;
    }
    return {sessionId:s.id,signature:hash.digest('hex'),effectiveWatermark,through:s.compacted_through};
  }
  function status(s:Checkpoint){
    const saved=row<Block>('SELECT * FROM assistant_compaction_blocks WHERE session_id=?',s.id);
    return saved?{blocked:saved.input_signature===input(s).signature,reason:saved.reason,effectiveWatermark:saved.effective_watermark,generation:saved.generation,createdAt:saved.created_at}:null;
  }
  function begin(s:Checkpoint,generation:string|null,manual:boolean){
    const value=input(s),saved=row<Block>('SELECT * FROM assistant_compaction_blocks WHERE session_id=?',s.id);
    if(!manual&&saved?.input_signature===value.signature)throw Object.assign(new Error('同一有效输入此前压缩失败、无收益或尚未确认完成；自动压缩已暂停。新增用户/工具输入或显式手动压缩后才重新评估。'),{code:'CONTEXT_COMPACTION_SUPPRESSED'});
    db.prepare('INSERT INTO assistant_compaction_blocks VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET input_signature=excluded.input_signature,effective_watermark=excluded.effective_watermark,checkpoint_through=excluded.checkpoint_through,generation=excluded.generation,reason=excluded.reason,created_at=excluded.created_at').run(s.id,value.signature,value.effectiveWatermark,value.through,generation,'in_progress',now());
    return value;
  }
  function fail(value:Input,reason:'failed'|'no_gain'){
    const saved=db.prepare('UPDATE assistant_compaction_blocks SET reason=? WHERE session_id=? AND input_signature=?').run(reason,value.sessionId,value.signature);
    if(saved.changes!==1)throw new Error('压缩抑制状态更新未确认');
  }
  function clear(value:Input){
    const saved=db.prepare('DELETE FROM assistant_compaction_blocks WHERE session_id=? AND input_signature=?').run(value.sessionId,value.signature);
    if(saved.changes!==1)throw new Error('压缩抑制状态清理未确认');
  }
  return {begin,fail,clear,status};
}
