import {digest,redact} from '../assistant/tool-governance.js';
import type {Store} from '../coordination/contracts.js';
import {runtimeError,type RunHandle} from './runtime-contract.js';

type InteractionRow={id:string;run_id:string;kind:string;payload_json:string;permission_version:string;state:string;answer_delivery:string;expires_at:string};

export function createRuntimeInteractions({db,row,rows,now}:Store,guard:(runId:string)=>string,handle:(id:string)=>RunHandle|undefined,stop:(id:string)=>void=id=>handle(id)?.interrupt()){
  db.exec(`CREATE TABLE IF NOT EXISTS agent_runtime_interactions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,payload_json TEXT NOT NULL,permission_version TEXT NOT NULL,state TEXT NOT NULL,answer_request_id TEXT,answer_hash TEXT,answer_delivery TEXT NOT NULL DEFAULT 'not_sent',expires_at TEXT NOT NULL,answered_at TEXT);`);
  db.prepare("UPDATE agent_runtime_interactions SET state='invalidated',answer_delivery=CASE WHEN answer_request_id IS NULL THEN answer_delivery ELSE 'unknown' END WHERE state='pending'").run();
  function open(runId:string,payload:Record<string,any>){
    const version=guard(runId),run=row<{started_at:string}>('SELECT started_at FROM runs WHERE id=?',runId)!;
    const expires=new Date(Math.min(Date.parse(now())+900000,Date.parse(run.started_at)+Number(process.env.APIX_AGENT_MAX_RUN_MS??1800000))).toISOString();
    db.prepare("INSERT OR IGNORE INTO agent_runtime_interactions(id,run_id,kind,payload_json,permission_version,state,expires_at) VALUES (?,?,?,?,?,'pending',?)").run(payload.interactionId,runId,payload.kind,JSON.stringify(redact(payload.request,false)),version,expires);
  }
  function invalidate(id:string){db.prepare("UPDATE agent_runtime_interactions SET state='invalidated' WHERE run_id=? AND state='pending'").run(id);}
  const view=(r:InteractionRow)=>({id:r.id,runId:r.run_id,kind:r.kind,request:JSON.parse(r.payload_json),permissionVersion:r.permission_version,state:r.state,answerDelivery:r.answer_delivery,expiresAt:r.expires_at});
  function list(runId:string){return rows<InteractionRow>('SELECT id,run_id,kind,payload_json,permission_version,state,answer_delivery,expires_at FROM agent_runtime_interactions WHERE run_id=? ORDER BY rowid',runId).map(view);}
  function forCoordination(projectId:string,sessionId:string){
    return rows<InteractionRow & {employee:string}>(`
      SELECT i.id,i.run_id,i.kind,i.payload_json,i.permission_version,i.state,i.answer_delivery,i.expires_at,
             COALESCE(e.name,r.runtime) AS employee
      FROM coordination_sessions s
      JOIN tasks t ON t.plan_id=s.plan_id AND t.project_id=s.project_id
      JOIN runs r ON r.task_id=t.id
      JOIN agent_runtime_interactions i ON i.run_id=r.id
      LEFT JOIN employees e ON e.id=t.employee_id
      WHERE s.id=? AND s.project_id=? AND s.archived_at IS NULL AND s.deleted_at IS NULL
        AND r.status IN ('starting','running') AND r.stop_requested_at IS NULL
        AND i.state='pending' AND i.expires_at>?
      ORDER BY i.rowid`,sessionId,projectId,now()).map(r=>({...view(r),employee:r.employee}));
  }
  async function answer(runId:string,id:string,input:Record<string,any>){
    const saved=row<any>('SELECT * FROM agent_runtime_interactions WHERE id=? AND run_id=?',id,runId);if(!saved)throw runtimeError('INTERACTION_EXPIRED','此交互不属于当前 Run');
    if(!/^[a-zA-Z0-9:_-]{8,100}$/.test(input.requestId??''))throw runtimeError('INVALID_ARGUMENTS','回答请求 ID 无效',400);
    const value=input.answer,hash=digest(value);
    if(saved.answer_request_id){if(saved.answer_request_id!==input.requestId||saved.answer_hash!==hash)throw runtimeError('IDEMPOTENCY_CONFLICT','问题已有其他答案');return {state:saved.state,delivery:saved.answer_delivery};}
    if(saved.state!=='pending'||saved.expires_at<=now())throw runtimeError('INTERACTION_EXPIRED','此交互已失效');
    let version:string;try{version=guard(runId);}catch(error){invalidate(runId);throw error;}
    if(input.expectedPermissionVersion!==saved.permission_version||version!==saved.permission_version){invalidate(runId);throw runtimeError('PERMISSION_CHANGED','执行权限或需求已变化，请重新检查任务');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw runtimeError('INVALID_ARGUMENTS','回答格式无效',400);
    if(saved.kind==='approval'){if(!['approve','deny'].includes(value.decision)||Object.keys(value).some(k=>k!=='decision'))throw runtimeError('INVALID_ARGUMENTS','仅允许批准或拒绝本次操作',400);}
    else{
      const spec=JSON.parse(saved.payload_json),answers=value.answers;
      const allowed=(spec.questions??[]).map((q:any)=>String(q.id??q.question));
      if(Object.keys(value).some(k=>k!=='answers')||!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).some(k=>!allowed.includes(k))||allowed.some((k:string)=>!Object.hasOwn(answers,k))||Object.values(answers).some(v=>spec.answerFormat==='claude'?typeof v!=='string'||v.length>4000:!v||typeof v!=='object'||Object.keys(v).length!==1||!Array.isArray((v as any).answers)||(v as any).answers.length>30||(v as any).answers.some((x:any)=>typeof x!=='string'||x.length>4000))||JSON.stringify(answers).length>16000)throw runtimeError('INVALID_ARGUMENTS','问题答案须与当前问题逐项对应',400);
    }
    const active=handle(runId);if(!active?.answer)throw runtimeError('RUN_NOT_ACTIVE','运行不再接收回答');
    db.prepare("UPDATE agent_runtime_interactions SET state=?,answer_request_id=?,answer_hash=?,answer_delivery='unknown',answered_at=? WHERE id=? AND state='pending'").run(value.decision==='deny'?'denied':'answered',input.requestId,hash,now(),id);
    try{await active.answer(id,value);db.prepare("UPDATE agent_runtime_interactions SET answer_delivery='accepted' WHERE id=?").run(id);}catch{throw runtimeError('DELIVERY_UNKNOWN','答案已保存，但原生接收未确认；不要重复发送');}
    return {state:value.decision==='deny'?'denied':'answered',delivery:'accepted'};
  }
  function tick(){for(const entry of rows<{run_id:string}>("SELECT DISTINCT run_id FROM agent_runtime_interactions WHERE state='pending' AND expires_at<=?",now())){db.prepare("UPDATE agent_runtime_interactions SET state='expired' WHERE run_id=? AND state='pending'").run(entry.run_id);stop(entry.run_id);}}
  return {open,invalidate,list,forCoordination,answer,tick,pending:(id:string)=>!!row("SELECT id FROM agent_runtime_interactions WHERE run_id=? AND state='pending' AND expires_at>?",id,now())};
}
