const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const time = (value) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const names = { pi: "Pi", codex: "Codex CLI" };
const labels = { planned: "已生成计划", queued: "等待前置任务", blocked: "已阻塞", awaiting_approval: "等待启动审批", running: "运行中", stopping: "停止请求中", completed: "已完成", cancelled: "已停止", failed: "失败", unknown: "状态未知", rejected: "已拒绝", accepted: "已验收", needs_revision: "未通过验收" };

let data = { plans: [], projects: [], conversations: [], profiles: [], memories: [], directorThreads: [], directorMessages: [], directorProposals: [], tasks: [], runs: [], approvals: [], events: [], artifacts: [], runtimes: [], employees: [], dependencies: [], workspaces: [], departments: [], repositories: [], packs: [], meetings: [], meetingItems: [], sharedArtifacts: [], integrations: [], mailboxes: [], messages: [], messageEvents: [], messageAttempts: [], messageArtifacts: [], locks: [] };
let selectedProjectId = localStorage.getItem("apix.selectedProject") ?? null;
let selectedConversationId = localStorage.getItem("apix.selectedConversation") ?? null;
let selectedTaskId = null;
let selectedDetails = null;
let lastRenderedConversationId = null;
let profileLoadedProjectId = null;
let memoryResults = null;
let renderedProposalKey = null;
let directorSending = false;
let currentPage = "assistant";
let editing = null;
let toastTimer;
let messageStream = null;
let streamProjectId = null;
const localKey = "apix.settings.v1";
let settings;
try { settings = JSON.parse(localStorage.getItem(localKey)) ?? {}; } catch { settings = {}; }
settings.models ??= [];
settings.skills ??= [];
settings.mcps ??= [];
settings.selectedModelId ??= null;
const saveSettings = () => localStorage.setItem(localKey, JSON.stringify(settings));

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
function toast(message) {
  const element = $("#toast"); element.textContent = message; element.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove("show"), 3500);
}
function confirmAction(title, message) {
  return new Promise((resolve) => {
    const dialog = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    const finish = (accepted) => {
      dialog.close();
      $("#confirm-accept").removeEventListener("click", accept);
      $("#confirm-cancel").removeEventListener("click", cancel);
      $("#confirm-close").removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", escape);
      resolve(accepted);
    };
    const accept = () => finish(true);
    const cancel = () => finish(false);
    const escape = (event) => { event.preventDefault(); finish(false); };
    $("#confirm-accept").addEventListener("click", accept);
    $("#confirm-cancel").addEventListener("click", cancel);
    $("#confirm-close").addEventListener("click", cancel);
    dialog.addEventListener("cancel", escape);
    dialog.showModal();
  });
}
function project() { return data.projects.find((item) => item.id === selectedProjectId); }
function task() { return data.tasks.find((item) => item.id === selectedTaskId); }
function runFor(taskId) { return data.runs.find((item) => item.task_id === taskId); }
function go(page) {
  if (["workspace", "director"].includes(page)) page = "coordinator";
  currentPage = page;
  $$(".page").forEach((item) => item.classList.toggle("active-page", item.id === `page-${page}`));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.pageTarget === page));
  $("#breadcrumb-page").textContent = { assistant: "对话", overview: "管理总览", coordinator: "ApiX 目标", workspace: "工作台", director: "Director", missions: "任务与员工", employee: "员工详情", memory: "项目记忆", models: "模型配置", projects: "项目管理", resources: "Skills 与 MCP" }[page];
  document.dispatchEvent(new CustomEvent("apix:page", { detail: page }));
}
let refreshing=false;let snapshotETag='';
async function refresh() {
  if(refreshing)return;refreshing=true;
  try {
    const response=await fetch('/api/snapshot',{headers:snapshotETag?{'If-None-Match':snapshotETag}:{}});
    if(response.status!==304){if(!response.ok)throw new Error(`HTTP ${response.status}`);data=await response.json();snapshotETag=response.headers.get('ETag') ?? '';}
    if (!data.projects.some((item) => item.id === selectedProjectId)) selectedProjectId = data.projects[0]?.id ?? null;
    if (!data.conversations.some((item) => item.id === selectedConversationId && item.project_id === selectedProjectId)) selectedConversationId = data.conversations.find((item) => item.project_id === selectedProjectId)?.id ?? null;
    if (selectedConversationId) localStorage.setItem("apix.selectedConversation", selectedConversationId);
    else localStorage.removeItem("apix.selectedConversation");
    if (!data.tasks.some((item) => item.id === selectedTaskId && item.conversation_id === selectedConversationId)) selectedTaskId = data.tasks.find((item) => item.conversation_id === selectedConversationId)?.id ?? null;
    selectedDetails = selectedTaskId && currentPage==='workspace' ? await api(`/api/tasks/${selectedTaskId}/details`) : null;
    if (selectedProjectId !== streamProjectId) {
      messageStream?.close();
      streamProjectId = selectedProjectId;
      messageStream = selectedProjectId ? new EventSource(`/api/events/stream?projectId=${encodeURIComponent(selectedProjectId)}&agentId=apix-director`) : null;
      if (messageStream) for (const eventName of ["message.created", "message.delivered", "message.acknowledged", "message.completed", "message.failed", "message.expired", "message.retry_scheduled", "director.intercepted", "lock.acquired", "lock.released", "agent.status"]) messageStream.addEventListener(eventName, () => refresh());
    }
    render();
    document.dispatchEvent(new CustomEvent("apix:snapshot", { detail: { data, projectId: selectedProjectId ?? "" } }));
  } catch (error) { toast(`本地服务不可用：${error.message}`); }
  finally{refreshing=false;}
}
function render() { renderProjects(); renderAgents(); renderTasks(); renderPlans(); renderDirector(); renderConversations(); renderWorkspace(); renderSettings(); renderCollaboration(); renderMemory(); renderMessageSupervision(); }
function renderMessageSupervision() {
  const messages = data.messages.filter((item) => item.project_id === selectedProjectId).slice(0, 50);
  const locks = data.locks.filter((item) => item.project_id === selectedProjectId);
  $("#mailbox-summary").textContent = `${messages.filter((item) => ["queued", "delivered", "processing"].includes(item.status)).length} 条待处理 · ${messages.filter((item) => item.status === "rejected").length} 条已拦截 · ${locks.length} 个锁`;
  $("#agent-message-list").innerHTML = messages.map((item) => {
    const attachment = data.messageArtifacts.find((entry) => entry.message_id === item.id);
    return `<article class="collab-line"><strong>${escapeHtml(data.employees.find((employee) => employee.id === item.from_agent)?.name ?? item.from_agent)} → ${escapeHtml(data.employees.find((employee) => employee.id === item.to_agent)?.name ?? item.to_agent)}</strong><span>${escapeHtml(item.type)} · ${escapeHtml(item.status)} · ${time(item.created_at)} · 重试 ${item.retry_count}/${item.max_retries} · ${item.payload_bytes} 字节</span><p>${escapeHtml(typeof item.payload === "string" ? item.payload.slice(0, 300) : JSON.stringify(item.payload).slice(0, 300))}</p><small>关联 ${escapeHtml(item.correlation_id?.slice(0, 8))} · ${escapeHtml(item.error ?? "无拦截原因")}${attachment ? ` · 交付物 ${escapeHtml(attachment.artifact_id.slice(0, 8))}` : ""}</small>${["queued", "delivered", "processing"].includes(item.status) ? `<button class="text-action danger" data-reject-message="${item.id}">Director 拦截</button>` : ""}</article>`;
  }).join("") || `<div class="empty-card">当前项目暂无 Agent 消息。</div>`;
  $("#agent-lock-list").innerHTML = locks.map((item) => `<div class="collab-line"><strong>${escapeHtml(item.resource_type)} · ${escapeHtml(item.resource_key)}</strong><span>持有者 ${escapeHtml(data.employees.find((employee) => employee.id === item.owner_agent_id)?.name ?? item.owner_agent_id)} · 到期 ${time(item.expires_at)}</span><button class="text-action danger" data-release-lock="${item.id}">强制释放</button></div>`).join("") || `<div class="empty-card">暂无资源锁。</div>`;
}
function renderPlans() {
  $("#plan-board").innerHTML = data.plans.filter((plan) => plan.project_id === selectedProjectId).map((plan) => {
    const tasks = data.tasks.filter((item) => item.plan_id === plan.id);
    const fromDirector = data.directorProposals.some((proposal) => proposal.plan_id === plan.id);
    const canApproveAll = fromDirector && tasks.length > 0 && tasks.every((item) => item.kind === "work" && item.status === "awaiting_approval" && data.approvals.some((approval) => approval.task_id === item.id && approval.status === "pending"));
    const canCancelPending = fromDirector && tasks.some((item) => item.kind === "work" && ["awaiting_approval", "queued", "blocked"].includes(item.status));
    const steps = tasks.map((item, index) => {
      const dependency = data.dependencies.find((entry) => entry.task_id === item.id);
      const approval = data.approvals.find((entry) => entry.task_id === item.id);
      return `<div class="plan-step"><span class="step-number">${index + 1}</span><div><strong>${escapeHtml(item.prompt)}</strong><p>${escapeHtml(item.employee_name ?? "未匹配")} · ${escapeHtml(labels[item.status] ?? item.status)}${dependency ? ` · 依赖 ${escapeHtml(dependency.depends_on_id.slice(0, 8))}` : " · 根任务"}</p></div>${["awaiting_approval", "queued"].includes(item.status) ? `<button class="text-action" data-edit-plan-task="${item.id}">修改步骤</button>` : ""}${item.status === "awaiting_approval" && approval?.status === "pending" ? `<button class="text-action" data-plan-approve="${approval.id}">批准</button>` : item.status === "queued" ? `<span class="type-label">等待前置任务</span>` : ""}</div>`;
    }).join("");
    return `<article class="plan-card"><div class="plan-head"><div><span class="card-kicker">${escapeHtml(plan.project_name)}</span><h2>${escapeHtml(plan.goal.slice(0, 140))}</h2></div><span class="mission-status status-${escapeHtml(plan.derived_status)}">${escapeHtml(labels[plan.derived_status] ?? plan.derived_status)}</span></div><div class="mission-actions">${canApproveAll ? `<button class="primary-button" data-approve-plan="${plan.id}">审查并批准整份计划</button>` : ""}${canCancelPending ? `<button class="outline-button" data-cancel-plan="${plan.id}">取消未启动步骤</button>` : ""}</div><div class="plan-steps">${steps}</div></article>`;
  }).join("") || `<div class="empty-card">还没有计划。先与 ApiX 对话并检查提案。</div>`;
}
function renderDirector() {
  const current = project();
  $("#director-project-name").textContent = current ? `当前项目：${current.name}。可以持续补充约束并要求 ApiX 重新规划。` : "先选择项目，再与 ApiX 对话。";
  const thread = data.directorThreads.find((item) => item.project_id === selectedProjectId);
  const messages = data.directorMessages.filter((item) => item.thread_id === thread?.id).slice(-30);
  $("#director-messages").innerHTML = messages.map((item) => `<article class="director-message ${item.role}"><strong>${item.role === "user" ? "你" : "ApiX"}</strong><p>${escapeHtml(item.content)}</p><small>${item.status === "processing" ? "整理中" : item.status === "failed" ? "中断" : time(item.created_at)}</small></article>`).join("") || `<div class="empty-card">告诉 ApiX 你的目标和约束，它会整理一份可修改的协作提案。</div>`;
  const proposal = data.directorProposals.find((item) => item.thread_id === thread?.id);
  const key = proposal ? `${proposal.id}:${proposal.version}:${proposal.status}` : `empty:${selectedProjectId}`;
  if (key === renderedProposalKey) return;
  renderedProposalKey = key;
  if (!proposal) { $("#director-proposal").innerHTML = ""; return; }
  if (proposal.status === "approved") { $("#director-proposal").innerHTML = `<div class="surface-card"><h2>已创建协作计划</h2><p>计划 ${escapeHtml(proposal.plan_id?.slice(0, 8))} 已进入看板。你仍可修改未启动的步骤，每个 Run 需要单独批准。</p></div>`; return; }
  const employees = data.employees.filter((item) => item.enabled && data.runtimes.some((runtime) => runtime.id === item.runtime && runtime.available && runtime.managed));
  $("#director-proposal").innerHTML = `<form id="director-proposal-form" class="surface-card stacked-form" data-proposal-id="${proposal.id}" data-version="${proposal.version}"><div class="block-header"><div><h2>ApiX 的协作提案</h2><p>编辑目标、步骤、员工和依赖后保存，或直接创建待审批计划。</p></div><span class="type-label">草案 v${proposal.version}</span></div><label>目标<textarea name="goal" required maxlength="20000">${escapeHtml(proposal.goal)}</textarea></label><div class="director-step-list">${proposal.steps.map((step, index) => `<div class="director-step"><strong>步骤 ${index + 1}</strong><label>任务<textarea data-proposal-prompt="${index}" required maxlength="20000">${escapeHtml(step.prompt)}</textarea></label><label>员工<select data-proposal-employee="${index}" required><option value="">选择员工</option>${employees.map((employee) => `<option value="${employee.id}" ${employee.id === step.employeeId ? "selected" : ""}>${escapeHtml(employee.name)} · ${escapeHtml(employee.role)}</option>`).join("")}</select></label><label>依赖步骤编号（逗号分隔）<input data-proposal-deps="${index}" value="${step.dependsOn.map((value) => value + 1).join(",")}" placeholder="无依赖可并行"></label></div>`).join("")}</div><div class="form-actions"><button class="outline-button" type="button" id="save-director-proposal">保存修改</button><button class="primary-button" type="submit">创建待审批计划</button></div></form>`;
}
function directorProposalValues() {
  const form = $("#director-proposal-form");
  const steps = $$("[data-proposal-prompt]").map((field, index) => ({ prompt: field.value.trim(), employeeId: $(`[data-proposal-employee="${index}"]`).value, dependsOn: $(`[data-proposal-deps="${index}"]`).value.split(/[，,\s]+/).filter(Boolean).map((value) => Number(value) - 1) }));
  return { id: form.dataset.proposalId, version: Number(form.dataset.version), goal: form.elements.goal.value.trim(), steps };
}
function renderProjects() {
  $("#sidebar-projects").innerHTML = data.projects.map((item) => `<button class="sidebar-project ${item.id === selectedProjectId ? "selected" : ""}" data-select-project="${item.id}"><span class="project-icon violet">${icon("folder")}</span><span class="sidebar-project-name">${escapeHtml(item.name)}</span></button>`).join("") || `<div class="activity-empty">暂无项目</div>`;
  $("#project-grid").innerHTML = data.projects.map((item) => `<article class="project-card ${item.id === selectedProjectId ? "selected" : ""}"><div class="item-card-top"><span class="project-icon violet">${icon("folder")}</span><span class="type-label">已验证目录</span></div><h3 class="item-card-title">${escapeHtml(item.name)}</h3><p class="item-card-description">${escapeHtml(item.description)}</p><div class="project-meta">${icon("folder")}${escapeHtml(item.path)}</div><div class="item-card-bottom"><button class="text-action" data-select-project="${item.id}">选择项目</button><button class="text-action" data-edit-project="${item.id}">编辑</button></div></article>`).join("") || `<div class="empty-card">添加一个已有目录，开始管理任务。</div>`;
  $("#workspace-project-name").textContent = project()?.name ?? "选择项目";
}
function renderAgents() {
  $("#runtime-grid").innerHTML = data.runtimes.map((item) => {
    const active = data.runs.filter((run) => run.runtime === item.id && ["running", "stopping"].includes(run.status)).length;
    return `<article class="resource-card"><div class="item-card-top"><span class="item-icon model">${icon("terminal")}</span><span class="${item.available ? "selected-label" : "type-label"}">${item.available ? item.managed ? active ? `${active} 个运行中` : "可托管" : "已发现" : "未发现"}</span></div><h3 class="item-card-title">${escapeHtml(item.name)}</h3><p class="item-card-description">${escapeHtml(item.stateSource)} · ${item.managed ? "ApiX 可启动、观察与请求停止托管 Run" : item.available ? "桌面应用已发现；暂无经过验证的会话/执行适配器" : "未检测到本机应用；暂无托管适配器"}</p><div class="item-card-bottom">${item.managed && item.available ? `<button class="text-action" data-register-runtime="${item.id}">注册为员工</button>` : `<span class="type-label">${item.available ? "仅发现" : "未安装"}</span>`}</div></article>`;
  }).join("");
  $("#agent-grid").innerHTML = data.employees.map((item) => {
    const runtime = data.runtimes.find((entry) => entry.id === item.runtime);
    const available = !!item.enabled && !!runtime?.available;
    const active = data.tasks.filter((task) => task.employee_id === item.id && ["running", "stopping"].includes(task.status)).length;
    return `<article class="resource-card ${item.enabled ? "" : "off"}"><div class="item-card-top"><span class="item-icon skill">${icon("spark")}</span><span class="${available ? "selected-label" : "type-label"}">${!item.enabled ? "已停用" : !runtime?.available ? "Runtime 不可用" : active ? `${active} 个任务运行中` : "待命"}</span></div><h3 class="item-card-title"><button class="employee-link" data-open-employee="${item.id}">${escapeHtml(item.name)}</button></h3><p class="item-card-description">${escapeHtml(item.role)} · ${escapeHtml(item.department || "未分组")} · ${escapeHtml(runtime?.name ?? item.runtime)}</p><div class="item-card-bottom"><button class="text-action" data-open-employee="${item.id}">查看详情</button><div><button class="text-action" data-edit-employee="${item.id}">编辑</button> <button class="text-action danger" data-delete-employee="${item.id}">删除</button></div></div></article>`;
  }).join("") || `<div class="empty-card">还没有员工。先从已发现的 Runtime 注册一个岗位。</div>`;
  const select = $("#employee-select"); const current = select.value;
  const availableEmployees = data.employees.filter((item) => item.enabled && data.runtimes.some((runtime) => runtime.id === item.runtime && runtime.available && runtime.managed));
  select.innerHTML = `<option value="">${availableEmployees.length ? "选择员工" : "请先注册可用员工"}</option>` + availableEmployees.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join("");
  if (availableEmployees.some((item) => item.id === current)) select.value = current;
}
function renderTasks() {
  $("#task-list").innerHTML = data.tasks.map((item) => {
    const run = runFor(item.id);
    const approval = data.approvals.find((entry) => entry.task_id === item.id);
    const artifact = run && data.artifacts.find((entry) => entry.run_id === run.id);
    const result = artifact?.content ?? item.result;
    const canResume = !item.plan_id && item.conversation_id && ["failed", "cancelled", "unknown", "needs_revision"].includes(item.status);
    return `<article class="mission-card ${item.id === selectedTaskId ? "selected" : ""}"><div class="mission-head"><div><strong>${escapeHtml(item.prompt.slice(0, 110))}</strong><p>${escapeHtml(item.project_name)} · ${escapeHtml(data.conversations.find((entry) => entry.id === item.conversation_id)?.title ?? "计划任务")} · ${escapeHtml(item.employee_name ?? names[item.runtime] ?? item.runtime)} · ${time(item.created_at)}</p></div><span class="mission-status status-${escapeHtml(item.status)}">${escapeHtml(labels[item.status] ?? item.status)}</span></div><div class="mission-meta">${run ? `Run ${escapeHtml(run.id.slice(0, 8))} · 来源 ${escapeHtml(run.status_source)} · 可信度 ${escapeHtml({ confirmed: "已确认", observed: "当前观测", unavailable: "不可确认" }[run.status_confidence] ?? "未知")}` : "尚未启动"}</div>${item.status === "awaiting_approval" && approval ? `<div class="mission-actions"><button class="primary-button" data-approve="${approval.id}">审查并启动</button><button class="outline-button" data-reject="${approval.id}">拒绝</button></div>` : ""}${run && ["running", "stopping"].includes(run.status) ? `<div class="mission-actions"><button class="outline-button" data-stop="${run.id}" ${run.status === "stopping" ? "disabled" : ""}>${run.status === "stopping" ? "等待停止确认" : "请求停止"}</button></div>` : ""}${result ? `<details class="mission-result"><summary>${item.status === "failed" ? "查看失败原因" : "查看交付物"}</summary><pre>${escapeHtml(result)}</pre></details>` : ""}${item.status === "completed" ? `<div class="mission-actions"><button class="primary-button" data-accept="${item.id}">验收通过</button><button class="outline-button" data-revise="${item.id}">需要修改</button></div>` : ""}<div class="mission-actions"><button class="text-action" data-open-task="${item.id}">查看对话与事件</button>${canResume ? `<button class="text-action" data-resume-task="${item.id}">从此任务继续</button>` : ""}</div></article>`;
  }).join("") || `<div class="empty-card">还没有任务。先在工作台选择项目并提交任务。</div>`;
}
function renderConversations() {
  const conversations = data.conversations.filter((item) => item.project_id === selectedProjectId);
  $("#conversation-name").textContent = conversations.find((item) => item.id === selectedConversationId)?.title ?? "新对话";
  $("#conversation-list").innerHTML = conversations.map((item) => `<div class="conversation-pill ${item.id === selectedConversationId ? "selected" : ""}"><button data-select-conversation="${item.id}"><strong>${escapeHtml(item.title)}</strong><span>${item.task_count} 轮 · ${time(item.updated_at)}</span></button><button class="text-action" data-rename-conversation="${item.id}" aria-label="重命名 ${escapeHtml(item.title)}">编辑</button></div>`).join("") || `<div class="conversation-empty">这个项目还没有对话。点击“新对话”开始。</div>`;
}
function renderMemory() {
  const current = project();
  $("#memory-project-name").textContent = current ? `${current.name} · ApiX 可从主对话自动整理有原话依据的记忆，你仍可编辑或删除。` : "请先选择项目。";
  const profile = data.profiles.find((item) => item.project_id === selectedProjectId);
  if (profileLoadedProjectId !== selectedProjectId) {
    const form = $("#profile-form");
    for (const key of ["summary", "goals", "constraints", "decisions"]) form.elements[key].value = profile?.[key] ?? "";
    profileLoadedProjectId = selectedProjectId;
  }
  $("#profile-version").textContent = `版本 ${profile?.version ?? 0}`;
  const select = $("#memory-task-select");
  const previousTask = select.value;
  const tasks = data.tasks.filter((item) => item.project_id === selectedProjectId);
  select.innerHTML = `<option value="">选择来源任务</option>` + tasks.map((item) => `<option value="${item.id}">${escapeHtml(item.prompt.slice(0, 80))}</option>`).join("");
  if (tasks.some((item) => item.id === previousTask)) select.value = previousTask;
  const records = memoryResults === null ? data.memories.filter((item) => item.project_id === selectedProjectId) : memoryResults;
  $("#memory-list").innerHTML = records.map((item) => `<article class="memory-card"><div class="memory-card-top"><span class="type-label">${item.scope === "task" ? "任务" : "项目"} · ${escapeHtml(item.category)}</span><span>${time(item.updated_at)}</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.content)}</p>${item.source === "director" ? `<small>来源：ApiX 主对话 · ${escapeHtml(data.directorMessages.find((message) => message.id === item.source_message_id)?.content.slice(0, 120) ?? "用户原话")}</small>` : ""}${item.task_id ? `<small>来源任务：${escapeHtml(tasks.find((task) => task.id === item.task_id)?.prompt.slice(0, 100) ?? item.task_id)}</small>` : ""}<div class="memory-actions"><button class="text-action" data-edit-memory="${item.id}">编辑</button><button class="text-action danger" data-delete-memory="${item.id}">删除</button></div></article>`).join("") || `<div class="empty-card">${memoryResults === null ? "当前项目还没有记忆。" : "没有匹配的记忆。"}</div>`;
}
function renderWorkspace() {
  const selected = task();
  const events = selected && selectedDetails?.task.id === selected.id ? [...selectedDetails.events].reverse() : [];
  const tasks = data.tasks.filter((item) => item.conversation_id === selectedConversationId).reverse();
  const scroll = $("#chat-scroll");
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100 || selectedConversationId !== lastRenderedConversationId;
  $("#message-count").textContent = String(tasks.length);
  $("#activity-count").textContent = String(events.length).padStart(2, "0");
  $("#chat-list").innerHTML = tasks.length ? tasks.map((item) => {
    const run = runFor(item.id);
    const approval = data.approvals.find((entry) => entry.task_id === item.id && entry.status === "pending");
    const response = item.result || (item.status === "awaiting_approval" ? "等待你审批启动。" : item.status === "running" ? "Agent 正在运行，结果将由本地服务记录。" : "暂无交付内容。");
    return `<article class="chat-row user"><div class="message-body"><div class="message-head"><strong>任务指令</strong><span>${time(item.created_at)}</span></div><div class="message-bubble">${escapeHtml(item.prompt)}</div></div><span class="message-avatar user-avatar">你</span></article><article class="chat-row assistant"><span class="message-avatar">${icon("spark")}</span><div class="message-body"><div class="message-head"><strong>${escapeHtml(item.employee_name ?? names[item.runtime] ?? item.runtime)}</strong><span>${escapeHtml(labels[item.status] ?? item.status)}</span></div><div class="message-bubble">${escapeHtml(response)}</div><div class="message-footer">来源：${escapeHtml(run?.status_source ?? "ApiX 审批记录")} · <button class="text-action" data-view-task="${item.id}">查看事件</button>${approval ? ` · <button class="text-action" data-approve="${approval.id}">审查并启动</button>` : ""}</div></div></article>`;
  }).join("") : `<div class="chat-empty"><div class="empty-orb">${icon("spark")}</div><h3>开始这条对话</h3><p>选择员工并提交任务；同一项目可同时打开其他对话。</p></div>`;
  $("#activity-list").innerHTML = events.map((item) => `<div class="activity-item"><span class="activity-icon tool">${icon(item.kind.includes("tool") ? "terminal" : "clock")}</span><div class="activity-main"><div class="activity-title-line"><strong>${escapeHtml(item.kind)}</strong><time>${time(item.created_at)}</time></div><p>${escapeHtml(summary(item))}</p><div class="activity-file">${escapeHtml(item.source)}</div></div></div>`).join("") || `<div class="activity-empty">当前任务暂无 Agent 事件。</div>`;
  if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  lastRenderedConversationId = selectedConversationId;
}
function summary(event) {
  const value = event.payload;
  return value.text ?? value.message ?? value.toolName ?? value.error ?? (value.status ? `状态：${value.status}` : JSON.stringify(value).slice(0, 160));
}
function renderSettings() {
  const model = settings.models.find((item) => item.id === settings.selectedModelId);
  $("#top-model-name").textContent = "ApiX 推理模型";
  $("#active-model-title").textContent = model?.name ?? "尚未选择模型";
  $("#active-model-subtitle").textContent = model?.modelId ?? "仅保存偏好；具体运行模型由 Agent 自身配置决定";
  $("#active-provider").textContent = model?.provider ?? "—";
  $("#active-thinking").textContent = model?.thinking ?? "—";
  $("#model-total").textContent = `${settings.models.length} 个模型`;
  $("#model-grid").innerHTML = settings.models.map((item) => `<article class="model-card"><div class="item-card-top"><span class="item-icon model">${icon("cube")}</span><span class="type-label">${escapeHtml(item.provider)}</span></div><h3 class="item-card-title">${escapeHtml(item.name)}</h3><p class="item-card-subtitle">${escapeHtml(item.modelId)}</p><div class="item-card-bottom"><button class="text-action" data-model="${item.id}">${item.id === settings.selectedModelId ? "已选择" : "设为偏好"}</button><button class="text-action danger" data-remove-model="${item.id}">移除</button></div></article>`).join("") || `<div class="empty-card">尚无模型偏好；运行时使用 Agent 自身配置。</div>`;
  $("#skill-tab-count").textContent = String(settings.skills.length);
  $("#mcp-tab-count").textContent = String(settings.mcps.length);
  $("#skill-grid").innerHTML = settings.skills.map((item) => `<article class="resource-card"><div class="item-card-top"><span class="item-icon skill">${icon("spark")}</span><button class="toggle ${item.enabled ? "on" : ""}" data-toggle-skill="${item.id}" role="switch" aria-checked="${item.enabled}"></button></div><h3 class="item-card-title">${escapeHtml(item.name)}</h3><p class="item-card-description">${escapeHtml(item.description)}</p><div class="item-card-bottom"><span class="type-label">本地配置 · 未注入运行时</span><button class="text-action danger" data-remove-skill="${item.id}">移除</button></div></article>`).join("") || `<div class="empty-card">暂无 Skill 配置。</div>`;
  $("#mcp-grid").innerHTML = settings.mcps.map((item) => `<article class="resource-card"><div class="item-card-top"><span class="item-icon mcp">${icon("globe")}</span><button class="toggle ${item.enabled ? "on" : ""}" data-toggle-mcp="${item.id}" role="switch" aria-checked="${item.enabled}"></button></div><h3 class="item-card-title">${escapeHtml(item.name)}</h3><p class="item-card-description">${escapeHtml(item.description)}</p><div class="project-meta">${escapeHtml(item.transport)} · ${escapeHtml(item.target)}</div><div class="item-card-bottom"><span class="type-label">仅保存配置 · 未连接</span><button class="text-action danger" data-remove-mcp="${item.id}">移除</button></div></article>`).join("") || `<div class="empty-card">暂无 MCP 配置。</div>`;
}
function openEditor(kind, id = null) {
  editing = { kind, id };
  $("#dialog-kicker").textContent = "创建配置";
  if (kind === "plan-task") {
    const item = data.tasks.find((entry) => entry.id === id);
    $("#dialog-kicker").textContent = "执行前调整";
    $("#dialog-title").textContent = "修改计划步骤";
    $("#dialog-fields").innerHTML = `<p class="form-note">修改后原启动审批失效，需要重新审批。已运行的步骤不能在此修改。</p><label>任务内容<textarea name="prompt" required maxlength="20000">${escapeHtml(item.prompt)}</textarea></label><label>执行员工<select name="employeeId" required>${data.employees.filter((employee) => employee.enabled).map((employee) => `<option value="${employee.id}" ${employee.id === item.employee_id ? "selected" : ""}>${escapeHtml(employee.name)} · ${escapeHtml(employee.role)}</option>`).join("")}</select></label>`;
    $("#editor-dialog").showModal();
    return;
  }
  const existing = kind === "employee" ? data.employees.find((item) => item.id === id) : kind === "department" ? data.departments.find((item) => item.id === id) : kind === "resume" ? data.tasks.find((item) => item.id === id) : kind === "memory" ? data.memories.find((item) => item.id === id) : kind === "conversation" ? data.conversations.find((item) => item.id === id) : data.projects.find((item) => item.id === id);
  if (existing) { $("#dialog-kicker").textContent = "编辑配置"; $("#dialog-title").textContent = { employee: "编辑员工", department: "更换部门经理", resume: "继续未完成任务", project: "编辑项目", memory: "编辑记忆", conversation: "重命名对话" }[kind]; }
  else $("#dialog-title").textContent = { project: "添加项目", employee: "注册员工", skill: "添加 Skill", mcp: "添加 MCP 服务" }[kind];
  const field = (label, name, placeholder = "", value = "") => `<label>${label}<input name="${name}" required maxlength="500" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" /></label>`;
  $("#dialog-fields").innerHTML = kind === "project" ? field("项目名称", "name", "ApiX 开发", existing?.name) + field("已有目录绝对路径", "path", "E:\\Projects\\ApiX", existing?.path) + `<label>描述<input name="description" maxlength="500" value="${escapeHtml(existing?.description)}" /></label>` : kind === "employee" ? `<label>Runtime<select name="runtime" ${existing ? "disabled" : ""}>${data.runtimes.map((item) => `<option value="${item.id}" ${item.id === (existing?.runtime ?? id) ? "selected" : ""}>${escapeHtml(item.name)}${item.available ? "" : "（未安装）"}</option>`).join("")}</select></label>` + field("员工名称", "name", "例如：代码审查员", existing?.name) + field("岗位", "role", "例如：代码审查", existing?.role) + `<label>部门<input name="department" maxlength="100" value="${escapeHtml(existing?.department)}" placeholder="例如：研发部" /></label><label>状态<select name="enabled"><option value="true" ${existing?.enabled === 0 ? "" : "selected"}>启用</option><option value="false" ${existing?.enabled === 0 ? "selected" : ""}>停用</option></select></label>` : kind === "department" ? field("部门名称", "name", "例如：研发部", existing?.name) + `<label>经理员工<select name="managerId" required>${data.employees.filter((item) => item.enabled).map((item) => `<option value="${item.id}" ${item.id === existing.manager_id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>` : kind === "resume" ? `<p class="form-note">旧进程可能仍有副作用。继续操作会创建一条新的待审批任务，请先核对项目当前状态。</p><label>执行员工<select name="employeeId" required>${data.employees.filter((item) => item.enabled).map((item) => `<option value="${item.id}" ${item.id === existing.employee_id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label><label>补充要求<textarea name="instruction" maxlength="4000" placeholder="例如：先检查已修改文件和测试结果，再继续"></textarea></label>` : kind === "memory" ? field("标题", "title", "", existing?.title) + `<label>内容<textarea name="content" required maxlength="10000">${escapeHtml(existing?.content)}</textarea></label>` : kind === "conversation" ? field("对话标题", "title", "", existing?.title) : kind === "skill" ? field("Skill 名称", "name") + field("用途描述", "description") + `<label>简要指令<textarea name="instructions" maxlength="1000"></textarea></label>` : field("服务名称", "name") + field("用途描述", "description") + `<label>传输<select name="transport"><option>stdio</option><option>http</option></select></label>` + field("命令或 URL", "target");
  if (kind === "employee" && !existing) for (const option of $$("#dialog-fields select[name=runtime] option")) if (!data.runtimes.some((item) => item.id === option.value && item.available && item.managed)) option.remove();
  $("#editor-dialog").showModal();
}
async function mutate(path, body) { try { await api(path, body); await refresh(); } catch (error) { toast(error.message); } }

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-page-target],[data-select-project],[data-edit-project],[data-register-runtime],[data-open-employee],[data-edit-employee],[data-delete-employee],[data-open-task],[data-view-task],[data-select-conversation],[data-rename-conversation],[data-resume-task],[data-edit-memory],[data-delete-memory],[data-edit-department],[data-edit-plan-task],[data-approve-plan],[data-cancel-plan],[data-plan-approve],[data-approve],[data-reject],[data-stop],[data-accept],[data-revise],[data-model],[data-remove-model],[data-toggle-skill],[data-toggle-mcp],[data-remove-skill],[data-remove-mcp],[data-resource-tab],[data-apply-integration]");
  if (!target) return;
  const d = target.dataset;
  if (d.pageTarget) go(d.pageTarget);
  else if (d.applyIntegration) {
    const review = data.integrations.find((item) => item.id === d.applyIntegration);
    const report = review && JSON.parse(review.report);
    if (review && await confirmAction("应用集成结果", `目标仓库：${review.repository_path}\n变更文件：${report.changedFiles.join(", ")}\n\n确认后会把已审查的差异写入该仓库工作区。`)) await mutate(`/api/integrations/${review.id}/apply`, {});
  }
  else if (d.selectProject) { selectedProjectId = d.selectProject; localStorage.setItem("apix.selectedProject", selectedProjectId); selectedConversationId = data.conversations.find((item) => item.project_id === selectedProjectId)?.id ?? null; selectedTaskId = null; selectedDetails = null; profileLoadedProjectId = null; renderedProposalKey = null; memoryResults = null; $("#memory-search-input").value = ""; await refresh(); go("assistant"); }
  else if (d.editProject) openEditor("project", d.editProject);
  else if (d.registerRuntime) openEditor("employee", d.registerRuntime);
  else if (d.openEmployee) { go('employee'); document.dispatchEvent(new CustomEvent('apix:open-employee',{detail:d.openEmployee})); }
  else if (d.editEmployee) openEditor("employee", d.editEmployee);
  else if (d.deleteEmployee) { const employee = data.employees.find((item) => item.id === d.deleteEmployee); if (employee && await confirmAction("删除员工", `删除 ${employee.name} 后，历史任务和运行审计仍保留姓名。若该员工是部门经理或有活动任务，请先处理。`)) { await mutate(`/api/employees/${employee.id}/delete`, {}); } }
  else if (d.selectConversation) { selectedConversationId = d.selectConversation; selectedTaskId = null; selectedDetails = null; await refresh(); go("workspace"); }
  else if (d.renameConversation) openEditor("conversation", d.renameConversation);
  else if (d.openTask || d.viewTask) {
    const selected = data.tasks.find((item) => item.id === (d.openTask ?? d.viewTask));
    if (selected?.conversation_id) { selectedProjectId = selected.project_id; selectedConversationId = selected.conversation_id; localStorage.setItem("apix.selectedProject", selectedProjectId); selectedTaskId = selected.id; await refresh(); go("workspace"); }
    else if (selected) {
      try { const details = await api(`/api/tasks/${selected.id}/details`); $("#task-details-content").innerHTML = `<p><strong>${escapeHtml(selected.employee_name ?? names[selected.runtime])}</strong> · ${escapeHtml(labels[selected.status] ?? selected.status)} · ${time(selected.created_at)}</p><p>${escapeHtml(selected.prompt)}</p>${selected.result ? `<pre>${escapeHtml(selected.result)}</pre>` : ""}<h3>事件</h3>${details.events.slice(-100).reverse().map((item) => `<div class="activity-item"><strong>${escapeHtml(item.kind)}</strong><span>${time(item.created_at)}</span><p>${escapeHtml(summary(item))}</p></div>`).join("") || `<p>尚无事件。</p>`}`; $("#task-details-dialog").showModal(); } catch (error) { toast(error.message); }
    }
  }
  else if (d.resumeTask) openEditor("resume", d.resumeTask);
  else if (d.editMemory) openEditor("memory", d.editMemory);
  else if (d.deleteMemory) { const memory = data.memories.find((item) => item.id === d.deleteMemory); if (memory && await confirmAction("删除记忆", `确认永久删除“${memory.title}”？该记录及其修订历史会被清除。`)) { memoryResults = null; await mutate(`/api/memories/${memory.id}/delete`, { version: memory.version }); } }
  else if (d.editDepartment) openEditor("department", d.editDepartment);
  else if (d.editPlanTask) openEditor("plan-task", d.editPlanTask);
  else if (d.approvePlan) {
    const plan = data.plans.find((item) => item.id === d.approvePlan);
    const tasks = data.tasks.filter((item) => item.plan_id === plan?.id && item.kind === "work");
    const destination = data.projects.find((item) => item.id === plan?.project_id);
    if (plan && destination && await confirmAction("批准整份协作计划", `项目：${destination.name}\n目录：${destination.path}\n\n${tasks.map((item, index) => `${index + 1}. ${item.employee_name}：${item.prompt.slice(0, 100)}`).join("\n")}\n\n确认后 ApiX 将按依赖自动启动这些已批准的任务。各 Agent 仍可能访问本机其他资源。`)) {
      try { const result = await api(`/api/director/plans/${plan.id}/approve`, { version: plan.updated_at }); await refresh(); toast(result.failed.length ? `${result.approved} 步已批准，${result.failed.length} 步启动失败，请查看任务` : "计划已批准，ApiX 正在按依赖调度"); } catch (error) { toast(error.message); }
    }
  }
  else if (d.cancelPlan) {
    const plan = data.plans.find((item) => item.id === d.cancelPlan);
    if (plan && await confirmAction("取消未启动步骤", `计划：${plan.goal.slice(0, 180)}\n\n待审批、排队和已阻塞的步骤会取消；运行中的 Agent 不受此操作影响，需要单独请求停止。`)) await mutate(`/api/director/plans/${plan.id}/cancel-pending`, {});
  }
  else if (d.planApprove) {
    const approval = data.approvals.find((item) => item.id === d.planApprove);
    const selected = approval && data.tasks.find((item) => item.id === approval.task_id);
    const destination = selected && data.projects.find((item) => item.id === selected.project_id);
    if (approval && selected && destination) {
      const confirmed = await confirmAction("审批计划步骤", `员工：${selected.employee_name ?? names[selected.runtime]}（${names[selected.runtime]}）\n工作目录：计划任务将创建独立 Git worktree\n项目：${destination.path}\n\n前置任务完成后才会启动此步骤。`);
      if (confirmed) await mutate(`/api/approvals/${approval.id}`, { approved: true });
    }
  } else if (d.approve) {
    const approval = data.approvals.find((item) => item.id === d.approve);
    const selected = data.tasks.find((item) => item.id === approval?.task_id);
    const destination = data.projects.find((item) => item.id === selected?.project_id);
    if (!(await confirmAction("审批启动 Agent", `员工：${selected.employee_name ?? names[selected.runtime]}（${names[selected.runtime]}）\n项目目录：${destination.path}\n\n非 Git 目录使用 Codex 时会允许其跳过 Git 仓库检查，仍使用 workspace-write 沙箱。该 Agent 可能读取或修改文件；ApiX 不能强制限制本机进程的目录访问。`))) return;
    await mutate(`/api/approvals/${d.approve}`, { approved: true });
  } else if (d.reject) await mutate(`/api/approvals/${d.reject}`, { approved: false });
  else if (d.stop) await mutate(`/api/runs/${d.stop}/stop`, {});
  else if (d.accept || d.revise) await mutate(`/api/tasks/${d.accept ?? d.revise}/review`, { accepted: !!d.accept });
  else if (d.model) { settings.selectedModelId = d.model; saveSettings(); renderSettings(); toast("模型偏好已保存；Agent 运行模型由其自身配置决定"); }
  else if (d.removeModel) { settings.models = settings.models.filter((item) => item.id !== d.removeModel); if (settings.selectedModelId === d.removeModel) settings.selectedModelId = null; saveSettings(); renderSettings(); }
  else if (d.toggleSkill || d.toggleMcp) { const collection = d.toggleSkill ? settings.skills : settings.mcps; const item = collection.find((entry) => entry.id === (d.toggleSkill ?? d.toggleMcp)); if (item) item.enabled = !item.enabled; saveSettings(); renderSettings(); }
  else if (d.removeSkill || d.removeMcp) { const key = d.removeSkill ? "skills" : "mcps"; settings[key] = settings[key].filter((item) => item.id !== (d.removeSkill ?? d.removeMcp)); saveSettings(); renderSettings(); }
  else if (d.resourceTab) { $$(".resource-tab").forEach((item) => { item.classList.toggle("active", item === target); item.setAttribute("aria-selected", String(item === target)); }); $("#skills-panel").classList.toggle("hidden", d.resourceTab !== "skills"); $("#mcp-panel").classList.toggle("hidden", d.resourceTab !== "mcp"); }
});
async function submitChat(parallel) {
  if (!selectedProjectId) { toast("请先添加并选择项目"); go("projects"); return; }
  const prompt = $("#chat-input").value.trim(); const employeeId = $("#employee-select").value;
  if (!employeeId) { toast("请先在任务与员工页注册可用员工"); go("missions"); return; }
  if (!prompt) return;
  try { const created = await api("/api/tasks", { projectId: selectedProjectId, conversationId: parallel ? null : selectedConversationId, employeeId, prompt }); $("#chat-input").value = ""; selectedConversationId = created.conversationId; selectedTaskId = created.taskId; await refresh(); go("workspace"); toast(parallel ? "已在独立对话创建并行任务，请审查启动审批" : "任务已创建，请审查启动审批"); } catch (error) { toast(error.message); }
}
$("#chat-form").addEventListener("submit", async (event) => { event.preventDefault(); await submitChat(false); });
$("#parallel-submit").addEventListener("click", async () => submitChat(true));
$("#director-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedProjectId) { toast("请先添加并选择项目"); go("projects"); return; }
  const goal = $("#director-goal").value.trim();
  if (!goal) return;
  try { await api("/api/director/plans", { projectId: selectedProjectId, goal }); $("#director-goal").value = ""; await refresh(); toast("Director 已生成计划，请逐项审查批准"); } catch (error) { toast(error.message); }
});
$("#chat-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("#chat-form").requestSubmit(); } });
$("#editor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  if (editing.kind === "project") { try { const created = await api(editing.id ? `/api/projects/${editing.id}` : "/api/projects", values); if (created.id) { selectedProjectId = created.id; localStorage.setItem("apix.selectedProject", created.id); } await refresh(); } catch (error) { toast(error.message); return; } }
  else if (editing.kind === "employee") { try { values.enabled = values.enabled === "true"; if (!values.runtime) values.runtime = data.employees.find((item) => item.id === editing.id)?.runtime ?? editing.id; await api(data.employees.some((item) => item.id === editing.id) ? `/api/employees/${editing.id}` : "/api/employees", values); await refresh(); } catch (error) { toast(error.message); return; } }
  else if (editing.kind === "department") { try { await api(`/api/departments/${editing.id}`, values); await refresh(); } catch (error) { toast(error.message); return; } }
  else if (editing.kind === "plan-task") { try { await api(`/api/tasks/${editing.id}/revise`, values); await refresh(); toast("步骤已修改，请重新审批"); } catch (error) { toast(error.message); return; } }
  else if (editing.kind === "conversation") { try { await api(`/api/conversations/${editing.id}`, values); await refresh(); } catch (error) { toast(error.message); return; } }
  else if (editing.kind === "memory") { try { const current = data.memories.find((item) => item.id === editing.id); await api(`/api/memories/${editing.id}`, { ...values, version: current.version }); memoryResults = null; await refresh(); } catch (error) { toast(error.message); return; } }
  else if (editing.kind === "resume") { try { const created = await api(`/api/tasks/${editing.id}/resume`, values); const previous = data.tasks.find((item) => item.id === editing.id); selectedProjectId = previous.project_id; selectedConversationId = created.conversationId; selectedTaskId = created.taskId; localStorage.setItem("apix.selectedProject", selectedProjectId); await refresh(); go("workspace"); toast("续接任务已创建，请审查启动审批"); } catch (error) { toast(error.message); return; } }
  else { settings[editing.kind === "skill" ? "skills" : "mcps"].push({ id: crypto.randomUUID(), ...values, enabled: false }); saveSettings(); renderSettings(); toast("配置已保存；尚未连接 Agent 运行时"); }
  $("#editor-dialog").close();
});
$("#model-form").addEventListener("submit", (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const id = crypto.randomUUID(); settings.models.push({ id, ...values }); settings.selectedModelId = id; saveSettings(); event.currentTarget.reset(); renderSettings(); toast("模型偏好已保存；Agent 运行模型由其自身配置决定"); });
$("#sidebar-add-project").addEventListener("click", () => openEditor("project"));
$("#add-project").addEventListener("click", () => openEditor("project"));
$("#add-skill").addEventListener("click", () => openEditor("skill"));
$("#add-mcp").addEventListener("click", () => openEditor("mcp"));
$("#add-employee").addEventListener("click", () => openEditor("employee"));
$("#scan-agents").addEventListener("click", async () => { try { await api("/api/runtimes/scan", {}); await refresh(); toast("已重新扫描本机 Agent"); } catch (error) { toast(error.message); } });
$("#dialog-close").addEventListener("click", () => $("#editor-dialog").close());
$("#task-details-close").addEventListener("click", () => $("#task-details-dialog").close());
$("#dialog-cancel").addEventListener("click", () => $("#editor-dialog").close());
$("#brand-home").addEventListener("click", () => go("assistant"));
$("#top-model-button").addEventListener("click", () => { go("coordinator"); document.dispatchEvent(new Event("apix:manager-settings")); });
$("#workspace-project-button").addEventListener("click", () => go("projects"));
$("#talk-to-director").addEventListener("click", () => go("director"));
$("#new-conversation").addEventListener("click", () => { go("coordinator"); document.dispatchEvent(new Event("apix:new-chat")); });
$("#open-about").addEventListener("click", () => toast("ApiX Agent OS · 本地任务与运行数据保存在 SQLite"));
$("#director-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (directorSending) return;
  if (!selectedProjectId) { toast("请先选择项目"); go("projects"); return; }
  const content = $("#director-chat-input").value.trim();
  if (!content) return;
  directorSending = true;
  $("#director-chat-form button").disabled = true;
  try { $("#director-chat-input").value = ""; const pending = api("/api/director/messages", { projectId: selectedProjectId, content }); await refresh(); const result = await pending; renderedProposalKey = null; await refresh(); toast(result.mode === "pi" ? result.proposalId ? "ApiX 已生成可编辑提案" : "ApiX 已回复" : "规则草案已生成，请检查 Pi 配置"); }
  catch (error) { $("#director-chat-input").value = content; toast(error.message); }
  finally { directorSending = false; $("#director-chat-form button").disabled = false; }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "director-proposal-form") return;
  event.preventDefault();
  try { const { id, ...values } = directorProposalValues(); const created = await api(`/api/director/proposals/${id}/approve`, values); renderedProposalKey = null; await refresh(); toast(`协作计划 ${created.planId.slice(0, 8)} 已创建，请逐项审批`); } catch (error) { toast(error.message); }
});
document.addEventListener("click", async (event) => {
  if (event.target.id !== "save-director-proposal") return;
  try { const { id, ...values } = directorProposalValues(); await api(`/api/director/proposals/${id}`, values); renderedProposalKey = null; await refresh(); toast("提案修改已保存"); } catch (error) { toast(error.message); }
});
$("#profile-form").addEventListener("submit", async (event) => { event.preventDefault(); if (!selectedProjectId) { toast("请先选择项目"); return; } try { const profile = data.profiles.find((item) => item.project_id === selectedProjectId); await api(`/api/projects/${selectedProjectId}/profile`, { ...Object.fromEntries(new FormData(event.currentTarget)), version: profile?.version ?? 0 }); profileLoadedProjectId = null; await refresh(); toast("项目档案已保存"); } catch (error) { toast(error.message); } });
$("#memory-scope").addEventListener("change", (event) => { $("#memory-task-field").classList.toggle("hidden", event.target.value !== "task"); $("#memory-task-select").required = event.target.value === "task"; });
$("#memory-form").addEventListener("submit", async (event) => { event.preventDefault(); if (!selectedProjectId) { toast("请先选择项目"); return; } try { const values = Object.fromEntries(new FormData(event.currentTarget)); await api("/api/memories", { ...values, projectId: selectedProjectId, taskId: values.scope === "task" ? values.taskId : null }); event.currentTarget.reset(); $("#memory-task-field").classList.add("hidden"); $("#memory-task-select").required = false; memoryResults = null; await refresh(); toast("记忆已保存"); } catch (error) { toast(error.message); } });
$("#memory-search-form").addEventListener("submit", async (event) => { event.preventDefault(); if (!selectedProjectId) return; const query = $("#memory-search-input").value.trim(); if (!query) { memoryResults = null; renderMemory(); return; } try { memoryResults = await api(`/api/memories/search?projectId=${encodeURIComponent(selectedProjectId)}&q=${encodeURIComponent(query)}`); renderMemory(); } catch (error) { toast(error.message); } });
$("#memory-clear-search").addEventListener("click", () => { $("#memory-search-input").value = ""; memoryResults = null; renderMemory(); });

