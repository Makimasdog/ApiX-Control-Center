import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const post = async (port, path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
};
const snapshot = async (port) => (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
async function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await predicate();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Timed out waiting for Agent state");
}
async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [join(root, "server.mjs")], { cwd: root, env: { ...process.env, PORT: String(port), APIX_DATA_DIR: dataDir, APIX_PI_ENTRY: join(root, "test", "fake-pi.mjs"), APIX_CODEX_ENTRY: join(root, "test", "fake-codex.mjs") }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  try { await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).ok; } catch { return false; } }); }
  catch (error) { throw new Error(`ApiX server did not start (exit ${child.exitCode}): ${stderr || error.message}`); }
  return child;
}

test("P0 task lifecycle, both adapters, stop, review, and restart history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-test-"));
  const port = 48000 + Math.floor(Math.random() * 1000);
  let server;
  try {
    server = await startServer(port, dataDir);
    const initial = await snapshot(port);
    assert(initial.runtimes.filter((item) => item.managed).every((item) => item.available));
    const { id: projectId } = await post(port, "/api/projects", { name: "Test project", path: root });
    const employees = {};
    for (const runtime of ["pi", "codex"]) {
      employees[runtime] = (await post(port, "/api/employees", { name: `${runtime} reviewer`, runtime, role: "Reviewer", department: "Engineering" })).id;
    }
    assert.equal((await snapshot(port)).employees.length, 2);
    for (const runtime of ["pi", "codex"]) {
      const { taskId, approvalId } = await post(port, "/api/tasks", { projectId, employeeId: employees[runtime], prompt: "inspect" });
      const before = await snapshot(port);
      assert.equal(before.tasks.find((item) => item.id === taskId).status, "awaiting_approval");
      assert.equal(before.tasks.find((item) => item.id === taskId).employee_name, `${runtime} reviewer`);
      assert.equal(before.runs.length, runtime === "pi" ? 0 : 1);
      const pathChange = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Test project", path: join(root, "test") }) });
      assert.equal(pathChange.status, 400);
      await post(port, `/api/approvals/${approvalId}`, { approved: true });
      await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === taskId)?.status === "completed");
      const done = await snapshot(port);
      assert.match(done.tasks.find((item) => item.id === taskId).result, /result: inspect/);
      assert(done.artifacts.some((item) => item.run_id === done.runs.find((run) => run.task_id === taskId).id));
      const details = (await (await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/details`)).json());
      assert(details.events.some((item) => item.kind === "run_exited"));
      if (runtime === "codex") assert.equal(details.events.find((item) => item.kind === "run_started").payload.gitRepoCheckSkipped, false);
      assert.equal(details.artifacts.length, 1);
      await post(port, `/api/tasks/${taskId}/review`, { accepted: true });
      assert.equal((await snapshot(port)).tasks.find((item) => item.id === taskId).status, "accepted");
    }
    const errorTask = await post(port, "/api/tasks", { projectId, employeeId: employees.pi, prompt: "provider-error" });
    await post(port, `/api/approvals/${errorTask.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === errorTask.taskId)?.status === "failed");
    const many = await post(port, "/api/tasks", { projectId, employeeId: employees.pi, prompt: "many-events" });
    await post(port, `/api/approvals/${many.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === many.taskId)?.status === "completed");
    const manyDetails = await (await fetch(`http://127.0.0.1:${port}/api/tasks/${many.taskId}/details`)).json();
    assert(manyDetails.events.length >= 350);
    assert.equal((await snapshot(port)).events.length, 300);
    const { taskId, approvalId } = await post(port, "/api/tasks", { projectId, employeeId: employees.pi, prompt: "hold" });
    const { runId } = await post(port, `/api/approvals/${approvalId}`, { approved: true });
    await post(port, `/api/runs/${runId}/stop`, {});
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === taskId)?.status === "cancelled");
    const pending = await post(port, "/api/tasks", { projectId, employeeId: employees.codex, prompt: "reject" });
    await post(port, `/api/approvals/${pending.approvalId}`, { approved: false });
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === pending.taskId).status, "rejected");
    const interrupted = await post(port, "/api/tasks", { projectId, employeeId: employees.pi, prompt: "hold" });
    const active = await post(port, `/api/approvals/${interrupted.approvalId}`, { approved: true });
    assert.equal((await snapshot(port)).runs.find((item) => item.id === active.runId).status, "running");
    server.kill(); await new Promise((done) => server.once("exit", done));
    server = await startServer(port, dataDir);
    const restored = await snapshot(port);
    assert.equal(restored.tasks.length, 7);
    assert.equal(restored.events.some((item) => item.kind === "stop_requested"), true);
    assert.equal(restored.approvals.filter((item) => item.status === "approved").length, 6);
    assert.equal(restored.tasks.find((item) => item.id === interrupted.taskId).status, "unknown");
    assert.equal(restored.runs.find((item) => item.id === active.runId).status_confidence, "unavailable");
    assert.equal(restored.employees.length, 2);
    await post(port, `/api/employees/${employees.pi}`, { name: "Pi reviewer", role: "Reviewer", department: "Engineering", enabled: false });
    const disabledTask = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, employeeId: employees.pi, prompt: "unavailable" }) });
    assert.equal(disabledTask.status, 400);
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    const absolute = resolve(dataDir);
    assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(absolute, { recursive: true, force: true });
  }
});

