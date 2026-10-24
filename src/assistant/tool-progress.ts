import {type Store} from '../coordination/contracts.js';
import {digest,ToolError} from './tool-governance.js';
const defaults={maxCalls:24,maxFailures:3,maxNoProgress:3,maxPolls:6,maxMs:1800000,maxBytes:2000000,pollMs:1000};
type Limits=typeof defaults;
function semantic(value:unknown):unknown {if(Array.isArray(value))return value.map(semantic);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['created_at','updated_at','createdAt','updatedAt','timestamp','operationId','elapsedMs','durationMs','reused','observedAt','observed_at','checkedAt','fetchedAt','outputRef'].includes(k)).map(([k,v])=>[k,semantic(v)]));return value;}
export function createToolProgress({db,row,rows,now}:Store){
  db.exec(`CREATE TABLE IF NOT EXISTS tool_limits(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tool_observations(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,turn_id INTEGER NOT NULL,signature TEXT NOT NULL,result_hash TEXT NOT NULL,code TEXT,bytes INTEGER NOT NULL,blocked INTEGER NOT NULL,created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS tool_progress_turn ON tool_observations(session_id,turn_id,id);`);
  function settings(projectId:string){if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new ToolError('NOT_FOUND','项目不存在','correct_input',{},404);const p=row<{body:string;version:number}>('SELECT * FROM tool_limits WHERE project_id=?',projectId);return {...defaults,...p?JSON.parse(p.body):{},version:p?.version??0} as Limits&{version:number};}
  function save(projectId:string,input:Record<string,unknown>){if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new ToolError('NOT_FOUND','项目不存在');const old=settings(projectId);if(old.version!==input.version)throw new ToolError('VERSION_CONFLICT','调用预算已变化','refresh',{},409);const caps={maxCalls:100,maxFailures:10,maxNoProgress:10,maxPolls:30,maxMs:3600000,maxBytes:10000000,pollMs:30000};const result={...defaults};for(const k of Object.keys(defaults) as (keyof Limits)[]){const v=input[k];if(!Number.isSafeInteger(v)||Number(v)<(k==='maxMs'?1000:k==='maxBytes'?1000:k==='pollMs'?100:2)||Number(v)>caps[k])throw new ToolError('INVALID_ARGUMENTS','调用预算参数无效：'+k);result[k]=Number(v);}db.prepare('INSERT INTO tool_limits VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body,version=excluded.version').run(projectId,JSON.stringify(result),old.version+1);return settings(projectId);}
  const turn=(id:string)=>row<{id:number}>("SELECT MAX(id) AS id FROM assistant_events WHERE session_id=? AND (kind='message' AND role='user' OR kind='resumed')",id)?.id??0;
  function history(id:string){return rows<{signature:string;result_hash:string;code:string|null;bytes:number;blocked:number;created_at:string}>('SELECT * FROM tool_observations WHERE session_id=? AND turn_id=? ORDER BY id',id,turn(id));}
  function check(id:string,projectId:string,tool:string,args:unknown,accessVersion:string|number){const limits=settings(projectId),h=history(id),signature=digest({tool,args,accessVersion});
    const fatal=(code:string,message:string):never=>{throw new ToolError(code,message,'stop_and_review');};
    if(h.length>=limits.maxCalls||h.reduce((n,x)=>n+x.bytes,0)>=limits.maxBytes||h.length&&Date.now()-Date.parse(h[0]!.created_at)>limits.maxMs)fatal('TOOL_BUDGET_EXCEEDED','达到工具调用、时间或结果字节预算');
    const matching=h.filter(x=>x.signature===signature&&!x.blocked),last=matching.at(-1),poll=['inspect_agents','inspect_quota'].includes(tool);
    let reason='';
    if(last?.code&&['INVALID_ARGUMENTS','TOOL_FORBIDDEN','TOOL_SCHEMA_INVALID','TOOL_NOT_FOUND'].includes(last.code))reason='确定性错误必须修正参数或由所有者调整授权';
    if(matching.length>=(poll?limits.maxPolls:limits.maxNoProgress)&&new Set(matching.slice(-(poll?limits.maxPolls:limits.maxNoProgress)).map(x=>x.result_hash)).size===1)reason=poll?'轮询未观察到新进展':'相同工具与参数反复返回相同结果';
    if(h.slice(-limits.maxFailures).length===limits.maxFailures&&h.slice(-limits.maxFailures).every(x=>x.code))reason='连续工具失败，需要改变策略';
    const trail=h.filter(x=>!x.blocked).map(x=>x.signature+':'+x.result_hash);for(let width=2;width<=4;width++){if(trail.length<width*limits.maxNoProgress)continue;const end=trail.slice(-width*limits.maxNoProgress);if(new Set(end.slice(-width).map(v=>v.split(':')[0])).size>1&&end.slice(-width).some(v=>v.startsWith(signature+':'))&&end.every((v,i)=>v===end[i%width]))reason='多个工具形成无进展的循环';}
    if(reason){if(h.some(x=>x.blocked&&x.signature===signature))fatal('TOOL_LOOP_STOPPED',reason+'；重复路径已停止');throw new ToolError('TOOL_PATH_BLOCKED',reason+'。改用其他工具、修正原因或向用户澄清','change_strategy');}
    return {signature,delay:poll&&last?Math.min(30000,limits.pollMs*2**Math.min(4,matching.length-1)):0};
  }
  function observe(id:string,signature:string,result:unknown,code?:string,blocked=false){db.prepare('INSERT INTO tool_observations(session_id,turn_id,signature,result_hash,code,bytes,blocked,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,turn(id),signature,digest(semantic(result)),code??null,Buffer.byteLength(JSON.stringify(result)??''),blocked?1:0,now());}
  return {settings,save,check,observe,signature:(tool:string,args:unknown,accessVersion:string|number)=>digest({tool,args,accessVersion})};
}
