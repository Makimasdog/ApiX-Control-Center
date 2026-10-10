import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot, scanRuntimes, taskDetails, registerEmployee, updateEmployee, deleteEmployee, createProject, updateProject, createConversation, renameConversation, createTask, resumeTask, saveProjectProfile, createMemory, updateMemory, deleteMemory, searchMemories, createDirectorPlan, sendDirectorMessage, saveDirectorProposal, approveDirectorProposal, approveDirectorPlan, cancelPendingDirectorPlan, revisePendingPlanTask, resolveApproval, stopRun, acceptTask, createDepartment, updateDepartment, addRepository, saveWorkflowPack, workflowPack, createCollaborativePlan, createReviewMeeting, createManagerReview, prepareIntegration, applyIntegration, registerMailbox, listMailboxes, sendMessage, receiveMessages, ackMessage, nackMessage, completeMessage, rejectMessage, messageDetails, messageThread, messageEventsSince, acquireLock, renewLock, releaseLock, listLocks, attachMessageArtifact } from "./control-plane.mjs";

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
    const origin = request.headers.origin;
    const expectedOrigin = `http://127.0.0.1:${port}`;
    if (origin && origin !== expectedOrigin) { response.writeHead(403); response.end("Forbidden origin"); return; }
    const send = (status, value) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
    try {
      if (pathname === "/api/snapshot" && request.method === "GET") { send(200, snapshot()); return; }
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
      let result;
      if (pathname === "/api/runtimes/scan") result = await scanRuntimes();
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
