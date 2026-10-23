// Liveness is evidence of activity, not proof of successful work. Uncertain work is never replayed.
export function createAgentHealth({db,row,rows,now,probe,stop,record,owned,uncertain=()=>{},silenceMs=300000,probeMs=60000,maxRunMs=1800000}){
  if(!Number.isSafeInteger(maxRunMs)||maxRunMs<silenceMs||!Number.isSafeInteger(silenceMs)||!Number.isSafeInteger(probeMs)||probeMs<100||silenceMs<probeMs*2)throw Error('Agent 失联检测时限无效');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_health(run_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL DEFAULT 1,task_id TEXT NOT NULL,last_activity_at TEXT NOT NULL,last_probe_at TEXT,misses INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);`);
  function observe(runId){db.prepare("UPDATE agent_health SET last_activity_at=?,last_probe_at=NULL,misses=0,state='healthy' WHERE run_id=? AND state IN ('healthy','suspected')").run(now(),runId);}
  function started(runId,taskId){db.prepare("INSERT OR IGNORE INTO agent_health(run_id,task_id,last_activity_at,state) VALUES (?,?,?,'healthy')").run(runId,taskId,now());}
  function finished(runId){db.prepare("UPDATE agent_health SET state='ended' WHERE run_id=?").run(runId);}
  function tick(){for(const pending of rows("SELECT h.* FROM agent_health h JOIN runs r ON r.id=h.run_id WHERE h.state='stopping' AND r.status IN ('running','stopping')")){if(Date.parse(now())-Date.parse(pending.last_probe_at)>=10000){db.prepare("UPDATE agent_health SET state='unknown' WHERE run_id=?").run(pending.run_id);uncertain(pending.run_id);record(pending.task_id,'agent.stop_unknown',{schema:1,runId:pending.run_id,category:'unknown_effect',strategy:'review'});}}for(const item of rows("SELECT h.*,r.started_at AS run_started_at FROM agent_health h JOIN runs r ON r.id=h.run_id JOIN tasks t ON t.id=h.task_id WHERE h.state IN ('healthy','suspected') AND r.status='running' AND t.status='running'")){
    const elapsed=Date.parse(now())-Date.parse(item.last_activity_at),deadline=Date.parse(now())-Date.parse(item.run_started_at)>=maxRunMs;if(!deadline&&elapsed<probeMs)continue;
    if(!owned(item.run_id)){db.prepare("UPDATE agent_health SET state='unknown' WHERE run_id=?").run(item.run_id);uncertain(item.run_id);record(item.task_id,'agent.liveness_unknown',{schema:1,runId:item.run_id});continue;}
    if(deadline||elapsed>=silenceMs&&item.misses>=2){
      const changed=db.prepare("UPDATE agent_health SET state='stopping',last_probe_at=? WHERE run_id=? AND state IN ('healthy','suspected')").run(now(),item.run_id);if(!changed.changes)continue;
      record(item.task_id,'agent.unresponsive',{schema:1,runId:item.run_id,silenceMs:elapsed,missedProbes:item.misses,reason:deadline?'runtime_deadline':'silence',category:'unresponsive',strategy:'review'});
      // Persist the stop intent first: a restart or duplicate tick cannot dispatch another stop/repair.
      try{stop(item.run_id);}catch{db.prepare("UPDATE agent_health SET state='unknown' WHERE run_id=?").run(item.run_id);uncertain(item.run_id);record(item.task_id,'agent.stop_unknown',{schema:1,runId:item.run_id,category:'unknown_effect',strategy:'review'});}continue;
    }
    if(item.last_probe_at&&Date.parse(now())-Date.parse(item.last_probe_at)<probeMs)continue;
    probe(item.task_id,item.run_id,item.misses+1);
    db.prepare("UPDATE agent_health SET state='suspected',last_probe_at=?,misses=misses+1 WHERE run_id=?").run(now(),item.run_id);
    record(item.task_id,'agent.probe',{schema:1,runId:item.run_id,miss: item.misses+1});
  }}
  return {observe,started,finished,tick,state:runId=>row('SELECT * FROM agent_health WHERE run_id=?',runId)};
}
