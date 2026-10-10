import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot, scanRuntimes, taskDetails, registerEmployee, updateEmployee, deleteEmployee, createProject, updateProject, createConversation, renameConversation, createTask, resumeTask, saveProjectProfile, createMemory, updateMemory, deleteMemory, searchMemories, createDirectorPlan, sendDirectorMessage, saveDirectorProposal, approveDirectorProposal, approveDirectorPlan, cancelPendingDirectorPlan, revisePendingPlanTask, resolveApproval, stopRun, acceptTask, createDepartment, updateDepartment, addRepository, saveWorkflowPack, workflowPack, createCollaborativePlan, createReviewMeeting, createManagerReview, prepareIntegration, applyIntegration, registerMailbox, listMailboxes, sendMessage, receiveMessages, ackMessage, nackMessage, completeMessage, rejectMessage, messageDetails, messageThread, messageEventsSince, acquireLock, renewLock, releaseLock, listLocks, attachMessageArtifact } from "./control-plane.mjs";
import { listCoordinationSessions, coordinationSessionDetails, createCoordinationSession, answerCoordinationSession, confirmCoordinationSession, dispatchCoordinationSession, reviseCoordinationSession, coordinationTimeline } from "./control-plane.mjs";
import { discussCoordinationSession, editCoordinationPlan, changePermission, permissionPolicy, managerSettings, saveManagerSettings, searchCoordinationMemory } from "./control-plane.mjs";
import { registerRuntimeAdapter, authenticateAgent, agentTeam } from './control-plane.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (pathname.startsWith("/api/")) {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')) { response.writeHead(403); response.end('Forbidden host'); return; }
    const origin = request.headers.origin;
    const expectedOrigin = `http://127.0.0.1:${port}`;
    if (origin && origin !== expectedOrigin) { response.writeHead(403); response.end("Forbidden origin"); return; }
    const send = (status, value) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
    try {
      if (pathname.startsWith('/api/agent/')) {
        const actor = authenticateAgent(request.headers.authorization);
        if (pathname === '/api/agent/team' && request.method === 'GET') { send(200, agentTeam(actor.project_id)); return; }
        if (pathname === '/api/agent/messages' && request.method === 'GET') { send(200, receiveMessages({projectId:actor.project_id,agentId:actor.agent_id})); return; }
        if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Unsupported request');
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 30000) throw new Error('请求过大'); }
        const input = JSON.parse(body || '{}');
        if (pathname === '/api/agent/messages') { send(200, sendMessage({...input,projectId:actor.project_id,from:actor.agent_id,taskId:actor.task_id})); return; }
        const match = /^\/api\/agent\/messages\/([^/]+)\/(ack|complete|nack)$/.exec(pathname);
        if (match) {
          if (messageDetails(match[1],actor.agent_id).message.project_id !== actor.project_id) throw new Error('消息不属于当前项目');
          send(200, ({ack:ackMessage,complete:completeMessage,nack:nackMessage})[match[2]](match[1],{...input,agentId:actor.agent_id})); return;
        }
        throw new Error('Unknown Agent operation');
      }
      if (pathname === "/api/snapshot" && request.method === "GET") { send(200, snapshot()); return; }
      if (pathname === "/api/manager/settings" && request.method === "GET") { send(200, managerSettings()); return; }
      if (pathname === "/api/permissions" && request.method === "GET") { const q = new URL(request.url, 'http://localhost').searchParams; send(200, permissionPolicy(q.get('projectId'), q.get('subject') ?? 'apix')); return; }
      if (pathname === "/api/coordination/memory" && request.method === "GET") { const q = new URL(request.url, 'http://localhost').searchParams; send(200, searchCoordinationMemory(q.get('projectId'), q.get('q') ?? '')); return; }
      if (pathname === "/api/coordination/sessions" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, listCoordinationSessions(query.get("projectId"))); return; }
      if (/^\/api\/coordination\/sessions\/[^/]+$/.test(pathname) && request.method === "GET") { send(200, coordinationSessionDetails(pathname.split("/")[4])); return; }
      if (/^\/api\/coordination\/sessions\/[^/]+\/timeline$/.test(pathname) && request.method === "GET") { const q = new URL(request.url, 'http://localhost').searchParams; send(200, coordinationTimeline(pathname.split("/")[4], q.has('at') ? Number(q.get('at')) : undefined)); return; }
      if (pathname === "/api/memories/search" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, searchMemories(query.get("projectId"), query.get("q"))); return; }
      if (pathname === "/api/mailboxes" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, listMailboxes(query.get("projectId"))); return; }
      if (pathname === "/api/messages" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, receiveMessages({ projectId: query.get("projectId"), agentId: query.get("agentId"), limit: query.get("limit") })); return; }
      if (pathname === "/api/messages/thread" && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, messageThread(query.get("projectId"), query.get("correlationId"), query.get("agentId"))); return; }
      if (/^\/api\/messages\/[^/]+$/.test(pathname) && request.method === "GET") { const query = new URL(request.url, "http://localhost").searchParams; send(200, messageDetails(pathname.split("/")[3], query.get("agentId"))); return; }
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
        const timer = setInterval(writeEvents, 500);
        const heartbeat = setInterval(() => response.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`), 15000);
        request.on("close", () => { clearInterval(timer); clearInterval(heartbeat); });
        writeEvents();
        return;
      }
      if (/^\/api\/tasks\/[^/]+\/details$/.test(pathname) && request.method === "GET") { send(200, taskDetails(pathname.split("/")[3])); return; }
      if (/^\/api\/packs\/[^/]+$/.test(pathname) && request.method === "GET") { send(200, workflowPack(pathname.split("/")[3])); return; }
      if (request.method !== "POST" || request.headers["content-type"]?.split(";")[0] !== "application/json") { send(405, { error: "Unsupported request" }); return; }
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (raw.length > 30000) throw new Error("请求过大"); }
      const input = JSON.parse(raw || "{}");
      if (process.env.APIX_LEGACY_API !== '1' && (['/api/tasks','/api/director/plans','/api/director/messages','/api/collaboration/plans','/api/meetings','/api/manager-reviews'].includes(pathname) || /^\/api\/tasks\/[^/]+\/(resume|revise)$/.test(pathname) || pathname.startsWith('/api/director/'))) { send(409, { error: '请在 ApiX 目标工作台澄清并确认需求后安排任务' }); return; }
      let result;
      if (pathname === "/api/runtimes/scan") result = await scanRuntimes();
      else if (pathname === '/api/adapters') result = registerRuntimeAdapter(input);
      else if (pathname === '/api/permissions') result = changePermission(input.projectId, input);
      else if (pathname === '/api/manager/settings') result = saveManagerSettings(input);
      else if (pathname === "/api/coordination/sessions") result = createCoordinationSession(input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/messages$/.test(pathname)) result = await discussCoordinationSession(pathname.split('/')[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/plan$/.test(pathname)) result = editCoordinationPlan(pathname.split('/')[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/answers$/.test(pathname)) result = answerCoordinationSession(pathname.split("/")[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/confirm$/.test(pathname)) result = await confirmCoordinationSession(pathname.split("/")[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/dispatch$/.test(pathname)) result = dispatchCoordinationSession(pathname.split("/")[4], input);
      else if (/^\/api\/coordination\/sessions\/[^/]+\/revise$/.test(pathname)) result = reviseCoordinationSession(pathname.split("/")[4], input);
      else if (pathname === "/api/projects") result = { id: createProject(input) };
      else if (/^\/api\/projects\/[^/]+\/profile$/.test(pathname)) result = saveProjectProfile(pathname.split("/")[3], input);
      else if (/^\/api\/projects\/[^/]+$/.test(pathname)) { updateProject(pathname.split("/")[3], input); result = { updated: true }; }
      else if (pathname === "/api/employees") result = { id: registerEmployee(input) };
      else if (/^\/api\/employees\/[^/]+\/delete$/.test(pathname)) { deleteEmployee(pathname.split("/")[3]); result = { deleted: true }; }
      else if (/^\/api\/employees\/[^/]+$/.test(pathname)) { updateEmployee(pathname.split("/")[3], input); result = { updated: true }; }
      else if (pathname === "/api/conversations") result = { id: createConversation(input) };
      else if (/^\/api\/conversations\/[^/]+$/.test(pathname)) { renameConversation(pathname.split("/")[3], input); result = { updated: true }; }
      else if (pathname === "/api/memories") result = { id: createMemory(input) };
      else if (/^\/api\/memories\/[^/]+\/delete$/.test(pathname)) { deleteMemory(pathname.split("/")[3], input); result = { deleted: true }; }
      else if (/^\/api\/memories\/[^/]+$/.test(pathname)) result = updateMemory(pathname.split("/")[3], input);
      else if (pathname === "/api/tasks") result = createTask(input);
      else if (/^\/api\/tasks\/[^/]+\/resume$/.test(pathname)) result = resumeTask(pathname.split("/")[3], input);
      else if (pathname === "/api/director/plans") result = { id: createDirectorPlan(input) };
      else if (pathname === "/api/director/messages") result = await sendDirectorMessage(input);
      else if (/^\/api\/director\/proposals\/[^/]+\/approve$/.test(pathname)) result = approveDirectorProposal(pathname.split("/")[4], input);
      else if (/^\/api\/director\/proposals\/[^/]+$/.test(pathname)) result = saveDirectorProposal(pathname.split("/")[4], input);
      else if (/^\/api\/director\/plans\/[^/]+\/approve$/.test(pathname)) result = approveDirectorPlan(pathname.split("/")[4], input);
      else if (/^\/api\/director\/plans\/[^/]+\/cancel-pending$/.test(pathname)) result = cancelPendingDirectorPlan(pathname.split("/")[4]);
      else if (/^\/api\/tasks\/[^/]+\/revise$/.test(pathname)) result = revisePendingPlanTask(pathname.split("/")[3], input);
      else if (pathname === "/api/departments") result = { id: createDepartment(input) };
      else if (/^\/api\/departments\/[^/]+$/.test(pathname)) { updateDepartment(pathname.split("/")[3], input); result = { updated: true }; }
      else if (pathname === "/api/repositories") result = { id: addRepository(input) };
      else if (pathname === "/api/packs") result = saveWorkflowPack(input);
      else if (pathname === "/api/collaboration/plans") result = createCollaborativePlan(input);
      else if (pathname === "/api/meetings") result = { id: createReviewMeeting(input) };
      else if (pathname === "/api/manager-reviews") result = createManagerReview(input);
      else if (pathname === "/api/integrations") result = prepareIntegration(input);
      else if (/^\/api\/integrations\/[^/]+\/apply$/.test(pathname)) result = applyIntegration(pathname.split("/")[3]);
      else if (pathname === "/api/mailboxes") result = registerMailbox(input);
      else if (pathname === "/api/messages") result = sendMessage(input);
      else if (/^\/api\/messages\/[^/]+\/ack$/.test(pathname)) result = ackMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/nack$/.test(pathname)) result = nackMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/complete$/.test(pathname)) result = completeMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/reject$/.test(pathname)) result = rejectMessage(pathname.split("/")[3], input);
      else if (/^\/api\/messages\/[^/]+\/attachments$/.test(pathname)) result = attachMessageArtifact(pathname.split("/")[3], input);
      else if (pathname === "/api/locks/acquire") result = acquireLock(input);
      else if (pathname === "/api/locks") result = listLocks(input.projectId, input.includeReleased === true);
      else if (/^\/api\/locks\/[^/]+\/renew$/.test(pathname)) result = renewLock(pathname.split("/")[3], input);
      else if (/^\/api\/locks\/[^/]+\/release$/.test(pathname)) result = releaseLock(pathname.split("/")[3], input);
      else if (/^\/api\/approvals\/[^/]+$/.test(pathname)) result = { runId: resolveApproval(pathname.split("/").at(-1), input.approved === true) };
      else if (/^\/api\/runs\/[^/]+\/stop$/.test(pathname)) { stopRun(pathname.split("/")[3]); result = { requested: true }; }
      else if (/^\/api\/tasks\/[^/]+\/review$/.test(pathname)) { acceptTask(pathname.split("/")[3], input.accepted === true); result = { reviewed: true }; }
      else { send(404, { error: "Not found" }); return; }
      send(200, result);
    } catch (error) { send(400, { error: error.message }); }
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const publicFiles = new Set(['index.html','agent-os.js','styles.css','phase4.css','director.css','coordinator.css']);
  if (!publicFiles.has(relativePath) && !/^dist\/web\/[a-zA-Z0-9_-]+\.js$/.test(relativePath)) { response.writeHead(404); response.end('Not found'); return; }
  const filePath = normalize(join(root, relativePath));
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
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`ApiX Web: http://127.0.0.1:${port}\n`);
});
