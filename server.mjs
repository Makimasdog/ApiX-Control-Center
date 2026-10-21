// 【这个文件是什么】ApiX 的 Web 服务入口:`npm start` 实际执行的就是 `node server.mjs`。
// 它只承担两件事:① 接收浏览器发来的 /api/* 请求,判断该调用哪个业务函数,把结果转成 JSON 返回;
// ② 把 index.html / css / js 这些前端文件发给浏览器。
// 真正的业务逻辑(读数据库、跑任务、调模型)全部在 control-plane.mjs 里,所以本文件是“接线层”。
// 初学者不必记住每个接口,只要抓住固定套路:匹配路径 → 调用函数 → send 返回。
// 下面这些 import 就是把控制面导出的函数逐个引进来给路由使用(名字都在花括号里,仅来源文件不同)。
import {assistantProjectDiagnosis,assistantNpmProposal,assistantApproveNpm} from './control-plane.mjs';
import {conversationModel,saveConversationModel} from './control-plane.mjs';
import { createServer } from "node:http";
import {staticFilePath} from './src/infrastructure/static-files.mjs';
import {browseFolders} from './src/projects/project-folders.mjs';
import {inspectEmployeeRuntime} from './control-plane.mjs';
import {mcpServers,saveMcpServer,discoverMcpTools,closeMcpConnections} from './control-plane.mjs';
import {assistantOutput,assistantLogOutput} from './control-plane.mjs';
import {assistantStartTask,assistantDelivery,assistantDeliveryFile,assistantReviewDelivery} from './control-plane.mjs';
import {chatHistory,changeChatHistory} from './control-plane.mjs';
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot, scanRuntimes, taskDetails, registerEmployee, updateEmployee, deleteEmployee, createProject, updateProject, createConversation, renameConversation, createTask, resumeTask, saveProjectProfile, createMemory, updateMemory, deleteMemory, searchMemories, createDirectorPlan, sendDirectorMessage, saveDirectorProposal, approveDirectorProposal, approveDirectorPlan, cancelPendingDirectorPlan, revisePendingPlanTask, resolveApproval, stopRun, acceptTask, createDepartment, updateDepartment, addRepository, saveWorkflowPack, workflowPack, createCollaborativePlan, createReviewMeeting, createManagerReview, prepareIntegration, applyIntegration, registerMailbox, listMailboxes, sendMessage, receiveMessages, ackMessage, nackMessage, completeMessage, rejectMessage, messageDetails, messageThread, messageEventsSince, acquireLock, renewLock, releaseLock, listLocks, attachMessageArtifact } from "./control-plane.mjs";
import { listCoordinationSessions, coordinationSessionDetails, createCoordinationSession, answerCoordinationSession, confirmCoordinationSession, dispatchCoordinationSession, reviseCoordinationSession, coordinationTimeline } from "./control-plane.mjs";
import { discussCoordinationSession, setCoordinationInteractionMode, editCoordinationPlan, changePermission, permissionPolicy, managerSettings, saveManagerSettings, testManagerConnection, searchCoordinationMemory, employeeDetails } from "./control-plane.mjs";
import { registerRuntimeAdapter, authenticateAgent, agentTeam, instructCoordinationEmployee, superviseWorkerMessage, receiveAgentMessages, sendAgentMessage, handleAgentMessage, taskDelivery, freezeHistoricalDelivery,executionSettings,saveExecutionSettings,changeRuntimePause,recoverTask } from './control-plane.mjs';
import { BUILTIN_PROVIDERS } from './dist/src/models/model-providers.js';
import { schedulingAccount,resumeSchedulingAccount,employeeCapability,saveEmployeeCapability,schedulingView,saveSchedulingPolicy,settleSchedulingCost,runPlanningMeeting,applyPlanningMeeting } from './control-plane.mjs';
import { readLocalModels } from './dist/src/models/local-models.js';
import {workflowSettings,saveWorkflow,stopCoordinationSession,readiness,inspectTaskDelivery} from './control-plane.mjs';
import {autonomySettings,saveAutonomySettings,resumeAutonomySession} from './control-plane.mjs';
import {createAssistantSession,assistantSession,assistantSessions,assistantMessage,assistantReply,assistantStop,assistantResume,assistantEditMemory,assistantEvents} from './control-plane.mjs';

