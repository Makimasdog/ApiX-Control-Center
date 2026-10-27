/**
 * server.mjs - ApiX 控制台的 HTTP 入口文件
 *
 * 所属层级：入口层（整个后端服务的唯一入口）
 * 核心功能：
 *   1. 创建 HTTP 服务器并监听本机 127.0.0.1（不暴露到局域网/公网）
 *   2. 路由分发：API 接口 → 员工通道 → 知识库/工具治理 → 通用路由表 → 静态文件
 *   3. 安全中间件：Host/Origin 校验（防 DNS 重绑定）、所有者门禁（Cookie 鉴权）
 *   4. 统一错误出口：ToolError 语义映射（401/404/405/409/413/500）
 *   5. 优雅退出：SIGINT/SIGTERM 信号处理，先断 MCP 连接再退出进程
 *
 * 依赖关系：
 *   - 调用 → control-plane.mjs（业务函数：知识库、工具治理、Agent 信箱等）
 *   - 调用 → src/infrastructure/api-routes.mjs（路由表定义）
 *   - 调用 → src/infrastructure/owner-access.mjs（所有者鉴权）
 *   - 调用 → src/infrastructure/static-files.mjs（静态文件白名单）
 *   - 被调用 → 无（这是最顶层入口）
 */
// ApiX 控制台 HTTP 入口:P7 重构后本文件只保留「执行管线 + 员工通道 + 知识/工具域 + 静态文件」。
// 路由表与每条路由的请求体限额在 src/infrastructure/api-routes.mjs;管线统一负责 Host/Origin 校验、
// 所有者门禁、405/404/409 语义(方法不匹配 405、路径未注册 404、legacy 未开启 409)与错误映射。
import {knowledgeBase,toolGovernance,toolProgress,invokeAgentTool} from './control-plane.mjs';
import {errorInfo,ToolError} from './dist/src/assistant/tool-governance.js';
import {createOwnerAccess,ownerLoginHtml} from './src/infrastructure/owner-access.mjs';
import { createServer } from "node:http";
import {staticFilePath} from './src/infrastructure/static-files.mjs';
import {apiRoutes,requiredProject} from './src/infrastructure/api-routes.mjs';
import { authenticateAgent, agentTeam, superviseWorkerMessage, receiveAgentMessages, sendAgentMessage, handleAgentMessage, closeMcpConnections} from './control-plane.mjs';
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const ownerAccess=createOwnerAccess(port);
const contentTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".wasm": "application/wasm",
};
// 读请求体:分块累积,超过 max(byteLimit 为真按字节,否则按字符)后丢弃内容但继续读完,再抛 413 —— 请求体
// 完整消费后 socket 才能安全复用(P5:提前断开会让同连接池的下一个请求收到 ECONNRESET)。
/**
 * readBody - 读取 HTTP 请求体，带大小限制
 *
 * @param {import('http').IncomingMessage} request - Node.js 原始请求对象
 * @param {number} maxBytes - 允许的最大字节/字符数
 * @param {boolean} byteLimit - true 时按字节计数（用 Buffer.byteLength），false 时按字符计数
 * @returns {Promise<string>} 请求体文本
 * @throws {ToolError} 超过限额时抛 PAYLOAD_TOO_LARGE（HTTP 413）
 *
 * 设计意图：分块累积读取，超限后仍读完剩余数据再抛错——这样 socket 才能安全复用，
 * 否则同连接池的下一个请求会收到 ECONNRESET（P5 修复）。
 */
async function readBody(request,maxBytes,byteLimit=false){
  request.setEncoding('utf8');let raw='',size=0;
  for await (const chunk of request) {size+=byteLimit?Buffer.byteLength(chunk):chunk.length;raw=size<=maxBytes?raw+chunk:'';}
  if(size>maxBytes)throw new ToolError('PAYLOAD_TOO_LARGE','请求过大','correct_input',{},413);
  return raw;
}
/**
 * sendJson - 向客户端发送 JSON 响应
 *
 * @param {import('http').IncomingMessage} request - 请求对象（用于检查请求是否完整接收）
 * @param {import('http').ServerResponse} response - 响应对象
 * @param {number} status - HTTP 状态码
 * @param {unknown} value - 要序列化为 JSON 的数据
 *
 * 如果请求体未完整接收（客户端发了 Content-Length 但中途断开），设置 Connection: close
 * 告知客户端连接将关闭，避免 Keep-Alive 连接上的下一个请求出错。
 */
