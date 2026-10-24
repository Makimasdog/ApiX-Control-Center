import {fetch} from './local-fetch.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}
async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* server is starting */ }
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error("Timed out waiting for ApiX server");
}
async function post(port, path, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
async function get(port, path, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

test("message protocol persists mailbox, correlation, idempotency, retry, timeout, locks, and Director interception", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-message-"));
  const port = await freePort();
  const server = spawn(process.execPath, [join(root, "server.mjs")], { cwd: root, env: { ...process.env, APIX_LEGACY_API: "1", APIX_CLAUDE_ENTRY: join(root, "test", "fake-claude.mjs"), PORT: String(port), APIX_DATA_DIR: dataDir, APIX_PI_ENTRY: join(root, "test", "fake-pi.mjs") }, stdio: "ignore" });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).ok);
    const projectId = (await post(port, "/api/projects", { name: "Protocol test", path: root })).id;
    const alice = (await post(port, "/api/employees", { name: "Alice", runtime: "pi", role: "Developer" })).id;
    const bob = (await post(port, "/api/employees", { name: "Bob", runtime: "pi", role: "Reviewer" })).id;
    const messages = { projectId, from: "apix-director", to: alice, type: "request", idempotencyKey: "plan-step-1", payload: { instruction: "review" } };
    const first = await post(port, "/api/messages", messages);
    assert.equal(first.status, "queued");
    assert.equal((await post(port, "/api/messages", messages)).id, first.id);
    assert.equal((await get(port, `/api/messages?projectId=${projectId}&agentId=${alice}`))[0].id, first.id);
    assert.equal((await get(port, `/api/messages/${first.id}?agentId=${bob}`, 400)).error, "只能读取自己收发的消息");
    await post(port, `/api/messages/${first.id}/ack`, { agentId: alice });
    const retry = await post(port, `/api/messages/${first.id}/nack`, { agentId: alice, error: "temporary" });
    assert.equal(retry.status, "queued");
    assert.equal(retry.retry_count, 1);
    const response = await post(port, "/api/messages", { projectId, from: alice, to: "apix-director", type: "response", replyTo: first.id, idempotencyKey: "reply-1", payload: { answer: "done" } });
    assert.equal(response.correlation_id, first.correlation_id);
    assert.equal((await get(port, `/api/messages/thread?projectId=${projectId}&correlationId=${first.correlation_id}&agentId=apix-director`)).length, 2);
    assert.equal((await post(port, "/api/messages", { projectId, from: alice, to: "apix-director", type: "request", idempotencyKey: "danger", payload: { action: "start_agent" } })).status, "rejected");
    const batchOne = await post(port, '/api/messages', {projectId,from:'apix-director',to:bob,idempotencyKey:'batch-one',payload:'one'});
    const batchTwo = await post(port, '/api/messages', {projectId,from:'apix-director',to:bob,idempotencyKey:'batch-two',payload:'two'});
    const inbox = `/api/messages?projectId=${projectId}&agentId=${bob}&limit=1`;
    assert.equal((await get(port,inbox))[0].id,batchOne.id);
    assert.equal((await get(port,inbox))[0].id,batchOne.id, 'unacknowledged delivery must be retried');
    assert.equal((await get(port,`/api/messages/${batchTwo.id}?agentId=${bob}`)).message.status,'queued', 'unreturned messages must stay queued');
    await post(port,`/api/messages/${batchOne.id}/complete`,{agentId:bob});
    assert.equal((await get(port,inbox))[0].id,batchTwo.id);
    await post(port,`/api/messages/${batchTwo.id}/complete`,{agentId:bob});
    const task = await post(port, "/api/tasks", { projectId, employeeId: alice, prompt: "inspect messaging" });
    await post(port, `/api/approvals/${task.approvalId}`, { approved: true });
    await waitFor(async () => (await get(port, "/api/snapshot")).tasks.find((item) => item.id === task.taskId)?.status === "completed");
    const taskMessages = (await get(port, "/api/snapshot")).messages.filter((item) => item.task_id === task.taskId);
    const dispatch = taskMessages.find((item) => item.type === "request" && item.from_agent === "apix-director");
    const deliverable = taskMessages.find((item) => item.reply_to === dispatch?.id);
    assert.equal(dispatch.status, "completed");
    assert.equal(deliverable.correlation_id, dispatch.correlation_id);
    assert((await get(port, `/api/messages/${deliverable.id}?agentId=apix-director`)).artifacts.length > 0);
    const short = await post(port, "/api/messages", { projectId, from: "apix-director", to: bob, idempotencyKey: "short", payload: "deadline", timeoutMs: 1000 });
    const locked = await post(port, "/api/locks/acquire", { projectId, agentId: alice, resourceType: "file", resourceKey: "src/index.js", ttlMs: 1000 });
    assert.equal((await post(port, "/api/locks/acquire", { projectId, agentId: bob, resourceType: "file", resourceKey: "src/index.js" }, 400)).error, "资源已被其他 Agent 锁定");
    assert.equal((await post(port, `/api/locks/${locked.id}/release`, { agentId: bob }, 400)).error, "只有锁持有者或 Director 可以释放锁");
    await post(port, `/api/locks/${locked.id}/release`, { agentId: "apix-director" });
    await new Promise((done) => setTimeout(done, 1050));
    await get(port, `/api/messages?projectId=${projectId}&agentId=${bob}`);
    assert.equal((await get(port, `/api/messages/${short.id}?agentId=${bob}`)).message.status, "expired");
    const events = (await get(port, `/api/snapshot`)).messageEvents.filter((item) => item.project_id === projectId);
    assert(events.some((item) => item.event_type === "message.expired"));
    assert(events.some((item) => item.event_type === "director.intercepted"));
    assert(events.some((item) => item.event_type === "agent.status" && item.payload.status === "completed"));
    const stream = await fetch(`http://127.0.0.1:${port}/api/events/stream?projectId=${projectId}&agentId=apix-director&after=0`);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /event: message.created/);
    await reader.cancel();
  } finally {
    if (server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    await rm(dataDir, { recursive: true, force: true });
  }
});
