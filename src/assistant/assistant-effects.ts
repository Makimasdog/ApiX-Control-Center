import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {CommandSafetyError} from './assistant-commands.js';
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function createEffectJournal({db,row,now}:Store){
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_effects(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL DEFAULT 1,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),scope_key TEXT NOT NULL,tool TEXT NOT NULL,state TEXT NOT NULL,input_fingerprint TEXT NOT NULL,output_fingerprint TEXT,result_event_id INTEGER REFERENCES assistant_events(id),created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS assistant_effect_scope ON assistant_effects(session_id,scope_key);CREATE UNIQUE INDEX IF NOT EXISTS assistant_effect_pending ON assistant_effects(session_id,scope_key) WHERE state='started';`);
  function begin(sessionId:string,taskId:string|undefined,tool:string,args:unknown,fingerprint:string,version:string){
    const turn=row<{id:number}>("SELECT MAX(id) AS id FROM assistant_events WHERE session_id=? AND ((role='user' AND kind='message') OR kind='resumed')",sessionId)?.id??0;
    const scope=createHash('sha256').update(JSON.stringify([sessionId,taskId,turn,tool,version,canonical(args)])).digest('hex');
    const pending=row<{id:string}>("SELECT id FROM assistant_effects WHERE session_id=? AND scope_key=? AND state='started'",sessionId,scope);
    if(pending)throw new CommandSafetyError('同一有副作用操作的结果尚未确认；不重复执行',pending.id);
    const old=row<{id:string;body:string}>("SELECT x.id,e.body FROM assistant_effects x JOIN assistant_events e ON e.id=x.result_event_id AND e.session_id=x.session_id WHERE x.session_id=? AND x.scope_key=? AND x.state='completed' AND (x.input_fingerprint=? OR x.output_fingerprint=?) ORDER BY x.rowid DESC LIMIT 1",sessionId,scope,fingerprint,fingerprint);
    if(old)return {id:old.id,reused:true,result:JSON.parse(old.body).result};
    const id=randomUUID();db.prepare("INSERT INTO assistant_effects(id,session_id,scope_key,tool,state,input_fingerprint,created_at) VALUES (?,?,?,?,'started',?,?)").run(id,sessionId,scope,tool,fingerprint,now());return {id,reused:false,result:undefined};
  }
  function complete(id:string,eventId:number,fingerprint:string){db.prepare("UPDATE assistant_effects SET state='completed',result_event_id=?,output_fingerprint=? WHERE id=? AND state='started'").run(eventId,fingerprint,id);}
  return {begin,complete,pendingProject:(project:string)=>!!row("SELECT x.id FROM assistant_effects x JOIN assistant_sessions s ON s.id=x.session_id WHERE s.project_id=? AND x.state='started' LIMIT 1",project),rejectPreflight:(id:string)=>db.prepare("UPDATE assistant_effects SET state='failed_safe' WHERE id=? AND state='started'").run(id),pending:(id:string)=>!!row("SELECT id FROM assistant_effects WHERE session_id=? AND state='started' LIMIT 1",id),reconcile:(id:string)=>db.prepare("UPDATE assistant_effects SET state='reviewed_by_user' WHERE session_id=? AND state='started'").run(id)};
}