test("schema migration preserves a pending task from version 1", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-migrate-"));
  const port = 49000 + Math.floor(Math.random() * 1000);
  const projectId = "legacy-project";
  const taskId = "legacy-task";
  const approvalId = "legacy-approval";
  const old = new DatabaseSync(join(dataDir, "apix.sqlite"));
  old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations(version) VALUES (1);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), runtime TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), action TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);`);
  old.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run(projectId, "Legacy", root, "", new Date().toISOString());
  old.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)").run(taskId, projectId, "pi", "inspect", "awaiting_approval", "", new Date().toISOString(), new Date().toISOString());
  old.prepare("INSERT INTO approvals VALUES (?,?,?,?,?,?)").run(approvalId, taskId, "start-agent-in-project", "pending", new Date().toISOString(), null);
  old.close();
  let server;
  try {
    server = await startServer(port, dataDir);
    const migrated = await snapshot(port);
    assert.equal(migrated.tasks.find((item) => item.id === taskId).status, "awaiting_approval");
    assert.equal(migrated.approvals.find((item) => item.id === approvalId).target_path, root);
    assert.equal(migrated.employees.length, 0);
    assert.equal(migrated.conversations.length, 1);
    assert.equal(migrated.tasks.find((item) => item.id === taskId).conversation_id, migrated.conversations[0].id);
    await post(port, `/api/approvals/${approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === taskId)?.status === "completed");
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    const absolute = resolve(dataDir);
    assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(absolute, { recursive: true, force: true });
  }
});