// root = 本文件所在目录的绝对路径。后面所有静态文件都相对它拼接,这样就不依赖启动时的当前工作目录。
// import.meta.url 是“当前模块的 file:// 地址”,fileURLToPath 转成普通路径,dirname 再取其所在目录。
const root = dirname(fileURLToPath(import.meta.url));
// 监听端口:优先读环境变量 PORT,没配置就用默认值 4173。
// `??` 只在左侧为 null/undefined 时才取右侧(与 `||` 的差别是 0 也算有效值);
// parseInt 的第二个参数 10 表示按十进制解析字符串。
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
// 扩展名 → HTTP Content-Type 对照表。浏览器靠这个头决定怎么解释收到的字节(当网页、当样式、当脚本)。
// 表里没有的扩展名会走后面的 application/octet-stream 兜底,意思是“当二进制流处理,不要执行”。
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// 【服务器主体】createServer 的回调函数每收到一个请求就被调用一次:
// request 是“浏览器要什么”,response 是“我们回什么”,一个请求内 response 只能写完一次。
// 回调是 async 的,因为不少业务函数需要等待模型子进程或磁盘。
// Freezing Git inputs can outlast the default idle timeout while a polling request is in transit.
createServer({keepAliveTimeout:65000},async (request, response) => {
  // pathname = 地址里去掉域名和 ?query 的部分,例如 /api/tasks/abc/details。
  // 地址里有非法百分号转义(比如孤立的 %)时,decodeURIComponent 会抛错;
  // 这里当场回 400 并结束请求,不再往下走(这种字节序列根本不对应任何合法路径)。
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  // 第一大分支:接口请求。命中 /api/ 前缀就走这里的 JSON 逻辑,处理完在末尾 return;
  // 没命中的(比如 / 和 /styles.css)会继续往下,交给最后的静态文件逻辑处理。
  if (pathname.startsWith("/api/")) {
    // 第一道安全校验:Host 头必须是本机地址。Host 是客户端自己写的,若允许外部域名解析到本机
    // (即 DNS 重绑定),别人就能用自家网页访问这台机器上的接口,所以这里把 Host 锁死。
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')) { response.writeHead(403); response.end('Forbidden host'); return; }
    // 第二道安全校验:同源检查。浏览器发跨站请求时会带 Origin 头,与本机的期望地址不一致就直接拒绝;
    // 手动调用的 curl 等客户端没有 Origin,因此不受影响。与上面 Host 检查配合,共同挡住
    // “网页偷偷调用本机接口”这条路。
    const origin = request.headers.origin;
    const expectedOrigin = `http://${request.headers.host}`;
    if (origin && origin !== expectedOrigin) { response.writeHead(403); response.end("Forbidden origin"); return; }
    // send 是本分支统一的返回工具:设状态码 + 把对象序列化成 JSON 发出。
    // no-store 禁止浏览器和中间代理缓存接口结果,保证 UI 看到的始终是最新状态。
    const send = (status, value) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
    try {
      // 【员工通道】/api/agent/* 不是给网页用的,而是给“正在被 ApiX 驱动的外部 Agent 进程”用的:
      // 它们凭启动时拿到的令牌表明身份,再通过信箱收发消息。这一小段先处理完就 return,
      // 不会落到下面的通用路由里。
      if (pathname.startsWith('/api/agent/')) {
        // authenticateAgent 校验 Authorization 头里的 Bearer 令牌,失败会抛错(最终由下面的 catch 转成 400 响应)。
        // 返回的 actor 带有 project_id / task_id,后续所有读写都被限制在这个身份的范围之内。
        // 注意团队查询和收消息走 GET(只读),其余操作必须是 POST + application/json,否则直接抛错。
        let actor = authenticateAgent(request.headers.authorization);
        if (pathname === '/api/agent/team' && request.method === 'GET') { send(200, agentTeam(actor.project_id,actor.task_id)); return; }
        if (pathname === '/api/agent/messages' && request.method === 'GET') { send(200, receiveAgentMessages(actor)); return; }
        if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Unsupported request');
        // 请求体是分块流式到达的,这里边收边拼;累计超过约 30000 字符就抛错,防止超大请求拖垮服务。
        // 拼完再 JSON.parse 成 input 对象;空 body 用 '{}' 兜底,免得 JSON.parse('') 报出看不懂的语法错误。
        request.setEncoding('utf8');
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 30000) throw new Error('请求过大'); }
        // 收 body 期间已经 await 过,令牌或其授权状态可能在这段空档里变化,所以动手前再校验一次。
        // 这是“检查—使用”之间要重新确认的常见写法(TOCTOU 防护)。
        const input = JSON.parse(body || '{}');
        actor = authenticateAgent(request.headers.authorization);
        if (pathname === '/api/agent/messages') {
          // 先把投递结果返回给调用方,再“发后即忘”地启动进度监督:
          // void 表示明知是异步但刻意不等待,.catch 兜住异常只写日志 —— 监督失败不能影响已成功的投递。
          // 紧随其后的分支处理 ack/complete/nack 三种回执,消息 ID 用正则从路径里捕获出来。
          const message = sendAgentMessage(actor,input);
          send(200,message);
          void superviseWorkerMessage(message.id).catch(error => process.stderr.write(`ApiX guidance: ${error.message}\n`));
          return;
        }
        const match = /^\/api\/agent\/messages\/([^/]+)\/(ack|complete|nack)$/.exec(pathname);
        if (match) {
          send(200,handleAgentMessage(actor,match[1],match[2],input)); return;
        }
        throw new Error('Unknown Agent operation');
      }
      // ===== 只读(GET)路由区 =====
      // 从这里到后面的 405 判断之前,全是 GET 查询接口,套路完全一致:
      // 匹配路径 → 用 pathname.split("/")[下标] 取出路径里的 ID → send(200, 函数结果) 并 return。
      // snapshot 是整页的总览数据,前端定时轮询它。浏览器把上次拿到的 ETag 通过 If-None-Match 头带上来,
      // 数据没变化时服务端只回一个空的 304(Not Modified),省掉整份 JSON 的重复传输。
      if (pathname === "/api/snapshot" && request.method === "GET") {
        const value=snapshot(request.headers['if-none-match']);
        if(value.notModified){response.writeHead(304,{'ETag':value.etag,'Cache-Control':'no-cache'});response.end();}
        else {response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache','ETag':value.etag});response.end(JSON.stringify(value.data));}
        return;
      }
      // 下面几条是助手工作台的读取接口:会话列表、单个会话、历史事件、输出片段(支持 offset 分页)、
      // 运行日志、交付物以及交付物里的文件、项目诊断。URL 里的查询参数统一用 new URL(...).searchParams 取。
      if (pathname === "/api/manager/settings" && request.method === "GET") { send(200, managerSettings()); return; }
      if(pathname==='/api/chat-history'&&request.method==='GET'){const q=new URL(request.url,'http://localhost').searchParams;send(200,chatHistory(q.get('projectId')??'',q.get('view')??'active'));return;}
      if(pathname==='/api/project-folders' && request.method==='GET'){send(200,browseFolders(new URL(request.url,'http://localhost').searchParams.get('path')));return;}
      if(/^\/api\/projects\/[^/]+\/mcp$/.test(pathname)&&request.method==='GET'){send(200,mcpServers(pathname.split('/')[3]));return;}
      if(/^\/api\/assistant\/sessions\/[^/]+\/events$/.test(pathname)&&request.method==='GET'){send(200,assistantEvents(pathname.split('/')[4],new URL(request.url,'http://localhost').searchParams.get('before')??undefined));return;}
      if(/^\/api\/assistant\/sessions\/[^/]+\/outputs\/[^/]+$/.test(pathname)&&request.method==='GET'){const q=new URL(request.url,'http://localhost').searchParams;send(200,assistantOutput(pathname.split('/')[4],{id:pathname.split('/')[6],offset:q.has('offset')?Number(q.get('offset')):0,limit:6000}));return;}
      if(/^\/api\/assistant\/sessions\/[^/]+\/logs\/[^/]+$/.test(pathname)&&request.method==='GET'){const q=new URL(request.url,'http://localhost').searchParams;send(200,assistantLogOutput(pathname.split('/')[4],{operationId:pathname.split('/')[6],channel:q.get('channel')??'stdout',mode:q.get('mode')??'head',offset:Number(q.get('offset')??0),limit:6000}));return;}
      if(/^\/api\/assistant\/sessions\/[^/]+\/deliveries\/[^/]+$/.test(pathname)&&request.method==='GET'){send(200,assistantDelivery(pathname.split('/')[4],pathname.split('/')[6]));return;}
      if(/^\/api\/assistant\/sessions\/[^/]+\/deliveries\/[^/]+\/files$/.test(pathname)&&request.method==='GET'){const q=new URL(request.url,'http://localhost').searchParams;send(200,assistantDeliveryFile(pathname.split('/')[4],pathname.split('/')[6],{version:Number(q.get('version')),path:q.get('path'),side:q.get('side'),offset:Number(q.get('offset')??0)}));return;}
      if(/^\/api\/conversation-models\/(assistant|coordination)\/[^/]+$/.test(pathname)&&request.method==='GET'){send(200,conversationModel(pathname.split('/')[3],pathname.split('/')[4]));return;}
      if(/^\/api\/assistant\/sessions\/[^/]+\/project-diagnosis$/.test(pathname)&&request.method==='GET'){send(200,assistantProjectDiagnosis(pathname.split('/')[4]));return;}
      if(pathname==='/api/assistant/sessions'&&request.method==='GET'){send(200,assistantSessions(new URL(request.url,'http://localhost').searchParams.get('projectId')??''));return;}
      if(/^\/api\/assistant\/sessions\/[^/]+$/.test(pathname)&&request.method==='GET'){send(200,assistantSession(pathname.split('/')[4]));return;}
      if(pathname==='/api/readiness' && request.method==='GET'){send(200,await readiness(new URL(request.url,'http://localhost').searchParams.get('projectId')??''));return;}
      if (/^\/api\/projects\/[^/]+\/workflow$/.test(pathname) && request.method === 'GET') {send(200,workflowSettings(pathname.split('/')[3]));return;}
      if (/^\/api\/projects\/[^/]+\/autonomy$/.test(pathname) && request.method === 'GET') {send(200,autonomySettings(pathname.split('/')[3]));return;}
      if (pathname === '/api/manager/providers' && request.method === 'GET') { send(200, {providers: BUILTIN_PROVIDERS}); return; }
      if (pathname === "/api/permissions" && request.method === "GET") { const q = new URL(request.url, 'http://localhost').searchParams; send(200, permissionPolicy(q.get('projectId'), q.get('subject') ?? 'apix')); return; }
      // 再往下是“看板上读数据”的接口:权限策略、协作记忆检索、协作会话列表与详情、时间线、
      // 记忆搜索、信箱列表、待收消息、消息线程与单条消息详情。它们都只读,不会改状态。
      if (pathname === "/api/coordination/memory" && request.method === "GET") { const q = new URL(request.url, 'http://localhost').searchParams; send(200, searchCoordinationMemory(q.get('projectId'), q.get('q') ?? '')); return; }
      if (pathname === "/api/coordination/sessions" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, listCoordinationSessions(query.get("projectId"),query.get('summary')==='1')); return; }
      if (/^\/api\/coordination\/sessions\/[^/]+$/.test(pathname) && request.method === "GET") { send(200, coordinationSessionDetails(pathname.split("/")[4])); return; }
      if (/^\/api\/coordination\/sessions\/[^/]+\/timeline$/.test(pathname) && request.method === "GET") { const q = new URL(request.url, 'http://localhost').searchParams; send(200, coordinationTimeline(pathname.split("/")[4], q.has('at') ? Number(q.get('at')) : undefined)); return; }
      if (pathname === "/api/memories/search" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, searchMemories(query.get("projectId"), query.get("q"))); return; }
      if (pathname === "/api/mailboxes" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, listMailboxes(query.get("projectId"))); return; }
      if (pathname === "/api/messages" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, receiveMessages({ projectId: query.get("projectId"), agentId: query.get("agentId"), limit: query.get("limit") })); return; }
      if (pathname === "/api/messages/thread" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, messageThread(query.get("projectId"), query.get("correlationId"), query.get("agentId"))); return; }
      if (/^\/api\/messages\/[^/]+$/.test(pathname) && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, messageDetails(pathname.split("/")[3], query.get("agentId"))); return; }
      // 【SSE 事件流】Server-Sent Events:服务器不关闭连接,持续把新事件推给浏览器,比前端反复轮询省资源。
      // text/event-stream 是它的固定内容类型;X-Accel-Buffering: no 告诉 Nginx 之类的代理别攒缓冲、立刻转发。
      // lastId 取自 Last-Event-ID 头或 after 参数,请求该游标之后的事件;客户端仍需处理重连和去重。
      // 每条事件的写法是 `id: ...\nevent: ...\ndata: ...\n\n`,结尾空行是 SSE 协议要求的消息分隔符。
      if (pathname === "/api/events/stream" && request.method === "GET") {
        const query = new URL(request.url, "http://localhost").searchParams;
        const projectId = query.get("projectId");
        const agentId = query.get("agentId");
        let lastId = Number(request.headers["last-event-id"] ?? query.get("after") ?? 0) || 0;
        const initial = messageEventsSince(projectId, agentId, lastId);
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        for (const event of initial) {
          response.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
          lastId = event.id;
        }
        const writeEvents = () => {
          try {
            const events = messageEventsSince(projectId, agentId, lastId);
            for (const event of events) {
              response.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
              lastId = event.id;
            }
          } catch (error) {
            response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            clearInterval(timer);
          }
        };
        // 每 500 毫秒查一次有没有新事件,有就逐条写出并推进 lastId;另设 15 秒心跳,让空闲连接不被
        // 浏览器或代理当成死连接掐掉。浏览器关页面时触发 close,必须清掉这两个定时器,否则它们会一直
        // 持有这个已失效的 response 对象。
        const timer = setInterval(writeEvents, 500);
        const heartbeat = setInterval(() => response.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`), 15000);
        request.on("close", () => { clearInterval(timer); clearInterval(heartbeat); });
        writeEvents();
        return;
      }
      if (/^\/api\/tasks\/[^/]+\/details$/.test(pathname) && request.method === "GET") { send(200, taskDetails(pathname.split("/")[3])); return; }
      if (/^\/api\/tasks\/[^/]+\/delivery$/.test(pathname) && request.method === 'GET') { send(200,await inspectTaskDelivery(pathname.split('/')[3]));return; }
      if (/^\/api\/projects\/[^/]+\/execution$/.test(pathname) && request.method === 'GET') {send(200,executionSettings(pathname.split('/')[3]));return;}
      if (/^\/api\/employees\/[^/]+\/details$/.test(pathname) && request.method === 'GET') { send(200,employeeDetails(pathname.split('/')[3])); return; }
      if (/^\/api\/employees\/[^/]+\/capabilities$/.test(pathname) && request.method === 'GET') { send(200,employeeCapability(pathname.split('/')[3])); return; }
      if (/^\/api\/projects\/[^/]+\/scheduling$/.test(pathname) && request.method === 'GET') { send(200,schedulingView(pathname.split('/')[3]));return; }
      if (/^\/api\/packs\/[^/]+$/.test(pathname) && request.method === "GET") { send(200, workflowPack(pathname.split("/")[3])); return; }
      // GET 区到此结束。下面开始都是“写操作”接口:必须是 POST,且 Content-Type 为 application/json,
      // 否则回 405(方法不允许)。`?.` 是可选链:请求头缺失时整表达式得到 undefined 而不会抛错;
      // split(';')[0] 是因为客户端可能写成 `application/json; charset=utf-8`。
      // 一个容易踩到的细节: GET 请求打到未注册路径会先在这里被拦成 405,而非走到链尾得到 404。
      if (request.method !== "POST" || request.headers["content-type"]?.split(";")[0] !== "application/json") { send(405, { error: "Unsupported request" }); return; }
      // 读取写操作的请求体,做法与员工通道相同:分块累积、超过约 30000 字符即拒绝、再解析成 input 对象。
      let raw = "";
      request.setEncoding('utf8');
      for await (const chunk of request) { raw += chunk; if (raw.length > 30000) throw new Error("请求过大"); }
      const input = JSON.parse(raw || "{}");
      if (/^\/api\/coordination\/sessions\/[^/]+\/messages\/stream$/.test(pathname)) {
        // 【流式对话】协作会话里的提问走 SSE 边生成边推送:start 表示开始,delta 是模型新吐出的一小段文字,
        // tool 表示调用了某个工具,complete 带最终结果,error 带失败原因 —— 这样用户不用干等整段回答。
        // response.destroyed 用来判断响应是否已销毁,避免在已断开的响应上继续发送。
        response.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store',Connection:'keep-alive','X-Accel-Buffering':'no' });
        const emit=(type,value)=>{if(!response.destroyed)response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);};
        emit('start',{sessionId:pathname.split('/')[4]});
        try { const result=await discussCoordinationSession(pathname.split('/')[4],input,delta=>emit('delta',{text:delta}),tool=>emit('tool',tool)); emit('complete',result); }
        catch(error) { emit('error',{error:error.message}); }
        response.end(); return;
      }
      // 【旧接口开关】下面这些老入口(直接建任务、Director 计划/消息、协作计划、评审会议等)默认关闭:
      // 除非环境变量 APIX_LEGACY_API=1,否则一律回 409,让用户改用 ApiX 目标工作台完成澄清与派发。
      // 409 表示“当前状态不允许这个操作”,与参数错误的 400、路径不存在的 404 刻意区分开。
      if (process.env.APIX_LEGACY_API !== '1' && (['/api/tasks','/api/director/plans','/api/director/messages','/api/collaboration/plans','/api/meetings','/api/manager-reviews'].includes(pathname) || /^\/api\/tasks\/[^/]+\/(resume|revise)$/.test(pathname) || pathname.startsWith('/api/director/'))) { send(409, { error: '请在 ApiX 目标工作台澄清并确认需求后安排任务' }); return; }
      // 【写操作路由表】下面是一长串 if / else if:按路径挑出对应的控制面函数执行,把返回值放进 result,
      // 走到链尾再统一 send(200, result)。按顺序匹配路径,只执行首个命中的分支。
      // 取 ID 的例子:"/api/projects/p-1/profile".split("/") 得到 ["", "api", "projects", "p-1", "profile"],
      // 下标 3 就是项目 ID、下标 4 是资源名;多一段的接口就往后取。中间那些注释只是主题分组,不影响执行。
      let result;
      if(/^\/api\/conversation-models\/(assistant|coordination)\/[^/]+$/.test(pathname))result=saveConversationModel(pathname.split('/')[3],pathname.split('/')[4],input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/npm-proposal$/.test(pathname))result=assistantNpmProposal(pathname.split('/')[4],input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/npm-approval$/.test(pathname))result=assistantApproveNpm(pathname.split('/')[4],input);
      else if(pathname==='/api/assistant/sessions')result=createAssistantSession(input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/messages$/.test(pathname))result=assistantMessage(pathname.split('/')[4],input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/tasks$/.test(pathname))result=assistantStartTask(pathname.split('/')[4],input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/delivery-review$/.test(pathname))result=assistantReviewDelivery(pathname.split('/')[4],input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/reply$/.test(pathname))result=await assistantReply(pathname.split('/')[4],input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/stop$/.test(pathname))result=assistantStop(pathname.split('/')[4]);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/resume$/.test(pathname))result=assistantResume(pathname.split('/')[4],input);
      else if(/^\/api\/assistant\/sessions\/[^/]+\/memory$/.test(pathname))result=assistantEditMemory(pathname.split('/')[4],input);
      // 运行时相关:扫描本机可驱动的执行器、登记自定义适配器、查看某员工的运行时信息、项目的 MCP 服务与工具发现。
      // 带 await 的这几条真的要启动进程或连接外部服务,耗时比普通常规读写长得多。
      else if (pathname === "/api/runtimes/scan") result = await scanRuntimes();
      else if (pathname === '/api/adapters') result = registerRuntimeAdapter(input);
      else if(/^\/api\/employees\/[^/]+\/runtime-info$/.test(pathname))result=await inspectEmployeeRuntime(pathname.split('/')[3]);
      else if(/^\/api\/projects\/[^/]+\/mcp$/.test(pathname))result=await saveMcpServer(pathname.split('/')[3],input);
      else if(/^\/api\/projects\/[^/]+\/mcp\/discover$/.test(pathname))result=await discoverMcpTools(pathname.split('/')[3]);
      // 配置类写接口:权限策略、管理模型设置、连接测试、项目工作流与自主模式开关(含自主会话恢复)。
      else if (pathname === '/api/permissions') result = changePermission(input.projectId, input);
      else if (pathname === '/api/manager/settings') result = saveManagerSettings(input);
      else if (pathname === '/api/manager/test') result = await testManagerConnection(input);
      else if (/^\/api\/projects\/[^/]+\/workflow$/.test(pathname)) result=saveWorkflow(pathname.split('/')[3],input);
      else if (/^\/api\/projects\/[^/]+\/autonomy$/.test(pathname)) result=saveAutonomySettings(pathname.split('/')[3],input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/autonomy\/resume$/.test(pathname)) result=resumeAutonomySession(pathname.split('/')[4],input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/stop$/.test(pathname)) result=stopCoordinationSession(pathname.split('/')[4],input);
      // 排班与用量:额度账号登记与恢复、员工能力、调度策略、成本结算。
      else if (pathname === '/api/scheduling/accounts') result=schedulingAccount(input);
      else if (pathname === '/api/scheduling/accounts/resume') result=resumeSchedulingAccount(input);
      else if (/^\/api\/employees\/[^/]+\/capabilities$/.test(pathname)) result=saveEmployeeCapability(pathname.split('/')[3],input);
      else if (/^\/api\/projects\/[^/]+\/scheduling$/.test(pathname)) result=saveSchedulingPolicy(pathname.split('/')[3],input);
      else if (/^\/api\/projects\/[^/]+\/scheduling\/settle$/.test(pathname)) result=settleSchedulingCost(pathname.split('/')[3],input);
      else if (pathname === '/api/manager/models') result = await readLocalModels(input);
      // 【协作会话主线】ApiX 目标工作台的核心流程:建会话 → 回答澄清 → 确认需求 → 派发任务,
      // 期间可以改交互模式、编辑计划、开规划会议并应用结论、追加指导。
      // confirm / dispatch / planning-meeting 都带 await,因为它们要调用模型或拉起执行。
      else if (pathname === "/api/coordination/sessions") result = createCoordinationSession(input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/messages$/.test(pathname)) result = await discussCoordinationSession(pathname.split('/')[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/mode$/.test(pathname)) result = setCoordinationInteractionMode(pathname.split('/')[4],input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/plan$/.test(pathname)) result = editCoordinationPlan(pathname.split('/')[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/planning-meetings$/.test(pathname)) result=await runPlanningMeeting(pathname.split('/')[4],input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/planning-meetings\/apply$/.test(pathname)) result=applyPlanningMeeting(pathname.split('/')[4],input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/answers$/.test(pathname)) result = answerCoordinationSession(pathname.split("/")[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/confirm$/.test(pathname)) result = await confirmCoordinationSession(pathname.split("/")[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/dispatch$/.test(pathname)) result = dispatchCoordinationSession(pathname.split("/")[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/revise$/.test(pathname)) result = reviseCoordinationSession(pathname.split("/")[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/instructions$/.test(pathname)) result = instructCoordinationEmployee(pathname.split("/")[4], input);
      else if(/^\/api\/chat-history\/(assistant|coordination)\/[^/]+$/.test(pathname))result=changeChatHistory(pathname.split('/')[3],pathname.split('/')[4],input);
      // 基础数据增删改:项目、项目档案、员工(注册/改名/删除)、对话重命名。
      // 返回 `{ id }` 或 `{ updated: true }` 这类极简对象就够了 —— 前端只需知道成功没有以及新 ID。
      // 删除接口写成 POST .../delete 而不是 DELETE 方法,是因为客户端统一走“POST + JSON”这一条通道。
      else if (pathname === "/api/projects") result = { id: createProject(input) };
      else if (/^\/api\/projects\/[^/]+\/profile$/.test(pathname)) result = saveProjectProfile(pathname.split("/")[3], input);
      else if (/^\/api\/projects\/[^/]+$/.test(pathname)) { updateProject(pathname.split("/")[3], input); result = { updated: true }; }
      else if (pathname === "/api/employees") result = { id: registerEmployee(input) };
      else if (/^\/api\/employees\/[^/]+\/delete$/.test(pathname)) { deleteEmployee(pathname.split("/")[3]); result = { deleted: true }; }
      else if (/^\/api\/employees\/[^/]+$/.test(pathname)) { updateEmployee(pathname.split("/")[3], input); result = { updated: true }; }
      else if (pathname === "/api/conversations") result = { id: createConversation(input) };
      else if (/^\/api\/conversations\/[^/]+$/.test(pathname)) { renameConversation(pathname.split("/")[3], input); result = { updated: true }; }
      // 项目记忆的增删改(查询在上面的 GET 区 /api/memories/search)。
      else if (pathname === "/api/memories") result = { id: createMemory(input) };
      else if (/^\/api\/memories\/[^/]+\/delete$/.test(pathname)) { deleteMemory(pathname.split("/")[3], input); result = { deleted: true }; }
      else if (/^\/api\/memories\/[^/]+$/.test(pathname)) result = updateMemory(pathname.split("/")[3], input);
      // 老的任务/Director 流程写接口:默认已被上面的 409 开关拦住,仅在 APIX_LEGACY_API=1 时才可达。
      else if (pathname === "/api/tasks") result = createTask(input);
      else if (/^\/api\/tasks\/[^/]+\/resume$/.test(pathname)) result = resumeTask(pathname.split("/")[3], input);
      else if (pathname === "/api/director/plans") result = { id: createDirectorPlan(input) };
      else if (pathname === "/api/director/messages") result = await sendDirectorMessage(input);
      else if (/^\/api\/director\/proposals\/[^/]+\/approve$/.test(pathname)) result = approveDirectorProposal(pathname.split("/")[4], input);
      else if (/^\/api\/director\/proposals\/[^/]+$/.test(pathname)) result = saveDirectorProposal(pathname.split("/")[4], input);
      else if (/^\/api\/director\/plans\/[^/]+\/approve$/.test(pathname)) result = approveDirectorPlan(pathname.split("/")[4], input);
      else if (/^\/api\/director\/plans\/[^/]+\/cancel-pending$/.test(pathname)) result = cancelPendingDirectorPlan(pathname.split("/")[4]);
      else if (/^\/api\/tasks\/[^/]+\/revise$/.test(pathname)) result = revisePendingPlanTask(pathname.split("/")[3], input);
      // 组织与交付:部门、代码仓库、工作流包、协作计划、评审会议、经理评审、集成的准备与应用。
      else if (pathname === "/api/departments") result = { id: createDepartment(input) };
      else if (/^\/api\/departments\/[^/]+$/.test(pathname)) { updateDepartment(pathname.split("/")[3], input); result = { updated: true }; }
      else if (pathname === "/api/repositories") result = { id: addRepository(input) };
      else if (pathname === "/api/packs") result = saveWorkflowPack(input);
      else if (pathname === "/api/collaboration/plans") result = createCollaborativePlan(input);
      else if (pathname === "/api/meetings") result = { id: createReviewMeeting(input) };
      else if (pathname === "/api/manager-reviews") result = createManagerReview(input);
      else if (pathname === "/api/integrations") result = prepareIntegration(input);
      else if (/^\/api\/integrations\/[^/]+\/apply$/.test(pathname)) result = applyIntegration(pathname.split("/")[3]);
      // 【信箱与消息】员工注册信箱、发消息,以及 ack(已收到)/nack(处理失败退回)/complete(已完成)/
      // reject(拒绝)四种回执和附件挂载 —— 语义等同消息队列,幂等与重试都由控制面保证。
      else if (pathname === "/api/mailboxes") result = registerMailbox(input);
      else if (pathname === "/api/messages") result = sendMessage(input);
      else if (/^\/api\/messages\/[^/]+\/ack$/.test(pathname)) result = ackMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/nack$/.test(pathname)) result = nackMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/complete$/.test(pathname)) result = completeMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/reject$/.test(pathname)) result = rejectMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/attachments$/.test(pathname)) result = attachMessageArtifact(pathname.split("/")[3], input);
      else if (pathname === "/api/locks/acquire") result = acquireLock(input);
      // 资源租约锁(申请/列表/续租/释放),避免两个任务同时改同一份资源。
      // 链尾这几组是执行控制:审批回执、停止运行、任务验收、历史交付冻结、异常恢复、执行设置与运行时暂停。
      // 注意 result 在这里只是被赋值而尚未发出 —— 统一交给下一行的 send(200, result)。
      else if (pathname === "/api/locks") result = listLocks(input.projectId, input.includeReleased === true);
      else if (/^\/api\/locks\/[^/]+\/renew$/.test(pathname)) result = renewLock(pathname.split("/")[3], input);
      else if (/^\/api\/locks\/[^/]+\/release$/.test(pathname)) result = releaseLock(pathname.split("/")[3], input);
      else if (/^\/api\/approvals\/[^/]+$/.test(pathname)) result = { runId: resolveApproval(pathname.split("/").at(-1), input.approved === true) };
      else if (/^\/api\/runs\/[^/]+\/stop$/.test(pathname)) { stopRun(pathname.split("/")[3]); result = { requested: true }; }
      else if (/^\/api\/tasks\/[^/]+\/review$/.test(pathname)) { acceptTask(pathname.split("/")[3], input.accepted === true,input.fingerprint); result = { reviewed: true }; }
      else if (/^\/api\/tasks\/[^/]+\/delivery$/.test(pathname)) result=freezeHistoricalDelivery(pathname.split('/')[3],input);
      else if (/^\/api\/tasks\/[^/]+\/recovery$/.test(pathname)) result=await recoverTask(pathname.split('/')[3],input);
      else if (/^\/api\/projects\/[^/]+\/execution$/.test(pathname)) result=saveExecutionSettings(pathname.split('/')[3],input);
      else if (/^\/api\/projects\/[^/]+\/execution\/runtime$/.test(pathname)) result=changeRuntimePause(pathname.split('/')[3],input);
      // 所有 POST 分支都没命中,说明是未注册的路径,回 404。else 分支不能省:否则可能以 200 发送空响应。
      else { send(404, { error: "Not found" }); return; }
      send(200, result);
    // 【统一错误出口】接口处理中任何抛错(参数不合法、权限不足、JSON 解析失败……)都在这里收口,
    // 一律回 400 + error 文本。前端只需读 error 字段就能展示原因,而且响应始终是完整合法的 JSON。
    } catch (error) { send(400, { error: error.message }); }
    return;
  }
  // ===== 静态文件区 (不是 /api 的请求都走到这里) =====
  // 根路径 / 映射为 index.html; 其余去掉开头的“/”,得到相对文件名。
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  // staticFilePath 维护允许公开访问的“白名单”: 只有映射成功的文件才会被读出来。
  // 白名单是安全边界 —— 若改成“整个目录随便读”,源码、数据库文件甚至 .env 里的密钥都可能被下载。
  const publicPath = staticFilePath(root, relativePath);
  if (!publicPath) { response.writeHead(404); response.end('Not found'); return; }
  // normalize 把 a/../b 这类片段折叠掉; 紧接着检查结果是否仍留在 root 之内,
  // 以此阻止 ../../ 目录穿越; 同时只允许 GET/HEAD,不接受写类方法。
  const filePath = normalize(publicPath);
  if (!filePath.startsWith(`${root}${sep}`) || !["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    // stat 先确认目标存在且确实是普通文件(目录不算),再读字节; 读不了就当 404 处理。
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
// 【只绑本机】监听 127.0.0.1 而非 0.0.0.0: 只有本机能访问控制台,局域网里的其他人连不上。
// 这与它的能力相配: 它持有模型密钥、能驱动进程执行任务,本来就不适合暴露到公网。
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`ApiX Web: http://127.0.0.1:${port}\n`);
});
// 【优雅退出】收到 Ctrl+C(SIGINT)或停止信号(SIGTERM)时: 先通知外部 MCP 服务断开连接,再退出进程。
// shuttingDown 防止两个信号几乎同时到达时执行两遍; 4 秒兜底定时器保证 MCP 关闭卡住时进程也能退出;
// .unref() 让这个定时器不计入“阻止进程退出的任务”,否则它自己会把进程多留 4 秒。
let shuttingDown=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{if(shuttingDown)return;shuttingDown=true;setTimeout(()=>process.exit(0),4000).unref();void closeMcpConnections().finally(()=>process.exit(0));});
