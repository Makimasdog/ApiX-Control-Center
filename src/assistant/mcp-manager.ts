import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {statSync} from 'node:fs';
import {object,text,type Store} from '../coordination/contracts.js';
import {createToolRegistry,type ToolDefinition} from './tool-registry.js';

interface Config {id:string;name:string;transport:'stdio'|'http';command?:string;args:string[];url?:string;env:string[];headerEnv:Record<string,string>;enabled:boolean;version:number}
interface Connection {client:Client;transport:StdioClientTransport|StreamableHTTPClientTransport;version:number}
export function createMcpManager(store:Store,deps:{project(id:string):{path:string};environment():Record<string,string|undefined>}){
  const {db,row,rows,now}=store;const connections=new Map<string,Promise<Connection>>();
  db.exec('CREATE TABLE IF NOT EXISTS apix_mcp_servers(project_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id));CREATE TABLE IF NOT EXISTS apix_mcp_tools(project_id TEXT NOT NULL,server_id TEXT NOT NULL,name TEXT NOT NULL,remote_name TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,name))');
  const key=(projectId:string,id:string)=>projectId+':'+id;
  const configs=(projectId:string)=>{deps.project(projectId);return rows<{body:string}>('SELECT body FROM apix_mcp_servers WHERE project_id=? ORDER BY id',projectId).map(r=>JSON.parse(r.body) as Config);};
  async function closeConnection(c:Connection){
    // Kill the dedicated process tree before SDK close can lose the parent PID.
    const pid=c.transport instanceof StdioClientTransport?c.transport.pid:null;
    if(process.platform==='win32'&&pid)await new Promise<void>(resolve=>execFile('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:3000},()=>resolve()));
    await c.client.close().catch(()=>{});
  }
  async function disconnect(projectId:string,id:string,expected?:Connection){const k=key(projectId,id),pending=connections.get(k);if(!pending)return;if(expected){const actual=await pending.catch(()=>null);if(actual!==expected||connections.get(k)!==pending)return;}connections.delete(k);await pending.then(closeConnection,()=>{});}
  async function save(projectId:string,input:Record<string,unknown>){
    deps.project(projectId);const id=text(input.id,40);if(!/^[a-z][a-z0-9-]*$/.test(id))throw new Error('MCP ID 只能包含小写字母、数字和连字符');
    const previous=configs(projectId).find(c=>c.id===id);if(input.version!==(previous?.version??0))throw new Error('MCP 配置已变化，请刷新');
    if(typeof input.enabled!=='boolean'||input.enabled&&input.approved!==true)throw new Error('启用 MCP 需要用户明确批准连接和执行服务器程序');
    if(!previous&&configs(projectId).length>=10)throw new Error('每个项目最多配置 10 个 MCP 服务');
    const strings=(v:unknown)=>{if(!Array.isArray(v)||v.length>50||v.some(s=>typeof s!=='string'||s.length>2000))throw new Error('MCP 参数或环境变量列表无效');return v as string[];};
    const c:Config={id,name:text(input.name,100),transport:input.transport as Config['transport'],args:strings(input.args??[]),env:strings(input.env??[]),headerEnv:input.headerEnv===undefined?{}:object(input.headerEnv) as Record<string,string>,enabled:input.enabled,version:(previous?.version??0)+1};
    if(c.env.some(n=>!/^[_A-Z][_A-Z0-9]*$/.test(n))||Object.keys(c.headerEnv).length>10||Object.entries(c.headerEnv).some(([h,n])=>!/^[-A-Za-z0-9]+$/.test(h)||typeof n!=='string'||!/^[_A-Z][_A-Z0-9]*$/.test(n)))throw new Error('MCP 凭据只能引用环境变量名称');
    if(c.transport==='stdio'){c.command=text(input.command,1000);if(!isAbsolute(c.command)||/\.(cmd|bat|ps1)$/i.test(c.command)||!statSync(c.command).isFile())throw new Error('MCP 命令应为已有可执行文件或 JS 入口的绝对路径，不使用 shell 脚本包装');}
    else if(c.transport==='http'){const url=new URL(text(input.url,2000));if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('MCP 使用 HTTPS 或本机 HTTP，凭据请用 headerEnv 环境变量引用');c.url=url.href;}
    else throw new Error('MCP 传输仅支持 stdio 或 Streamable HTTP');
    const pending=disconnect(projectId,id);
    db.prepare('INSERT INTO apix_mcp_servers VALUES (?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body').run(projectId,id,JSON.stringify(c));db.prepare('DELETE FROM apix_mcp_tools WHERE project_id=? AND server_id=?').run(projectId,id);await pending;return c;
  }
  const current=(projectId:string,id:string)=>{const c=configs(projectId).find(c=>c.id===id);if(!c?.enabled)throw new Error('MCP 服务已停用或不存在');return c;};
  async function connect(projectId:string,c:Config,signal?:AbortSignal){
    const k=key(projectId,c.id);let pending=connections.get(k);if(pending)return pending;
    pending=(async()=>{
      const env=deps.environment(),selected:Record<string,string>={};
      for(const name of c.env){if(!env[name])throw new Error('MCP 环境变量不可用或与管理者凭据冲突');selected[name]=env[name]!;}
      const headers:Record<string,string>={};for(const [name,variable] of Object.entries(c.headerEnv)){if(!env[variable]||/[\r\n]/.test(env[variable]!))throw new Error('MCP 请求头环境变量不可用');headers[name]=env[variable]!;}
      const script=c.transport==='stdio'&&/\.[cm]?js$/i.test(c.command!);
      const transport=c.transport==='stdio'?new StdioClientTransport({command:script?process.execPath:c.command!,args:[...(script?[c.command!]:[]),...c.args],env:{...selected,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},cwd:deps.project(projectId).path,stderr:'pipe',maxBufferSize:2_000_000}):new StreamableHTTPClientTransport(new URL(c.url!),{requestInit:{headers,redirect:'error'}});
      if(transport instanceof StdioClientTransport)transport.stderr?.on('data',()=>{});
      const client=new Client({name:'apix',version:'0.1.0'});const connection={client,transport,version:c.version};
      client.onclose=()=>{if(connections.get(k)===pending)connections.delete(k);};
      try{await client.connect(transport,{timeout:10000,signal});if(current(projectId,c.id).version!==c.version)throw new Error('MCP 配置在连接期间变化');return connection;}
      catch{await closeConnection(connection);throw new Error('MCP 连接失败、超时或已取消；未执行工具，请检查服务配置');}
    })();connections.set(k,pending);try{return await pending;}catch(error){if(connections.get(k)===pending)connections.delete(k);throw error;}
  }
  function catalog(projectId:string):ToolDefinition[]{const active=new Map(configs(projectId).filter(c=>c.enabled).map(c=>[c.id,c.version]));return rows<{server_id:string;body:string}>('SELECT server_id,body FROM apix_mcp_tools WHERE project_id=?',projectId).flatMap(r=>{const d=JSON.parse(r.body) as ToolDefinition;return d.version?.startsWith(active.get(r.server_id)+':')?[d]:[];});}
  async function discover(projectId:string,signal?:AbortSignal){
    const errors:string[]=[];
    for(const c of configs(projectId).filter(c=>c.enabled)){
      if(signal?.aborted)throw new Error('MCP 发现已取消');
      try{const {client}=await connect(projectId,c,signal);const response=await client.listTools({},{timeout:10000,signal});if(current(projectId,c.id).version!==c.version)throw new Error('配置已变化');
        const definitions=response.tools.slice(0,100).flatMap(t=>{
          const name='mcp_'+c.id.replace(/-/g,'_')+'_'+createHash('sha256').update(t.name).digest('hex').slice(0,16);
          const definition:ToolDefinition={name,description:`${c.name} / ${t.name}: ${String(t.description??'').slice(0,1000)}`,inputSchema:t.inputSchema,readOnly:false,changesWorkspace:true,deferred:true,version:c.version+':'+createHash('sha256').update(JSON.stringify([t.name,t.inputSchema])).digest('hex')};
          try{createToolRegistry([definition]);return [{definition,remote:t.name}];}catch{errors.push(c.name+'：某工具 Schema 无效，已忽略');return [];}
        });
        db.exec('SAVEPOINT mcp_discovery');try{db.prepare('DELETE FROM apix_mcp_tools WHERE project_id=? AND server_id=?').run(projectId,c.id);for(const {definition,remote} of definitions)db.prepare('INSERT INTO apix_mcp_tools VALUES (?,?,?,?,?)').run(projectId,c.id,definition.name,remote,JSON.stringify(definition));}catch(error){db.exec('ROLLBACK TO mcp_discovery');throw error;}finally{db.exec('RELEASE mcp_discovery');}
      }catch{if(configs(projectId).find(saved=>saved.id===c.id)?.version===c.version){db.prepare('DELETE FROM apix_mcp_tools WHERE project_id=? AND server_id=?').run(projectId,c.id);await disconnect(projectId,c.id);}errors.push(c.name+'：无法发现工具，请检查连接、凭据或超时');}
    }return {tools:catalog(projectId),errors};
  }
  async function call(projectId:string,name:string,args:Record<string,unknown>,version:string,signal:AbortSignal){
    const saved=row<{server_id:string;remote_name:string;body:string}>('SELECT * FROM apix_mcp_tools WHERE project_id=? AND name=?',projectId,name);if(!saved)throw new Error('MCP 工具尚未发现');const c=current(projectId,saved.server_id),definition=JSON.parse(saved.body) as ToolDefinition;
    if(definition.version!==version||!version.startsWith(c.version+':'))throw new Error('MCP 工具或配置已变化，请重新发现并批准');
    const connection=await connect(projectId,c,signal);createToolRegistry([definition]).validate(name,args);
    if(signal.aborted||current(projectId,c.id).version!==c.version)throw new Error('MCP 调用已取消或配置变化');
    try{const result=await connection.client.callTool({name:saved.remote_name,arguments:args},undefined,{timeout:30000,signal});if(JSON.stringify(result).length>2_000_000)throw new Error('MCP 返回内容过大');return {...result,source:{serverId:c.id,tool:saved.remote_name,version},replayed:false};}
    catch{await disconnect(projectId,c.id,connection);throw new Error('MCP 调用失败或已取消；外部副作用可能已发生，不自动重放，请核对实际结果');}
  }
  return {configs,save,catalog,discover,call,async close(){await Promise.all([...connections.values()].map(p=>p.then(closeConnection,()=>{})));connections.clear();}};
}