$("#page-director").insertAdjacentHTML("beforeend", `<section class="section-block"><div class="block-header"><div><h2>团队与仓库</h2><p>经理是可追溯的员工岗位；每个计划步骤可指定部门与独立 Git 仓库。</p></div></div><div class="collab-grid"><form id="department-form" class="surface-card stacked-form"><h3>注册部门经理</h3><label>部门名称<input name="name" required maxlength="100" placeholder="例如：研发部"></label><label>经理员工<select name="managerId" id="manager-select" required></select></label><button class="primary-button">保存部门</button></form><form id="repository-form" class="surface-card stacked-form"><h3>添加关联仓库</h3><label>仓库名称<input name="name" required maxlength="100"></label><label>Git 根目录<input name="path" required placeholder="绝对路径"></label><button class="primary-button">添加到当前项目</button></form></div><div id="team-list" class="collab-list"></div></section>
<section class="section-block"><div class="block-header"><div><h2>Workflow Packs</h2><p>配置按版本保存；已创建的计划固定引用具体版本。</p></div></div><div class="collab-grid"><form id="pack-form" class="surface-card stacked-form"><h3>发布 Pack 版本</h3><label>标识<input name="id" required pattern="[a-z0-9-]{2,60}" placeholder="development"></label><label>名称<input name="name" required maxlength="100"></label><label>步骤 JSON<textarea name="steps" required placeholder='[{"prompt":"分析：{goal}","dependsOn":[]},{"prompt":"实现：{goal}","dependsOn":[0]}]'></textarea></label><button class="primary-button">保存新版本</button></form><div id="pack-list" class="surface-card"></div></div></section>
<section class="section-block"><div class="block-header"><div><h2>多 Agent 协作计划</h2><p>选择 Pack 后，为每步指派员工和仓库。前序索引形成 DAG，无依赖步骤可以并行。</p></div></div><form id="collab-plan-form" class="surface-card stacked-form"><label>目标<textarea name="goal" required maxlength="20000"></textarea></label><label>Workflow Pack<select id="collab-pack-select" required></select></label><div id="pack-step-assignments" class="assignment-grid"></div><button class="primary-button">生成可审查协作计划</button></form></section>
<section class="section-block"><div class="block-header"><div><h2>评审会议与共享交付物</h2><p>两位以上员工分别执行评审任务；结果和来源保存在计划中。</p></div></div><form id="meeting-form" class="surface-card stacked-form"><label>计划<select id="meeting-plan-select" required></select></label><label>来源任务<select id="meeting-source-select" required></select></label><label>议题<input name="topic" required maxlength="500"></label><div id="meeting-reviewers" class="reviewer-list"></div><button class="primary-button">建立评审会议</button></form><div id="meeting-list" class="collab-list"></div></section>
<section class="section-block"><div class="block-header"><div><h2>Worktree 集成审查</h2><p>先在独立工作区应用每个已验收任务的差异，检测冲突；明确批准后才写入源仓库工作区。</p></div></div><form id="integration-form" class="surface-card stacked-form"><label>计划<select id="integration-plan-select" required></select></label><label>仓库<select id="integration-repository-select"></select></label><button class="primary-button">生成集成预检</button></form><div id="integration-list" class="collab-list"></div></section>`);
$("#page-director").insertAdjacentHTML("beforeend", `<section class="section-block"><div class="block-header"><div><h2>经理验收</h2><p>由部门经理读取本部门已验收的共享交付物，形成独立审查记录。</p></div></div><form id="manager-review-form" class="surface-card stacked-form"><label>计划<select id="manager-plan-select" required></select></label><label>部门<select id="manager-department-select" required></select></label><button class="primary-button">创建经理审查任务</button></form></section>`);