test("Director creates a matched dependency plan and advances the DAG", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-plan-"));
  const port = 49500 + Math.floor(Math.random() * 300);
  let server;
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root });
    server = await startServer(port, dataDir);
    const { id: projectId } = await post(port, "/api/projects", { name: "Plan project", path: root });
    const developer = (await post(port, "/api/employees", { name: "Developer", runtime: "pi", role: "开发工程师", department: "研发" })).id;
    const reviewer = (await post(port, "/api/employees", { name: "Reviewer", runtime: "codex", role: "代码审查", department: "质量" })).id;
    const plan = await post(port, "/api/director/plans", { projectId, goal: "实现登录功能；代码审查" });
    const planned = await snapshot(port);
    assert.equal(planned.plans.find((item) => item.id === plan.id).task_count, 2);
    const planTasks = planned.tasks.filter((item) => item.plan_id === plan.id);
    assert.equal(planTasks.length, 2);
    const dependentId = planned.dependencies[0].task_id;
    assert.equal(planTasks.find((item) => item.id !== dependentId).employee_id, developer);
    assert.equal(planTasks.find((item) => item.id === dependentId).employee_id, reviewer);
    assert.equal(planned.dependencies.length, 1);
    const approvals = planned.approvals.filter((item) => planTasks.some((task) => task.id === item.task_id));
    const dependentApproval = approvals.find((item) => item.task_id === dependentId);
    const rootId = planTasks.find((item) => item.id !== dependentId).id;
    const rootApproval = approvals.find((item) => item.task_id === rootId);
    await post(port, `/api/approvals/${dependentApproval.id}`, { approved: true });
    let queued = await snapshot(port);
    assert.equal(queued.tasks.find((item) => item.id === dependentId).status, "queued");
    await post(port, `/api/approvals/${rootApproval.id}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.filter((item) => item.plan_id === plan.id).every((item) => item.status === "completed"));
    const finished = await snapshot(port);
    assert.equal(finished.workspaces.filter((item) => planTasks.some((task) => task.id === item.task_id)).length, 2);
    assert(finished.tasks.filter((item) => item.plan_id === plan.id).every((item) => item.workspace_path));
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    const absolute = resolve(dataDir);
    assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(absolute, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: root });
  }
});

test("Phase 3 parallel work, meeting review, integration approval, conflict, and restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-team-data-"));
  const repo = await mkdtemp(join(tmpdir(), "apix-os-team-repo-"));
  const repo2 = await mkdtemp(join(tmpdir(), "apix-os-team-second-"));
  const port = 49800 + Math.floor(Math.random() * 100);
  let server;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "ApiX test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "apix@example.test"], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "base a");
    await writeFile(join(repo, "b.txt"), "base b");
    execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
    execFileSync("git", ["init", "-q"], { cwd: repo2 });
    execFileSync("git", ["config", "user.name", "ApiX test"], { cwd: repo2 });
    execFileSync("git", ["config", "user.email", "apix@example.test"], { cwd: repo2 });
    await writeFile(join(repo2, "a.txt"), "secondary base");
    execFileSync("git", ["add", "a.txt"], { cwd: repo2 });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo2 });
    server = await startServer(port, dataDir);
    const projectId = (await post(port, "/api/projects", { name: "Team", path: repo })).id;
    const alpha = (await post(port, "/api/employees", { name: "Alpha", runtime: "pi", role: "Developer", department: "Engineering" })).id;
    const beta = (await post(port, "/api/employees", { name: "Beta", runtime: "pi", role: "Reviewer", department: "Quality" })).id;
    const departmentId = (await post(port, "/api/departments", { name: "Engineering", managerId: alpha })).id;
    const pack = await post(port, "/api/packs", { id: "parallel", name: "Parallel", steps: [{ prompt: "write-file:a.txt:first", dependsOn: [] }, { prompt: "write-file:b.txt:second", dependsOn: [] }, { prompt: "Review both changes", dependsOn: [0, 1] }] });
    const plan = await post(port, "/api/collaboration/plans", { projectId, goal: "parallel work", packId: pack.id, packVersion: pack.version, steps: [{ employeeId: alpha, departmentId }, { employeeId: beta }, { employeeId: alpha }] });
    const planned = await snapshot(port);
    assert.equal(planned.dependencies.filter((item) => plan.taskIds.includes(item.task_id)).length, 2);
    assert.equal(planned.tasks.find((item) => item.id === plan.taskIds[0]).department_id, departmentId);
    const approvals = planned.approvals.filter((item) => plan.taskIds.includes(item.task_id));
    for (const approval of approvals) await post(port, `/api/approvals/${approval.id}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.filter((item) => plan.taskIds.slice(0, 2).includes(item.id)).every((item) => item.status === "completed"));
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === plan.taskIds[2]).status, "queued");
    for (const id of plan.taskIds.slice(0, 2)) await post(port, `/api/tasks/${id}/review`, { accepted: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === plan.taskIds[2])?.status === "completed");
    assert.match((await snapshot(port)).tasks.find((item) => item.id === plan.taskIds[2]).result, /前置任务的共享交付物/);
    await post(port, `/api/tasks/${plan.taskIds[2]}/review`, { accepted: true });
    const managerReview = await post(port, "/api/manager-reviews", { planId: plan.id, departmentId });
    await post(port, `/api/approvals/${managerReview.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === managerReview.taskId)?.status === "completed");
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === managerReview.taskId).kind, "manager_review");
    await post(port, `/api/tasks/${managerReview.taskId}/review`, { accepted: true });
    const integration = await post(port, "/api/integrations", { planId: plan.id });
    assert.equal(integration.status, "ready");
    assert.deepEqual(integration.report.changedFiles.sort(), ["a.txt", "b.txt"]);
    assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "base a");
    await post(port, `/api/integrations/${integration.id}/apply`, {});
    assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "first");
    assert.equal(await readFile(join(repo, "b.txt"), "utf8"), "second");
    const meetingId = (await post(port, "/api/meetings", { planId: plan.id, sourceTaskId: plan.taskIds[0], topic: "Code review", reviewerIds: [alpha, beta] })).id;
    const meetingItems = (await snapshot(port)).meetingItems.filter((item) => item.meeting_id === meetingId);
    assert.equal(meetingItems.length, 2);
    const meetingApprovals = (await snapshot(port)).approvals.filter((item) => meetingItems.some((entry) => entry.task_id === item.task_id));
    for (const approval of meetingApprovals) await post(port, `/api/approvals/${approval.id}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).meetings.find((item) => item.id === meetingId)?.derived_status === "completed");
    const meetingResult = (await snapshot(port)).sharedArtifacts.filter((item) => meetingItems.some((entry) => entry.task_id === item.task_id));
    assert.equal(meetingResult.length, 2);
    server.kill(); await new Promise((done) => server.once("exit", done));
    server = await startServer(port, dataDir);
    assert.equal((await snapshot(port)).integrations.find((item) => item.id === integration.id).status, "applied");
    assert.equal((await snapshot(port)).meetings.find((item) => item.id === meetingId).derived_status, "completed");
    execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "integrated"], { cwd: repo });
    const conflictPlan = await post(port, "/api/collaboration/plans", { projectId, goal: "conflict", steps: [{ prompt: "write-file:a.txt:left", employeeId: alpha, dependsOn: [] }, { prompt: "write-file:a.txt:right", employeeId: beta, dependsOn: [] }] });
    const conflictApprovals = (await snapshot(port)).approvals.filter((item) => conflictPlan.taskIds.includes(item.task_id));
    for (const approval of conflictApprovals) await post(port, `/api/approvals/${approval.id}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.filter((item) => conflictPlan.taskIds.includes(item.id)).every((item) => item.status === "completed"));
    for (const id of conflictPlan.taskIds) await post(port, `/api/tasks/${id}/review`, { accepted: true });
    const conflict = await post(port, "/api/integrations", { planId: conflictPlan.id });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.report.conflicts.length, 1);
    const rejected = await fetch(`http://127.0.0.1:${port}/api/integrations/${conflict.id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(rejected.status, 400);
    assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "first");
    const repositoryId = (await post(port, "/api/repositories", { projectId, name: "Secondary", path: repo2 })).id;
    const multi = await post(port, "/api/collaboration/plans", { projectId, goal: "two repositories", steps: [{ prompt: "write-file:b.txt:main", employeeId: alpha, dependsOn: [] }, { prompt: "write-file:a.txt:secondary", employeeId: beta, repositoryId, dependsOn: [] }] });
    for (const approval of (await snapshot(port)).approvals.filter((item) => multi.taskIds.includes(item.task_id))) await post(port, `/api/approvals/${approval.id}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.filter((item) => multi.taskIds.includes(item.id)).every((item) => item.status === "completed"));
    for (const id of multi.taskIds) await post(port, `/api/tasks/${id}/review`, { accepted: true });
    const mainReview = await post(port, "/api/integrations", { planId: multi.id });
    const secondReview = await post(port, "/api/integrations", { planId: multi.id, repositoryId });
    assert.equal(mainReview.status, "ready");
    assert.equal(secondReview.status, "ready");
    await post(port, `/api/integrations/${mainReview.id}/apply`, {});
    await post(port, `/api/integrations/${secondReview.id}/apply`, {});
    assert.equal(await readFile(join(repo, "b.txt"), "utf8"), "main");
    assert.equal(await readFile(join(repo2, "a.txt"), "utf8"), "secondary");
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    execFileSync("git", ["worktree", "prune"], { cwd: repo });
    execFileSync("git", ["worktree", "prune"], { cwd: repo2 });
    for (const path of [dataDir, repo, repo2]) {
      const absolute = resolve(path);
      assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
      await rm(absolute, { recursive: true, force: true });
    }
  }
});

test("Codex runs in an approved non-Git project and keeps CLI failures visible", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-nongit-data-"));
  const projectPath = await mkdtemp(join(tmpdir(), "apix-os-nongit-project-"));
  const port = 49700 + Math.floor(Math.random() * 100);
  let server;
  try {
    assert.throws(() => execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectPath, stdio: "ignore" }));
    server = await startServer(port, dataDir);
    const projectId = (await post(port, "/api/projects", { name: "Non-Git project", path: projectPath })).id;
    const employeeId = (await post(port, "/api/employees", { name: "Codex", runtime: "codex", role: "Analyst" })).id;
    const first = await post(port, "/api/tasks", { projectId, employeeId, prompt: "inspect" });
    await post(port, `/api/approvals/${first.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === first.taskId)?.status === "completed");
    const details = await (await fetch(`http://127.0.0.1:${port}/api/tasks/${first.taskId}/details`)).json();
    assert.equal(details.events.find((item) => item.kind === "run_started").payload.gitRepoCheckSkipped, true);
    const failed = await post(port, "/api/tasks", { projectId, employeeId, prompt: "cli-error" });
    await post(port, `/api/approvals/${failed.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === failed.taskId)?.status === "failed");
    assert.match((await snapshot(port)).tasks.find((item) => item.id === failed.taskId).result, /fixture failed before a response/);
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    for (const path of [dataDir, projectPath]) {
      const absolute = resolve(path);
      assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
      await rm(absolute, { recursive: true, force: true });
    }
  }
});

test("Phase 4 conversations, memory lifecycle, employee removal, and explicit recovery survive restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-phase4-"));
  const port = 49600 + Math.floor(Math.random() * 100);
  let server;
  try {
    server = await startServer(port, dataDir);
    const projectId = (await post(port, "/api/projects", { name: "Continuity", path: root })).id;
    const otherProjectId = (await post(port, "/api/projects", { name: "Other", path: join(root, "test") })).id;
    const firstEmployee = (await post(port, "/api/employees", { name: "Analyst", runtime: "pi", role: "Analyst" })).id;
    const secondEmployee = (await post(port, "/api/employees", { name: "Replacement", runtime: "pi", role: "Reviewer" })).id;
    const firstConversation = (await post(port, "/api/conversations", { projectId })).id;
    const secondConversation = (await post(port, "/api/conversations", { projectId, title: "Independent thread" })).id;
    const first = await post(port, "/api/tasks", { projectId, conversationId: firstConversation, employeeId: firstEmployee, prompt: "alpha secret context" });
    const second = await post(port, "/api/tasks", { projectId, conversationId: secondConversation, employeeId: secondEmployee, prompt: "beta task" });
    const activeDuplicate = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, conversationId: firstConversation, employeeId: firstEmployee, prompt: "too early" }) });
    assert.equal(activeDuplicate.status, 400);
    for (const item of [first, second]) await post(port, `/api/approvals/${item.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.filter((item) => [first.taskId, second.taskId].includes(item.id)).every((item) => item.status === "completed"));
    assert.doesNotMatch((await snapshot(port)).tasks.find((item) => item.id === second.taskId).result, /alpha secret context/);
    const taskMemory = (await post(port, "/api/memories", { projectId, taskId: first.taskId, scope: "task", category: "decision", title: "Private thread decision", content: "Use the alpha-only approach" })).id;
    const projectMemory = (await post(port, "/api/memories", { projectId, scope: "project", category: "architecture", title: "Architecture", content: "Use layered architecture" })).id;
    const profile = await post(port, `/api/projects/${projectId}/profile`, { version: 0, summary: "Project continuity", goals: "Ship safely", constraints: "No secrets", decisions: "Use SQLite" });
    assert.equal(profile.version, 1);
    const search = await (await fetch(`http://127.0.0.1:${port}/api/memories/search?projectId=${projectId}&q=architecture`)).json();
    assert.deepEqual(search.map((item) => item.id), [projectMemory]);
    const followUp = await post(port, "/api/tasks", { projectId, conversationId: firstConversation, employeeId: firstEmployee, prompt: "follow up" });
    await post(port, `/api/approvals/${followUp.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === followUp.taskId)?.status === "completed");
    const followUpResult = (await snapshot(port)).tasks.find((item) => item.id === followUp.taskId).result;
    assert.match(followUpResult, /alpha secret context/);
    assert.match(followUpResult, /Private thread decision/);
    assert.match(followUpResult, /Project continuity/);
    assert.doesNotMatch(followUpResult, /beta task/);
    const crossProject = await post(port, "/api/tasks", { projectId: otherProjectId, employeeId: secondEmployee, prompt: "other project" });
    await post(port, `/api/approvals/${crossProject.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === crossProject.taskId)?.status === "completed");
    assert.doesNotMatch((await snapshot(port)).tasks.find((item) => item.id === crossProject.taskId).result, /layered architecture|Project continuity/);
    const changed = await post(port, `/api/memories/${projectMemory}`, { version: 1, title: "Architecture", content: "Use modular architecture" });
    assert.equal(changed.version, 2);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/memories/search?projectId=${projectId}&q=layered`)).json()).length, 0);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/memories/search?projectId=${projectId}&q=modular`)).json()).length, 1);
    await post(port, `/api/memories/${projectMemory}/delete`, { version: 2 });
    await post(port, `/api/memories/${taskMemory}/delete`, { version: 1 });
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/memories/search?projectId=${projectId}&q=modular`)).json()).length, 0);
    const departmentId = (await post(port, "/api/departments", { name: "Continuity department", managerId: firstEmployee })).id;
    const blockedDeletion = await fetch(`http://127.0.0.1:${port}/api/employees/${firstEmployee}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(blockedDeletion.status, 400);
    await post(port, `/api/departments/${departmentId}`, { name: "Continuity department", managerId: secondEmployee });
    await post(port, `/api/employees/${firstEmployee}/delete`, {});
    assert.equal((await snapshot(port)).employees.some((item) => item.id === firstEmployee), false);
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === first.taskId).employee_name, "Analyst");
    const failure = await post(port, "/api/tasks", { projectId, conversationId: secondConversation, employeeId: secondEmployee, prompt: "provider-error" });
    await post(port, `/api/approvals/${failure.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === failure.taskId)?.status === "failed");
    const resumed = await post(port, `/api/tasks/${failure.taskId}/resume`, { employeeId: secondEmployee, instruction: "check existing work" });
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === resumed.taskId).resumes_task_id, failure.taskId);
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === resumed.taskId).status, "awaiting_approval");
    await post(port, `/api/approvals/${resumed.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === resumed.taskId)?.status === "completed");
    server.kill(); await new Promise((done) => server.once("exit", done));
    server = await startServer(port, dataDir);
    const restored = await snapshot(port);
    assert.equal(restored.conversations.filter((item) => item.project_id === projectId).length, 2);
    assert.equal(restored.profiles.find((item) => item.project_id === projectId).version, 1);
    assert.equal(restored.memories.length, 0);
    assert.equal(restored.tasks.find((item) => item.id === resumed.taskId).status, "completed");
    const database = new DatabaseSync(join(dataDir, "apix.sqlite"));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_revisions").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_fts").get().count, 0);
    database.close();
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    const absolute = resolve(dataDir);
    assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(absolute, { recursive: true, force: true });
  }
});