function sendJson(request,response,status,value){
  if(!request.complete&&(Number(request.headers['content-length'])>0||request.headers['transfer-encoding'])){response.setHeader("Connection","close");request.resume();}
  response.writeHead(status,{ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
// ===== HTTP 服务器主回调：每个请求都会走到这里 =====
createServer(async (request,response)=>{
  // 地址里有非法百分号转义(比如孤立的 %)时,decodeURIComponent 会抛错;当场回 400,不再往下走。
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname); }
  catch { response.writeHead(400); response.end("Bad request"); return; }
  if (pathname.startsWith("/api/")) {
    // 第一道安全校验:Host 头必须是本机地址(防 DNS 重绑定);第二道:跨站 Origin 直接拒绝,curl 等无 Origin 客户端不受影响。
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')) { response.writeHead(403); response.end('Forbidden host'); return; }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) { response.writeHead(403); response.end("Forbidden origin"); return; }
    const send=(status,value)=>sendJson(request,response,status,value);
    try {
      if(pathname==='/api/owner/login'&&request.method==='POST'){
        const raw=await readBody(request,1000);
        if(!ownerAccess.equals(JSON.parse(raw).token)){send(401,{error:'需要本机所有者令牌',code:'OWNER_REQUIRED',retryable:false});return;}
        response.setHeader('Set-Cookie',ownerAccess.cookie());send(200,{connected:true});return;
      }
      if(!pathname.startsWith('/api/agent/')&&!ownerAccess.authorized(request)){send(401,{error:'需要本机所有者身份',code:'OWNER_REQUIRED',retryable:false});return;}
      // 【员工通道】/api/agent/* 是给“正在被 ApiX 驱动的外部 Agent 进程”用的:凭启动令牌表明身份,通过信箱收发消息。
      // 这一整段先处理完就 return,不会落到通用路由表里。
      if (pathname.startsWith('/api/agent/')) {
        const workerIdentity=()=>{try{return authenticateAgent(request.headers.authorization);}catch(error){if(pathname.startsWith('/api/agent/tools/'))throw new ToolError('AGENT_UNAUTHORIZED','运行凭据无效或已结束','request_owner',{},401);throw error;}};
        let actor = workerIdentity();
        if (pathname === '/api/agent/team' && request.method === 'GET') { send(200, agentTeam(actor.project_id,actor.task_id)); return; }
        if (pathname === '/api/agent/messages' && request.method === 'GET') { send(200, receiveAgentMessages(actor)); return; }
        if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Unsupported request');
        const body=await readBody(request,30000);
        // 收 body 期间已经 await 过,令牌或其授权状态可能在这段空档里变化,动手前再校验一次(TOCTOU 防护)。
        const input = JSON.parse(body || '{}');
        actor = workerIdentity();
        if(/^\/api\/agent\/tools\/[a-zA-Z]\w{0,119}$/.test(pathname)){send(200,await invokeAgentTool(actor,pathname.split('/')[4],input));return;}
        if (pathname === '/api/agent/messages') {
          const message = sendAgentMessage(actor,input);
          send(200,message);
          void superviseWorkerMessage(message.id).catch(error => process.stderr.write(`ApiX guidance: ${error.message}\n`));
          return;
        }
        const match = /^\/api\/agent\/messages\/([^/]+)\/(ack|complete|nack)$/.exec(pathname);
        if (match) { send(200,handleAgentMessage(actor,match[1],match[2],input)); return; }
        if(pathname.startsWith('/api/agent/tools/'))throw new ToolError('TOOL_NOT_FOUND','工具路径无效','correct_input',{},404);
        throw new Error('Unknown Agent operation');
      }
      // 【知识库与工具治理域】结构化 ToolError 语义(401/404/405/409/413)保留在这一段:audit 只读 405、
      // 未知操作 404、知识上传限额 1.5MB(字节)、其余 30000 字节。
      const projectRoute=/^\/api\/projects\/([^/]+)\/(knowledge|tool-access|tool-limits)(?:\/(.*))?$/.exec(pathname);
      if(projectRoute){
        const [,projectId,domain,operation]=projectRoute,query=new URL(request.url,'http://localhost').searchParams;
        if(domain==='tool-access'&&operation&&operation!=='audit'||domain==='tool-limits'&&operation)throw new ToolError('NOT_FOUND','接口不存在','correct_input',{},404);
        if(domain==='tool-access'&&operation==='audit'&&request.method!=='GET')throw new ToolError('METHOD_NOT_ALLOWED','审计接口只允许读取','correct_input',{},405);
        if(request.method==='GET'){
          if(domain==='tool-access')send(200,operation==='audit'?toolGovernance.list(projectId):toolGovernance.get(projectId,query.get('subject')??'apix'));
          else if(domain==='tool-limits')send(200,toolProgress.settings(projectId));
          else if(operation==='source')send(200,knowledgeBase.read(projectId,query.get('citation')??''));
          else if(!operation)send(200,knowledgeBase.list(projectId));else throw new ToolError('NOT_FOUND','接口不存在','correct_input',{},404);
          return;
        }
        if(request.method!=='POST'||request.headers['content-type']?.split(';')[0]!=='application/json')throw new ToolError('INVALID_ARGUMENTS','需要 JSON POST');
        const raw=await readBody(request,domain==='knowledge'&&operation==='documents/upload'?1500000:30000,true);
        const input=JSON.parse(raw||'{}');if(!input||typeof input!=='object'||Array.isArray(input))throw new ToolError('INVALID_ARGUMENTS','需要 JSON 对象');
        let result;
        if(domain==='tool-access')result=toolGovernance.save(projectId,input);
        else if(domain==='tool-limits')result=toolProgress.save(projectId,input);
        else if(operation==='spaces/save')result=knowledgeBase.saveSpace(projectId,input);
        else if(operation==='spaces/remove')result=knowledgeBase.removeSpace(projectId,input);
        else if(operation==='documents/upload')result=knowledgeBase.upload(projectId,input);
        else if(operation==='documents/remove')result=knowledgeBase.removeDocument(projectId,input);
        else if(operation==='search')result=knowledgeBase.search(projectId,input.query,'owner',input.spaceId,input.limit??6);
        else throw new ToolError('NOT_FOUND','接口不存在','correct_input',{},404);
        send(200,result);return;
      }
      // ===== 通用路由表:匹配顺序即表序;同一路径方法不符回 405,完全未注册回 404 =====
      const candidates=apiRoutes.filter(route=>route.pattern.test(pathname));
      if(!candidates.length){send(404,{error:'Not found'});return;}
      const route=candidates.find(route=>route.method===request.method);
      if(!route){send(405,{error:'Unsupported request'});return;}
      if(route.method==='POST'&&request.headers['content-type']?.split(';')[0]!=='application/json'){send(405,{error:'Unsupported request'});return;}
      const raw=route.limit?await readBody(request,route.limit[0],route.limit[1]):'';
      if(route.legacy&&process.env.APIX_LEGACY_API!=='1'){send(409,{error:'请在 ApiX 目标工作台澄清并确认需求后安排任务'});return;}
      const value=await route.handler({req:request,res:response,m:route.pattern.exec(pathname),query:new URL(request.url,'http://localhost').searchParams,body:route.limit?JSON.parse(raw||'{}'):undefined,send});
      if(!route.raw)send(200,value);
    // 【统一错误出口】接口处理中任何抛错都在这里收口:数据库/运行时缺陷是 500;ToolError 用自带状态码;其余业务错误 400。
    } catch (error) {
      if(!(error instanceof ToolError)&&(error instanceof TypeError||error instanceof ReferenceError||/^(?:ERR_SQLITE|SQLITE_)/.test(error.code??''))){
        process.stderr.write(`ApiX HTTP: ${error.stack??error.message}\n`);
        send(500,{error:'服务端内部错误，请查看本机日志',code:'INTERNAL_ERROR',retryable:false});
      }else{
        const failure=pathname.startsWith('/api/agent/tools/')&&!(error instanceof ToolError)?new ToolError('INVALID_ARGUMENTS','工具请求格式无效','correct_input'):error;
        send(failure instanceof ToolError?failure.status:400,{error:failure.message,...failure instanceof ToolError?errorInfo(failure):{}});
      }
    }
    return;
  }
// ===== 静态文件区 =====
// 不是 /api 开头的请求都走到这里，用于提供前端 HTML/JS/CSS 等静态资源
// 安全机制：Host 校验 + 所有者鉴权 + 白名单路径 + 目录穿越防护 + 只允许 GET/HEAD
  if(pathname==='/'||pathname==='/index.html'){
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(request.headers.host??'')){response.writeHead(403);response.end('Forbidden host');return;}
    if(!ownerAccess.authorized(request)){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(ownerLoginHtml);return;}
    response.setHeader('Set-Cookie',ownerAccess.cookie());
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  // staticFilePath 维护允许公开访问的“白名单”,是安全边界 —— 防止源码、数据库文件或 .env 密钥被下载。
  const publicPath = staticFilePath(root, relativePath);
  if (!publicPath) { response.writeHead(404); response.end('Not found'); return; }
  const filePath = normalize(publicPath);
  // normalize 折叠 a/../b 片段后确认仍在 root 内,阻止目录穿越;同时只允许 GET/HEAD。
  if (!filePath.startsWith(`${root}${sep}`) || !["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
// ===== 启动服务器 =====
// 【只绑本机】监听 127.0.0.1:这台控制台持有模型密钥、能驱动进程执行任务,不适合暴露到局域网或公网。
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`ApiX Web: http://127.0.0.1:${port}\n`);
});
// ===== 优雅退出 =====
// SIGINT（Ctrl+C）或 SIGTERM 信号触发：
// 1. 先通知外部 MCP 服务断开连接（closeMcpConnections）
// 2. 4 秒兜底定时器防止 MCP 关闭卡死（unref 不阻塞进程退出）
// shuttingDown 标志防止信号重复触发导致多次退出
let shuttingDown=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{if(shuttingDown)return;shuttingDown=true;setTimeout(()=>process.exit(0),4000).unref();void closeMcpConnections().finally(()=>process.exit(0));});