const packCache = new Map();
let lastAssignmentProjectId = null;
let reviewerSignature = null;
function setSelect(selector, items, placeholder, valueOf, labelOf) {
  const select = $(selector); const old = select.value;
  const markup = `<option value="">${escapeHtml(placeholder)}</option>` + items.map((item) => `<option value="${escapeHtml(valueOf(item))}">${escapeHtml(labelOf(item))}</option>`).join("");
  if (select.innerHTML !== markup) select.innerHTML = markup;
  if (items.some((item) => String(valueOf(item)) === old)) select.value = old;
}
async function showPackSteps() {
  const id = $("#collab-pack-select").value;
  if (!id) { $("#pack-step-assignments").innerHTML = ""; return; }
  try {
    if (!packCache.has(id)) packCache.set(id, await api(`/api/packs/${id}`));
    const pack = packCache.get(id);
    const employees = data.employees.filter((item) => item.enabled && data.runtimes.some((runtime) => runtime.id === item.runtime && runtime.available));
    $("#pack-step-assignments").innerHTML = pack.definition.steps.map((step, index) => `<div class="assignment-row"><strong>${index + 1}. ${escapeHtml(step.prompt)}</strong><small>依赖：${step.dependsOn.length ? step.dependsOn.map((value) => value + 1).join("、") : "无，可并行"}</small><label>员工<select data-step-employee="${index}" required>${employees.map((employee) => `<option value="${employee.id}">${escapeHtml(employee.name)} · ${escapeHtml(employee.role)}</option>`).join("")}</select></label><label>部门<select data-step-department="${index}"><option value="">未指定</option>${data.departments.map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("")}</select></label><label>仓库<select data-step-repository="${index}"><option value="">项目主仓库</option>${data.repositories.filter((repository) => repository.project_id === selectedProjectId).map((repository) => `<option value="${repository.id}">${escapeHtml(repository.name)}</option>`).join("")}</select></label></div>`).join("");
  } catch (error) { toast(error.message); }
}
function renderCollaboration() {
  setSelect("#manager-select", data.employees.filter((item) => item.enabled), "选择经理员工", (item) => item.id, (item) => `${item.name} · ${item.role}`);
  const projectRepositories = data.repositories.filter((item) => item.project_id === selectedProjectId);
  $("#team-list").innerHTML = [...data.departments.map((item) => `<div class="collab-line"><strong>${escapeHtml(item.name)}</strong><span>经理：${escapeHtml(item.manager_name)}</span><button class="text-action" data-edit-department="${item.id}">更换经理</button></div>`), ...projectRepositories.map((item) => `<div class="collab-line"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.path)}</span></div>`)].join("") || `<div class="empty-card">暂无部门或附加仓库。</div>`;
  $("#pack-list").innerHTML = `<h3>已发布版本</h3>` + (data.packs.map((item) => `<div class="collab-line"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.id)} · v${item.version}</span></div>`).join("") || `<p>暂无 Pack。</p>`);
  const latestPacks = data.packs.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  const previousPack = $("#collab-pack-select").value;
  setSelect("#collab-pack-select", latestPacks, "选择 Pack", (item) => item.id, (item) => `${item.name} · v${item.version}`);
  if (!$("#collab-pack-select").value && latestPacks.length) $("#collab-pack-select").value = latestPacks[0].id;
  if ($("#collab-pack-select").value !== previousPack || selectedProjectId !== lastAssignmentProjectId || !$("#pack-step-assignments").children.length) { lastAssignmentProjectId = selectedProjectId; showPackSteps(); }
  const planItems = data.plans.filter((item) => item.project_id === selectedProjectId);
  setSelect("#meeting-plan-select", planItems, "选择计划", (item) => item.id, (item) => item.goal.slice(0, 70));
  setSelect("#integration-plan-select", planItems, "选择计划", (item) => item.id, (item) => item.goal.slice(0, 70));
  setSelect("#manager-plan-select", planItems, "选择计划", (item) => item.id, (item) => item.goal.slice(0, 70));
  setSelect("#manager-department-select", data.departments, "选择部门", (item) => item.id, (item) => item.name);
  const sourcePlan = $("#meeting-plan-select").value;
  setSelect("#meeting-source-select", data.tasks.filter((item) => item.plan_id === sourcePlan && !data.meetingItems.some((entry) => entry.task_id === item.id)), "选择来源任务", (item) => item.id, (item) => item.prompt.slice(0, 80));
  const availableReviewers = data.employees.filter((item) => item.enabled);
  const nextReviewerSignature = availableReviewers.map((item) => `${item.id}:${item.name}:${item.role}`).join("|");
  if (nextReviewerSignature !== reviewerSignature) {
    const checked = new Set($$("#meeting-reviewers input:checked").map((item) => item.value));
    $("#meeting-reviewers").innerHTML = `<strong>评审员工（至少两位）</strong>` + availableReviewers.map((item) => `<label><input type="checkbox" value="${item.id}" ${checked.has(item.id) ? "checked" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.role)}</label>`).join("");
    reviewerSignature = nextReviewerSignature;
  }
  setSelect("#integration-repository-select", projectRepositories, "项目主仓库", (item) => item.id, (item) => item.name);
  const expandedArtifacts = new Set($$("#meeting-list details[open]").map((item) => item.dataset.artifactTask));
  $("#meeting-list").innerHTML = data.meetings.filter((item) => planItems.some((plan) => plan.id === item.plan_id)).map((item) => {
    const tasks = data.meetingItems.filter((entry) => entry.meeting_id === item.id).map((entry) => data.tasks.find((task) => task.id === entry.task_id)).filter(Boolean);
    return `<div class="collab-line"><strong>${escapeHtml(item.topic)}</strong><span>${escapeHtml(labels[item.derived_status] ?? item.derived_status)} · ${tasks.map((task) => `${escapeHtml(task.employee_name)}：${escapeHtml(labels[task.status] ?? task.status)}`).join(" · ")}</span>${tasks.map((task) => { const artifact = data.sharedArtifacts.find((entry) => entry.task_id === task.id); return artifact ? `<details class="mission-result" data-artifact-task="${task.id}" ${expandedArtifacts.has(task.id) ? "open" : ""}><summary>${escapeHtml(task.employee_name)} 的评审成果</summary><pre>${escapeHtml(artifact.content)}</pre></details>` : ""; }).join("")}</div>`;
  }).join("") || `<div class="empty-card">尚无评审会议。</div>`;
  $("#integration-list").innerHTML = data.integrations.filter((item) => planItems.some((plan) => plan.id === item.plan_id)).map((item) => { const report = JSON.parse(item.report); return `<div class="collab-line"><strong>${escapeHtml(item.repository_path)}</strong><span>${escapeHtml(item.status)} · ${report.changedFiles.map(escapeHtml).join("、") || "无文件变更"}</span>${report.conflicts.map((conflict) => `<p class="conflict">任务 ${escapeHtml(conflict.taskId.slice(0, 8))}：${escapeHtml(conflict.reason)}</p>`).join("")}${item.status === "ready" ? `<button class="primary-button" data-apply-integration="${item.id}">批准写入源仓库</button>` : ""}</div>`; }).join("") || `<div class="empty-card">尚无集成预检。</div>`;
}
$("#collab-pack-select").addEventListener("change", showPackSteps);
$("#meeting-plan-select").addEventListener("change", renderCollaboration);
$("#department-form").addEventListener("submit", async (event) => { event.preventDefault(); await mutate("/api/departments", Object.fromEntries(new FormData(event.currentTarget))); event.currentTarget.reset(); });
$("#repository-form").addEventListener("submit", async (event) => { event.preventDefault(); await mutate("/api/repositories", { ...Object.fromEntries(new FormData(event.currentTarget)), projectId: selectedProjectId }); event.currentTarget.reset(); });
$("#pack-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const values = Object.fromEntries(new FormData(event.currentTarget)); await api("/api/packs", { id: values.id, name: values.name, steps: JSON.parse(values.steps) }); packCache.delete(values.id); event.currentTarget.reset(); await refresh(); if ($("#collab-pack-select").value === values.id) await showPackSteps(); toast("Pack 新版本已发布"); } catch (error) { toast(error.message); } });
$("#collab-plan-form").addEventListener("submit", async (event) => { event.preventDefault(); try { if (!selectedProjectId) throw new Error("请先选择项目"); const packId = $("#collab-pack-select").value; const pack = packCache.get(packId); if (!pack) throw new Error("请先选择 Pack"); const steps = pack.definition.steps.map((step, index) => ({ ...step, employeeId: $(`[data-step-employee="${index}"]`).value, departmentId: $(`[data-step-department="${index}"]`).value || null, repositoryId: $(`[data-step-repository="${index}"]`).value || null })); await api("/api/collaboration/plans", { projectId: selectedProjectId, goal: event.currentTarget.elements.goal.value, packId, packVersion: pack.version, steps }); event.currentTarget.elements.goal.value = ""; await refresh(); toast("协作计划已创建，请逐项审批"); } catch (error) { toast(error.message); } });
$("#meeting-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const reviewerIds = $$("#meeting-reviewers input:checked").map((item) => item.value); await api("/api/meetings", { planId: $("#meeting-plan-select").value, sourceTaskId: $("#meeting-source-select").value, topic: event.currentTarget.elements.topic.value, reviewerIds }); event.currentTarget.elements.topic.value = ""; await refresh(); toast("评审任务已创建，请审批启动"); } catch (error) { toast(error.message); } });
$("#integration-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const result = await api("/api/integrations", { planId: $("#integration-plan-select").value, repositoryId: $("#integration-repository-select").value || null }); await refresh(); toast(result.status === "conflict" ? "发现冲突，请查看报告" : "集成预检已生成"); } catch (error) { toast(error.message); } });
$("#manager-review-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/manager-reviews", { planId: $("#manager-plan-select").value, departmentId: $("#manager-department-select").value }); await refresh(); toast("经理审查任务已创建，请审批启动"); } catch (error) { toast(error.message); } });
$("#page-missions").insertAdjacentHTML("beforeend", `<section class="section-block"><div class="block-header"><div><h2>Agent 消息监督</h2><p>Director 可查看消息、关联交付物、超时重试与拦截记录。</p></div><span id="mailbox-summary" class="count-label"></span></div><div id="agent-message-list" class="collab-list"></div></section><section class="section-block"><div class="block-header"><div><h2>资源锁</h2><p>锁使用租约，到期后可重新获取；请核对仍在运行的 Agent。</p></div></div><div id="agent-lock-list" class="collab-list"></div></section>`);
document.addEventListener("click", async (event) => {
  const rejected = event.target.closest("[data-reject-message]");
  if (rejected) { if (await confirmAction("拦截 Agent 消息", "该消息将停止投递，并记录 Director 的拦截决定。")) await mutate(`/api/messages/${rejected.dataset.rejectMessage}/reject`, { agentId: "apix-director", reason: "Director 手动拦截" }); return; }
  const released = event.target.closest("[data-release-lock]");
  if (released && await confirmAction("释放资源锁", "先确认持有该锁的 Agent 不再使用该资源。")) await mutate(`/api/locks/${released.dataset.releaseLock}/release`, { agentId: "apix-director" });
});
// Keep saved browser preferences, but make the actual manager configuration the primary entry.
const modelPage=$("#page-models");
modelPage.querySelector('.page-intro h1').textContent='模型设置';
modelPage.querySelector('.page-intro p').textContent='配置 ApiX 管理者的真实推理连接；员工模型和登录仍由各自 CLI 配置。';
const modelArchive=document.createElement('details');modelArchive.className='preferences-archive';modelArchive.innerHTML='<summary>浏览器模型收藏（不影响执行）</summary>';
for(const child of [...modelPage.children])if(!child.classList.contains('page-intro'))modelArchive.append(child);
const modelEntry=document.createElement('section');modelEntry.className='surface-card model-runtime-entry';modelEntry.innerHTML='<h2>ApiX 推理模型</h2><p>在项目工作区配置模型、保存连接并进行显式费用批准的连接测试。模型收藏不会切换管理者或员工模型。</p><button class="primary-button" id="open-real-model-settings">配置真实模型连接</button>';
modelPage.append(modelEntry,modelArchive);
$('#open-real-model-settings').addEventListener('click',()=>{go('coordinator');document.dispatchEvent(new Event('apix:manager-settings'));});
const modelNav=document.querySelector('[data-page-target="models"]');modelNav.setAttribute('aria-label','模型设置');modelNav.querySelector('span').textContent='模型设置';
$('#page-resources .page-intro p').textContent='下方仅保存浏览器草稿。默认对话循环会发现项目 .apix/skills、.claude/skills、.agents/skills 和用户 ~/.apix/skills 并按需加载；MCP 开关尚不连接运行时。';
go("assistant");
refresh();
setInterval(refresh, 1500);

document.addEventListener("apix:select-project", async (event) => { selectedProjectId = event.detail; localStorage.setItem("apix.selectedProject", selectedProjectId); await refresh(); });