test("ApiX Director drafts an editable plan, records grounded memory, and keeps approvals after edits", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-director-"));
  const port = 49700 + Math.floor(Math.random() * 100);
  let server;
  try {
    server = await startServer(port, dataDir);
    const projectId = (await post(port, "/api/projects", { name: "Director project", path: root })).id;
    const designer = (await post(port, "/api/employees", { name: "Designer", runtime: "pi", role: "Designer" })).id;
    const developer = (await post(port, "/api/employees", { name: "Developer", runtime: "codex", role: "Developer" })).id;
    const unavailable = await fetch(`http://127.0.0.1:${port}/api/employees`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Qoder role", runtime: "qoder", role: "Developer" }) });
    assert.equal(unavailable.status, 400);
    const runtimes = (await snapshot(port)).runtimes;
    assert(runtimes.some((item) => item.id === "qoder" && !item.managed));
    const drafted = await post(port, "/api/director/messages", { projectId, content: "请实现多语言支持" });
    assert.equal(drafted.mode, "pi");
    const draftSnapshot = await snapshot(port);
    assert.equal(draftSnapshot.directorMessages.filter((item) => item.thread_id === drafted.threadId).length, 2);
    const proposal = draftSnapshot.directorProposals.find((item) => item.id === drafted.proposalId);
    assert.equal(proposal.status, "draft");
    assert.equal(proposal.steps.length, 2);
    assert.equal(draftSnapshot.memories.find((item) => item.title === "多语言目标")?.source, "director");
    const editedSteps = [{ prompt: "先设计语言资源", employeeId: designer, dependsOn: [] }, { prompt: "实现并验证切换", employeeId: developer, dependsOn: [0] }];
    const saved = await post(port, `/api/director/proposals/${proposal.id}`, { version: 1, goal: "支持中文和英文", steps: editedSteps });
    assert.equal(saved.version, 2);
    const outdated = await fetch(`http://127.0.0.1:${port}/api/director/proposals/${proposal.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, goal: "旧版", steps: editedSteps }) });
    assert.equal(outdated.status, 400);
    const approved = await post(port, `/api/director/proposals/${proposal.id}/approve`, { version: 2, goal: "支持中文和英文", steps: editedSteps });
    const plan = (await snapshot(port)).plans.find((item) => item.id === approved.planId);
    assert.equal(plan.mode, "collaboration");
    const secondTask = (await snapshot(port)).tasks.find((item) => item.id === approved.taskIds[1]);
    const secondApproval = (await snapshot(port)).approvals.find((item) => item.task_id === secondTask.id);
    await post(port, `/api/approvals/${secondApproval.id}`, { approved: true });
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === secondTask.id).status, "queued");
    await post(port, `/api/tasks/${secondTask.id}/revise`, { employeeId: designer, prompt: "重新安排实现与验证" });
    const revised = await snapshot(port);
    assert.equal(revised.tasks.find((item) => item.id === secondTask.id).status, "awaiting_approval");
    assert.equal(revised.approvals.find((item) => item.id === secondApproval.id).status, "pending");
    assert.equal(revised.tasks.find((item) => item.id === secondTask.id).employee_id, designer);
    const bulk = await post(port, `/api/director/plans/${plan.id}/approve`, { version: revised.plans.find((item) => item.id === plan.id).updated_at });
    assert.equal(bulk.approved, 2);
    assert.deepEqual(bulk.failed, []);
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === approved.taskIds[0])?.status === "completed");
    assert.equal((await snapshot(port)).tasks.find((item) => item.id === secondTask.id).status, "queued");
    await post(port, `/api/tasks/${approved.taskIds[0]}/review`, { accepted: true });
    await waitFor(async () => (await snapshot(port)).tasks.find((item) => item.id === secondTask.id)?.status === "completed");
    const statusReply = await post(port, "/api/director/messages", { projectId, content: "现在进度如何？" });
    assert.equal(statusReply.proposalId, null);
    assert.match((await snapshot(port)).directorMessages.find((item) => item.thread_id === drafted.threadId && item.content.includes("状态摘要"))?.content, /状态摘要/);
    const replacement = await post(port, "/api/director/messages", { projectId, content: "请重新设计多语言验证方案" });
    const replacementProposal = (await snapshot(port)).directorProposals.find((item) => item.id === replacement.proposalId);
    const replacementPlan = await post(port, `/api/director/proposals/${replacement.proposalId}/approve`, { version: replacementProposal.version, goal: replacementProposal.goal, steps: replacementProposal.steps });
    const cancelled = await post(port, `/api/director/plans/${replacementPlan.planId}/cancel-pending`, {});
    assert.equal(cancelled.cancelled, 2);
    assert((await snapshot(port)).tasks.filter((item) => replacementPlan.taskIds.includes(item.id)).every((item) => item.status === "cancelled"));
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    const absolute = resolve(dataDir);
    assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(absolute, { recursive: true, force: true });
  }
});

test("two Codex roles run concurrently in separate project conversations", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "apix-os-codex-parallel-"));
  const port = 49800 + Math.floor(Math.random() * 100);
  let server;
  try {
    server = await startServer(port, dataDir);
    const projectId = (await post(port, "/api/projects", { name: "Parallel roles", path: root })).id;
    const firstEmployee = (await post(port, "/api/employees", { name: "Builder", runtime: "codex", role: "Developer" })).id;
    const secondEmployee = (await post(port, "/api/employees", { name: "Verifier", runtime: "codex", role: "Tester" })).id;
    const first = await post(port, "/api/tasks", { projectId, employeeId: firstEmployee, prompt: "hold-codex:build" });
    const second = await post(port, "/api/tasks", { projectId, employeeId: secondEmployee, prompt: "hold-codex:verify" });
    assert.notEqual(first.conversationId, second.conversationId);
    await post(port, `/api/approvals/${first.approvalId}`, { approved: true });
    await post(port, `/api/approvals/${second.approvalId}`, { approved: true });
    await waitFor(async () => (await snapshot(port)).tasks.filter((item) => [first.taskId, second.taskId].includes(item.id)).every((item) => item.status === "running"));
    await waitFor(async () => (await snapshot(port)).tasks.filter((item) => [first.taskId, second.taskId].includes(item.id)).every((item) => item.status === "completed"), 7000);
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise((done) => server.once("exit", done)); }
    const absolute = resolve(dataDir);
    assert(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(absolute, { recursive: true, force: true });
  }
});
