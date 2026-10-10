# ApiX Agent OS
## 个人 AI 员工管理中心 · 产品需求与系统架构设计文档

**文档版本：** v1.1<br>
**项目代号：** ApiX Agent OS<br>
**产品定位：** Local-first AI Agent Management & Orchestration Platform<br>
**设计阶段：** 产品定义与技术方案<br>
**核心参考：** Claw-Empire、Paperclip、Superset、AgentBro、agent-deck、Agent of Empires、OpenHands Agent Canvas、Pi

---

# 01. 项目概述

## 1.1 产品愿景

**让每一位用户，都拥有一支由 AI Agent 组成、能够自主协作、受统一管理的数字员工团队。**

未来的个人电脑不应该只是运行各种 AI Agent 的容器，而应该成为一个具有组织结构、分工机制、工作记忆和执行能力的数字办公室。

目前，用户可能同时安装：

- Claude Code：代码实现与调试。
- Codex：代码开发、审查、测试。
- Pi：可扩展 Agent 及自定义工作流。
- OpenCode：多模型开发任务。
- Gemini CLI：代码与研究工作。
- OpenClaw：消息、自动化和外部服务。
- 其他本地、远程、自建 Agent。

这些 Agent 各自拥有不同的模型、工具、会话、能力和运行方式，却缺乏统一的组织与管理关系。

ApiX Agent OS 的目标是将这些独立 Agent 纳入一个共同的管理体系，使它们成为可以被发现、调度、协作、监督、审计和持续改进的数字员工。

## 1.2 核心产品隐喻

ApiX 采用“虚拟公司”的组织模型：

| 虚拟公司概念 | ApiX 中的含义 |
|---|---|
| CEO | 用户，拥有最终决策权 |
| 总监 Director | ApiX 的中央智能管理 Agent |
| 部门经理 | 负责专业领域任务拆分和协调的 Agent |
| 员工 Employee | Claude Code、Codex、Pi 等具体执行者 |
| 部门 Department | 具有共同技能与职责的 Agent 分组 |
| 项目 Project | 面向具体目标的持续工作空间 |
| 任务 Task | 可追踪、可分配、可验收的工作单元 |
| 会议 Meeting | 多个 Agent 参与的结构化协作过程 |
| 办公室 Office | Agent 工作状态的可视化界面 |
| 档案室 Memory | 工作历史、知识、决策与经验的持久化系统 |
| 财务 Budget | Token、API 费用、执行时间等资源约束 |

该组织结构是逻辑关系，不意味着每个经理都必须运行一个独立的 LLM 实例。

## 1.3 产品定位

ApiX 不应成为另一个大而全的 Agent 框架。

它的核心定位是：

**Agent Control Plane + Agent Organization System + Personal AI Workspace**

即：

1. 管理现有 Agent，而不是替代它们。
2. 组织多个 Agent，而不是只有单一聊天窗口。
3. 管理任务全生命周期，而不是只发出 Prompt。
4. 保留组织记忆，而不是每次重新开始。
5. 让用户掌握执行权、预算和最终审批权。

## 1.4 产品原则

### 原则一：Local-first

默认在用户电脑上运行，核心信息本地存储。

在没有云端账号的情况下，用户仍应能够管理已经安装的 Agent。

### 原则二：Bring Your Own Agent

用户可以复用现有 Agent、已有订阅、配置和环境。

不强制迁移到 ApiX 自研 Agent Runtime。

### 原则三：Agent 能力与岗位分离

一个 Agent Runtime 不等同于一个岗位。

例如，同一个 Codex Runtime 可以被注册为“后端工程师”和“代码审查员”两个逻辑员工，但它们应拥有不同的配置、权限、工作区和任务队列。

### 原则四：Human-in-Control

用户可以随时查看任务，并对 ApiX 托管且支持相应能力的任务执行暂停、中止、调整或接管。外部独立启动的会话只能提供其接口允许的操作。

涉及敏感操作时，用户始终拥有最终决策权。

### 原则五：可解释、可追踪、可恢复

每次重要调度必须记录原因，每次高风险操作必须留下审计记录，每个长任务都应有明确的恢复策略。

### 原则六：渐进式自主

系统的自主程度根据用户授权和任务风险逐步提升。

默认不应由 ApiX 在未经授权的情况下启动新 Agent 执行任意 Shell 命令或访问私人文件。对不受 ApiX 管理的外部进程，界面不能暗示 ApiX 已限制其权限。

---

# 02. 目标用户与应用场景

## 2.1 目标用户

### 个人开发者

希望将 Claude Code、Codex、Pi、OpenCode 等工具统一管理，减少多个终端之间的切换。

### 技术负责人

希望将一个开发目标交给 ApiX，由多个 Agent 分别负责研发、测试、审核和文档。

### 内容创作者

希望将选题、研究、文案、设计、审核分配给不同的 Agent。

### 研究人员

希望多个 Agent 分别负责资料收集、观点验证、数据处理和报告生成。

### 高级自动化用户

希望将电脑上的工具和 Agent 组合成具有连续执行能力的工作系统。

## 2.2 典型使用场景

### 场景 A：开发一个软件功能

用户输入：

“给我的网站增加账号注册和登录功能。”

ApiX 执行：

1. 总监识别当前项目、目标、约束与风险。
2. 研发经理将目标拆成设计、实现、测试任务。
3. Pi 分析已有代码结构。
4. Codex 实现后端认证逻辑。
5. Claude Code 实现前端页面。
6. 测试 Agent 执行测试并生成结果。
7. 审查 Agent 检查差异和安全性。
8. 总监汇总成果，向用户申请合并确认。

用户无需逐一打开各个 Agent。

### 场景 B：市场研究

用户输入：

“研究全球 AI Coding Agent 的市场竞争情况，形成一份报告。”

ApiX 可以组建临时团队：

- Research Agent：收集资料。
- Analyst Agent：比较产品。
- Verification Agent：核验事实和出处。
- Writer Agent：生成报告。
- Reviewer Agent：审核内容。

最终提供一份可以追溯到研究任务和原始来源的报告。

### 场景 C：监控后台任务

用户正在使用其他软件。

ApiX 可以在后台管理已经授权的长任务。

当 Agent 等待工具权限、需要用户回答问题、执行失败或完成任务时，通过桌面通知提醒用户。

若 Runtime 提供可靠的审批或输入接口，用户可以直接通过通知中心处理；否则通知应引导用户回到原生终端。

### 场景 D：长期软件项目

用户创建“ApiX 产品研发”项目。

系统长期保留：

- 产品目标与要求。
- 当前架构决策。
- 已完成工作。
- 已知问题。
- 任务依赖。
- 重要设计文件。
- Agent 工作历史。

下次继续时，ApiX 根据项目状态恢复工作，而不是仅依赖一次聊天中的上下文。

---

# 03. 产品总体结构

## 3.1 四层组织架构

```text
┌────────────────────────────────────┐
│              用户 CEO              │
│     设定目标 / 审批 / 监督 / 接管    │
└─────────────────┬──────────────────┘
                  │
┌─────────────────▼──────────────────┐
│         ApiX Director             │
│                                    │
│  目标理解 / 任务规划 / 资源调度       │
│  风险控制 / 进度管理 / 结果验收       │
└─────────────────┬──────────────────┘
                  │
┌─────────────────▼──────────────────┐
│          Department Layer          │
│                                    │
│ 开发经理 │ 研究经理 │ 创作经理       │
│ 测试经理 │ 自动化经理 │ 自定义部门    │
└─────────────────┬──────────────────┘
                  │
┌─────────────────▼──────────────────┐
│            Agent Pool              │
│                                    │
│ Claude Code │ Codex │ Pi           │
│ OpenCode │ Gemini CLI │ OpenClaw    │
│ Custom Agent │ Remote Agent        │
└─────────────────┬──────────────────┘
                  │
┌─────────────────▼──────────────────┐
│        Execution Environments      │
│                                    │
│ 本地进程 / Git Worktree / 容器       │
│ SSH 远程机器 / 外部 Agent API        │
└────────────────────────────────────┘
```

## 3.2 Director 的核心职责

Director 是 ApiX 的决策与管理核心，但不是所有任务的直接执行者。

职责包括：

- 理解用户的目标和限制。
- 判断任务属于哪个工作领域。
- 拆分工作并创建依赖关系。
- 从可用 Agent 中选择执行者。
- 决定何时让 Agent 并行工作。
- 管理预算和执行时限。
- 处理阻塞、失败和资源冲突。
- 协调跨部门工作。
- 向用户汇报进展。
- 请求必要审批。
- 对最终交付结果负责。

Director 不应直接拥有无限制的系统操作权限。

实际文件操作、外部命令执行以及敏感资源访问，应通过权限受控的执行服务完成。

## 3.3 部门经理的设计

部门经理采用两种运行形态：

**规则型经理**：通过预设的任务模板、策略和条件完成分配，不消耗额外 LLM 推理。

**智能型经理**：运行专门的 LLM Agent，能够动态拆分任务、审查结果和协调员工。

默认优先使用规则型经理，以降低延迟、成本和系统复杂度。

只有遇到具有显著不确定性或需要复杂协调的任务时，才启动智能型经理。

## 3.4 Agent 员工模型

每个员工由三个层次构成：

**逻辑员工 = Runtime + Role Profile + Execution Policy**

- Runtime：实际运行的 Claude Code、Pi、Codex 等。
- Role Profile：职务、技能、专业领域、工作偏好。
- Execution Policy：可用工具、工作区、预算、网络与文件权限。

一个逻辑员工可产生多个 Run，每个 Run 再关联一个实际进程或原生会话。这样可以避免将“Agent 产品名称”、岗位配置与运行实例混为一谈。

---

# 04. 交互设计与核心页面

## 4.1 首页：CEO 办公桌

借鉴 Claw-Empire 的办公室概念，但不要将所有功能强制绑定到像素场景中。

首页需要同时提供两种视图。

### 沉浸式办公室

显示员工角色、所在部门、工作动画与状态。

例如：

- 员工坐在工位：正在执行任务。
- 员工在会议室：正在参加协作会话。
- 员工显示问号：等待用户回复。
- 工位有错误标记：任务执行失败。
- 员工离开工位：空闲或休眠。

### 专业管理仪表盘

显示明确的工作信息：

- 活跃 Agent 数量。
- 当前运行任务。
- 等待审批事项。
- 失败或阻塞任务。
- 今日成本和 Token 使用。
- 最近完成的交付物。

两个视图共享同一个状态模型。

**办公室负责直观感知，仪表盘负责专业管理。**

## 4.2 Director 对话中心

核心输入方式类似聊天，但输出应包括可操作的结构化结果。

例如：

用户：“帮我把网站做成支持多语言。”

ApiX 回复一份执行提案：

**目标：** 增加国际化支持。

**建议团队：** 前端工程师、内容翻译 Agent、测试 Agent。

**预计任务：** 语言资源抽取、界面改造、翻译、测试。

**需要确认：** 支持哪些语言、是否允许修改已有页面结构。

用户可以选择：

- 批准执行。
- 修改计划。
- 指定 Agent。
- 调整预算。
- 仅生成计划。

大部分日常任务不应反复追问。

系统可以先完成低风险的项目分析，再对必要的高风险或不可逆操作申请审批。

## 4.3 虚拟办公室

办公室采用可选的像素或简洁 2D 风格。

员工状态必须由真实运行事件驱动，而不是仅由随机动画模拟。

建议状态：

| 状态 | 办公室表现 |
|---|---|
| Idle | 待命 |
| Running | 工作中 |
| Thinking | 思考动画 |
| Waiting for Approval | 等待批准 |
| Blocked | 阻塞提示 |
| Failed | 故障提示 |
| Paused | 暂停 |
| Offline | 离线 |

点击员工打开详情页，显示：

- 当前任务。
- 执行历史。
- 使用的模型或 Provider。
- 能力和权限。
- Token 与费用统计。
- 实时终端或事件流。
- 暂停、恢复和停止操作。

暂停、恢复和停止按钮仅在当前 Adapter 与 Run 均支持时显示。不可观测的 Agent 状态必须标记为“未知”，不能伪装成可靠实时状态。

## 4.4 任务看板

建议默认六列：

1. Inbox：待分析。
2. Planned：已规划。
3. Ready：可执行。
4. In Progress：执行中。
5. Review：等待验收。
6. Done：已完成。

Blocked、Failed、Cancelled 作为附加状态，支持独立筛选。

任务卡片包含：

- 标题、负责人、优先级。
- 所属项目和部门。
- 前置依赖。
- 执行时长。
- 预算和消耗。
- 交付物。
- 当前阻塞原因。

支持拖拽管理，但拖拽后的状态变更必须经过后端规则校验。

## 4.5 Agent 人事管理

功能包括：

- 自动发现已安装 Agent。
- 注册与解除注册。
- 创建逻辑员工。
- 设置部门和职务。
- 配置模型与运行方式。
- 分配工作区。
- 配置预算与权限。
- 管理 Skills 和 MCP。
- 查看健康状态。
- 导入、导出员工配置。

高级功能可以包括员工能力评估和专业评分。

但不建议仅凭 LLM 自评或任务数量生成绩效排名。

## 4.6 会议室

会议不是多个 Agent 无限制地互相聊天。

会议应该有：

- 明确议题。
- 参与人员。
- 最大轮数。
- 时间和 Token 预算。
- 决策规则。
- 结果格式。

会议分为：

**规划会议**：生成执行计划。

**技术讨论**：比较不同方案。

**冲突解决**：处理多个 Agent 的不一致意见。

**审查会议**：核对结果与验收标准。

**复盘会议**：总结失败原因及可复用经验。

建议会议结束后生成结构化决议：

```json
{
  "topic": "Authentication Architecture",
  "decision": "Use session-based authentication",
  "participants": [
    "backend-lead",
    "security-reviewer"
  ],
  "openQuestions": [],
  "actionItems": [
    "Implement authentication",
    "Add security tests"
  ]
}
```

这份决议可以直接转化成任务和项目记忆。

---

# 05. 系统技术架构

## 5.1 设计目标

ApiX 应在本地单机运行时保持简单，同时预留未来扩展到多设备和远程执行环境的能力。

建议采用：

**Desktop Application + Local Control Plane + Agent Adapters + Event-driven Orchestrator**

系统分为五个核心部分：

```text
┌─────────────────────────────────────────┐
│              ApiX Desktop               │
│ Dashboard / Office / Chat / Kanban      │
└────────────────────┬────────────────────┘
                     │ IPC / Local API
┌────────────────────▼────────────────────┐
│            ApiX Control Plane           │
│                                         │
│ Director / Planning / Task Scheduler    │
│ Agent Registry / Policy / Budget        │
│ Approval / Memory / Event Router        │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│           Agent Adapter Layer           │
│                                         │
│ Pi / Claude / Codex / OpenCode          │
│ OpenClaw / Generic CLI / Custom API     │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│            Execution Layer              │
│                                         │
│ Process Supervisor / Workspace Manager  │
│ Sandboxed Runner / Remote Connector     │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│             Persistence                 │
│                                         │
│ SQLite / FTS / Artifact Storage         │
│ Vector Index / Event Log                │
└─────────────────────────────────────────┘
```

前端只展示和操作状态，不应成为任务执行的权威来源。

任务执行、审批、资源控制和持久化由本地 Control Plane 统一管理。

## 5.2 推荐技术栈

| 模块 | 建议技术 |
|---|---|
| Desktop | Tauri 2 |
| Frontend | React + TypeScript |
| UI Components | Tailwind CSS + shadcn/ui |
| State Management | Zustand + TanStack Query |
| Visual Office | PixiJS |
| Core Services | TypeScript / Node.js |
| Agent Integration | SDK、RPC、CLI、Hooks |
| Database | SQLite |
| Full-text Search | SQLite FTS5 |
| Vector Search | 可选 sqlite-vec 或外部向量数据库 |
| Realtime | IPC + 本地事件流 |
| Background Jobs | 持久化任务队列 |
| Monitoring | OpenTelemetry 兼容事件和日志 |
| Testing | Vitest、Playwright、集成测试 |

这一技术栈是目标方案，不代表现有 ApiX 已具备上述组件。桌面容器选型应在本地服务与 Windows 打包验证后确定，不以迁移到 Tauri 作为核心闭环的前置条件。

## 5.3 现有工程基础与迁移路径

截至本版文档，仓库可确认的工程基础与缺口如下：

| 领域 | 当前状态 | 首步工作 |
|---|---|---|
| Agent Runtime | TypeScript 多包工程包含 Pi Coding Agent、SDK 和 RPC 接口 | 先用 Pi RPC/SDK 验证托管运行、事件与会话能力 |
| 本地服务 | `packages/server` 是实验性的 Session 路由组件，现有示例采用 Unix Socket | 验证 Windows 可用的本地传输、进程生命周期和客户端认证；不要直接视为 Agent OS 后端 |
| Web 工作台 | `web/` 是无前端构建依赖的交互原型，数据保存在浏览器 `localStorage`；聊天和操作轨迹为演示 | 接入真实本地服务，区分演示数据与真实 Run，并逐步迁移配置数据 |
| 任务持久化 | Agent OS 的 Task/Run/Approval/Artifact 数据库尚未落地 | 建立 SQLite Schema、迁移、事件重放与恢复机制 |
| 桌面交付 | 现有工作台尚未形成 Agent OS 桌面发行包 | 在闭环验证后比较 Web + 本地服务、Tauri 与其他封装方案的 Windows 打包成本 |

推荐顺序：**复用 Pi 接口 → 本地 Control Plane 与 SQLite → 接入第二个 Runtime → 接通 Web 工作台 → 再选择桌面容器**。不要先重写 Pi 核心或将演示页面当作已经具备真实管理能力的产品。

## 5.4 进程与模块划分

建议至少划分以下逻辑服务：

- `apix-desktop`：桌面界面。
- `apix-core`：业务状态和服务接口。
- `apix-director`：规划、路由、监督。
- `apix-agent-registry`：Agent 发现和注册。
- `apix-adapters`：各 Agent Runtime 适配器。
- `apix-executor`：进程及工作区管理。
- `apix-memory`：项目知识与记忆检索。
- `apix-policy`：权限、预算、审批。
- `apix-events`：事件与审计。
- `apix-workflows`：Workflow Packs。

早期可以采用模块化单体，不必直接拆成微服务。

真正需要独立进程隔离的部分主要是 Agent 运行器、不可信工具和可能阻塞的外部进程。

---

# 06. Agent 接入体系

这是 ApiX 的核心技术壁垒。

## 6.1 Agent Registry

系统启动或用户主动扫描时，Agent Registry 收集本地环境信息：

- 已安装的 CLI。
- 执行文件路径。
- 版本号。
- 可用 Provider。
- 支持的运行参数。
- 发现的配置位置。
- 可访问的会话元数据。
- 可用的 MCP 与 Skills。
- 受支持的事件 Hook。

发现过程默认只读。

任何更改 Agent 配置、安装 Hook 或操作会话的行为，都需要用户授权。

## 6.2 接入级别

不能假设所有 Agent 提供相同的控制能力。

建议定义五个展示级别。

| 级别 | 能力 | 说明 |
|---|---|---|
| L0 | Discover | 发现安装情况 |
| L1 | Launch | 启动新任务 |
| L2 | Observe | 接收执行事件和状态 |
| L3 | Control | 发送后续输入、暂停或中止 |
| L4 | Resume | 恢复支持的历史会话 |

具体能力应通过 Capability Flags 声明，等级只用于概览，不应被当成严格包含关系。每项能力还应标明适用范围：ApiX 启动的新 Run、可导入的原生会话，或只能观察的外部进程。

例如某 Agent 可能支持恢复但不支持精细工具进度事件。

## 6.3 Adapter 接口

建议采用统一接口：

```ts
interface AgentAdapter {
  id: string;
  displayName: string;

  discover(): Promise<DiscoveredAgent[]>;
  probe(employee: AgentEmployee): Promise<AgentCapabilities>;
  start(request: AgentRunRequest): Promise<AgentRunHandle>;
  attach?(run: PersistedRun): Promise<AgentRunHandle | null>;
  observe(handle: AgentRunHandle, cursor?: string): AsyncIterable<AgentEvent>;
  sendInput?(handle: AgentRunHandle, input: AgentInput): Promise<void>;
  cancel?(handle: AgentRunHandle): Promise<CancelResult>;
  resume?(sessionId: string, request: AgentRunRequest): Promise<AgentRunHandle>;
  getUsage?(handle: AgentRunHandle): Promise<UsageReport>;
}
```

上述接口是 ApiX 拟设计的协议，而不是某个第三方 Agent 的现成 SDK。

`AgentRunRequest` 应包含由 Control Plane 预先分配的 `runId`、项目/任务/员工标识、工作区、策略快照和幂等键。`AgentRunHandle` 至少返回 `runId`、原生 `sessionId`（如有）、进程身份及启动时间；这些字段必须持久化，以便重启后尝试 `attach()`，避免将同名新进程误认为旧 Run。

`observe()` 的 `cursor` 表示可重放位置；不支持重放的 Adapter 必须显式声明事件可能缺失。`cancel()` 的结果须区分“已请求取消”“已确认停止”和“无法确认”。`sendInput()`、`cancel()`、`resume()`、`attach()` 都是可选能力，UI 根据探测结果和当前 Run 的来源显示操作。

Control Plane 在调用有外部副作用的 `start()` 前先持久化 Run 意图；启动后的进程/会话标识及首批事件再与该 Run 绑定。崩溃后若启动结果不明，先查找并核对原生会话，不能盲目重复启动。

## 6.4 优先支持的 Runtime

### 第一批（Pi 必选，Claude Code 与 Codex 先按接口可行性选择其一）

**Pi**

使用官方 SDK 或 RPC。

优点是对 Session、工具、运行事件具有较清晰的可编程接口，适合验证完整的 Agent 管理链路。

**Claude Code**

优先通过公开支持的 SDK、CLI 或 Hook 接口实现任务启动和事件接收。

**Codex**

优先使用公开的 SDK、CLI、结构化输出或可用协议集成。

Agent Client Protocol（ACP）可作为兼容 Agent 与 ApiX 客户端之间的接入路径，用于会话、消息、工具调用等交互；它不是发现或控制电脑上所有已有 Agent 的通用系统协议。MCP 主要连接 Agent 与工具，也不能代替 Agent 管理适配器。具体能力仍以安装版本和端到端验证为准。

### 第二批

- OpenCode。
- Gemini CLI。
- OpenClaw。
- Generic CLI Adapter。

Generic CLI Adapter 只保证基本进程启动和可观测能力，不应默认承诺能恢复或控制所有终端会话。

### 第三批

- 远程 SSH Agent。
- 自定义 HTTP Agent。
- 其他 Desktop Agent。
- 第三方插件适配器。

## 6.5 运行实例与逻辑员工分离

同一 Runtime 可以提供多个员工配置。

例如：

```text
Runtime: Codex CLI
    |
    +-- Employee: Backend Engineer
    |      Workspace: backend/
    |      Policy: development
    |
    +-- Employee: Code Reviewer
           Workspace: read-only
           Policy: review
```

即使两个员工使用相同底层 CLI，也必须在任务身份和执行会话方面隔离。工作区和权限能否强制隔离，取决于托管启动方式与执行环境，不能仅凭两份逻辑员工配置保证。

## 6.6 原生会话接管的限制

ApiX 需要区分：

- 由 ApiX 启动的 Agent 会话。
- 在外部终端中启动的 Agent 会话。
- 可被 Hook 观测的外部会话。
- 无法控制但能检测到的进程。

不应通过向不受控的终端窗口模拟按键，作为默认会话接管方案。

对于不支持官方外部控制的 Agent，应提供“查看”和“在 ApiX 中启动新会话”等替代选项。

---

# 07. 任务调度与工作流

## 7.1 任务数据结构

```ts
interface Task {
  id: string;
  projectId: string;

  title: string;
  description: string;

  status: TaskStatus;
  priority: number;

  assigneeId?: string; // 逻辑员工 ID，而非 Runtime 或进程 ID
  parentTaskId?: string;

  dependencies: string[];

  acceptanceCriteria: string[];
  artifactIds: string[];

  budget?: TaskBudget;
  approvalPolicyId?: string;

  createdAt: string;
  updatedAt: string;
}
```

## 7.2 标准任务生命周期

```text
Inbox
  |
  v
Planned
  |
  v
Ready
  |
  v
Assigned
  |
  v
Running
  |
  +----> Blocked ----> Ready
  |
  +----> Failed -----> Retry / Replan
  |
  v
Review
  |
  +----> Changes Requested ---> Ready
  |
  v
Done
```

Cancelled 可以从允许取消的状态进入，但任务取消与底层 Run 停止是两件事：只有执行器确认停止或退出后，UI 才能显示“运行已停止”；无法确认时保留“取消结果未知”。

每次状态变化应记录操作者、时间、原因、关联执行记录和版本号。

## 7.3 调度算法

Director 不应在每次分配任务时，仅凭一句 Prompt 随机选择 Agent。

建议采用：

**候选过滤 → 规则评分 → 可选 LLM 判断 → 调度执行**

候选过滤考虑：

- Agent 是否在线。
- 是否具备任务要求的能力。
- 是否有工作区访问权限。
- 是否满足安全策略。
- 是否具有足够预算。
- 是否存在并发冲突。

候选评分可以定义为：

\[
Score(a,t)=
w_1 C+
w_2 R+
w_3 A+
w_4 H-
w_5 K-
w_6 Q
\]

其中：

- C：能力匹配。
- R：历史任务可靠性。
- A：当前可用程度。
- H：领域经验。
- K：预计成本。
- Q：排队时间或工作负载。

各项指标须先归一化，权重应可配置，历史评分应基于真实任务和验证结果。样本不足时以明确的能力匹配与用户指定优先级代替历史评分，不生成看似精确的排名。

对于难以确定的候选，再由 Director 使用 LLM 进行语义判断。

## 7.4 并行调度

任务通过 DAG（有向无环依赖图）组织。

例如：

```text
功能需求
  |
  +-- 数据模型设计
  |        |
  |        +-- 后端实现 --+
  |                      |
  +-- UI 设计 ------------+--> 联调
                                 |
                                 v
                              QA 测试
                                 |
                                 v
                              用户验收
```

无相互依赖的任务可以并行运行。

调度器需要限制：

- 全局并发数。
- 每个 Runtime 的并发数。
- 单个项目并发数。
- CPU、内存和预算。
- 工作区写入锁。
- 外部 API Rate Limit。

## 7.5 任务租约与恢复

任务被分配时创建执行租约。

执行器在运行期间周期性更新租约及执行状态。

若执行器崩溃或失联：

1. 将执行记录标记为未知或失联。
2. 检查是否仍存在实际进程。
3. 读取已持久化的执行信息。
4. 判断任务是否具有重试安全性。
5. 尝试恢复受支持的会话，或请求用户介入。

**Heartbeat 只能证明执行器最近存活，不能证明任务已经成功。**

对于可能产生副作用的操作，不能在状态不明时自动重复执行。

## 7.6 任务验收

完成任务不能只依赖执行 Agent 自己声明成功。

建议设置三种验收方式：

**自动验收**

适合测试通过、文件存在、Schema 校验等明确条件。

**Agent 交叉验收**

由另一个 Agent 审核代码、文档或研究结果。

**人工验收**

适合合并代码、发布内容、发送邮件、付款等有显著影响的操作。

可采用：

`Execution Result → Verification → Review → Acceptance`

---

# 08. 工作流 Packs

借鉴 Claw-Empire 的 Workflow Packs，将不同任务领域组织成独立工作模板。

Pack 不只是 Prompt 模板，而应包含：

- 推荐部门结构。
- 可使用的 Agent 岗位。
- 工作流程。
- 任务分解规则。
- 验收标准。
- 交付物类型。
- 预算策略。
- 权限建议。

## 8.1 Development Pack

部门：

- 产品规划。
- 软件架构。
- 前端。
- 后端。
- 测试。
- 安全审查。

默认交付：

- 代码差异。
- 测试报告。
- 变更说明。
- 审查结论。

## 8.2 Research Pack

部门：

- 资料采集。
- 数据分析。
- 事实核验。
- 报告编写。
- 审阅。

默认交付：

- 研究报告。
- 来源清单。
- 证据表。
- 不确定性说明。

## 8.3 Content Pack

部门：

- 创意策划。
- 资料研究。
- 文案。
- 视觉。
- 审稿。

默认交付：

- 成品内容。
- 修改历史。
- 素材清单。
- 风格一致性检查。

## 8.4 Automation Pack

部门：

- 工作流设计。
- 自动化执行。
- 数据处理。
- 监控。
- 异常处理。

默认交付：

- 执行结果。
- 任务日志。
- 异常报告。

## 8.5 自定义 Packs

用户可以创建自己的部门、员工岗位、流程和工具配置。

后续支持通过 Manifest 导入、导出和分享。

建议 Pack 配置采用版本化 JSON 或 YAML Schema，避免把流程逻辑写死在前端组件中。

---

# 09. 记忆与知识系统

长期记忆是 ApiX 区别于普通 Agent Launcher 的关键能力。

## 9.1 四类记忆

### Session Memory

保存 Agent 原始会话与运行引用。

由各自的 Runtime 或 ApiX 记录。

保留原始工具调用、输入输出以及会话标识。

### Task Memory

保存任务目标、结果、错误、审批、交付物和重要过程。

Task Memory 不应只是完整聊天记录，而是具有结构化字段、可追踪来源的工作记录。

### Project Memory

保存长期项目知识：

- 项目架构。
- 约束。
- 技术选型。
- 用户确认的偏好。
- 决策记录。
- 已知风险。

### Organization Memory

保存跨项目通用信息：

- Agent 技能和能力。
- 工作流模板。
- 经验证的最佳实践。
- 部门规则。
- 已批准的组织配置。

## 9.2 记忆写入

```text
Agent Run Completed
        |
        v
Event / Output Collection
        |
        v
Fact & Decision Extraction
        |
        v
Validation & Provenance
        |
        v
Deduplication / Conflict Check
        |
        v
Memory Store
```

并不是所有聊天内容都应该成为长期记忆。

优先存储：

- 用户明确确认的事实和偏好。
- 有来源依据的重要决策。
- 可以复用的项目知识。
- 已验证的任务经验。

敏感信息、临时内容和未经验证的推断默认不应写入全局长期记忆。

## 9.3 记忆检索

```text
New Task
   |
   v
Identify Scope
   |
   v
Search Project / Task Memory
   |
   v
Permission Filter
   |
   v
Relevance Ranking
   |
   v
Context Assembly
   |
   v
Agent Execution
```

检索应结合：

- 关键词。
- 语义相似度。
- 项目归属。
- 时间新鲜度。
- 来源可信度。
- 用户权限。

初期使用 SQLite FTS5 已能满足大量场景。

向量索引可作为后续增强，而非 MVP 的硬性依赖。

## 9.4 记忆冲突与遗忘

当记忆出现冲突时，不直接覆盖旧值。

需要保存：

- 当前值。
- 原始来源。
- 创建时间。
- 更新依据。
- 可信度。
- 生效范围。

用户需要能够查看、纠正或删除持久化记忆。

删除请求还必须覆盖摘要、索引和派生副本，避免表面删除后仍然通过检索恢复。

## 9.5 共享记忆与隔离

默认：

- 同任务 Agent 可以访问任务允许的共享上下文。
- 同项目 Agent 可以访问该项目授权的知识。
- 跨项目记忆需要权限检查。
- 用户私人信息不能因为 Agent 同属于一个“部门”就自动共享。

不同 Agent 的原生历史不必被同步成一份共同聊天记录。

ApiX 应负责提供授权后的上下文视图，而不是粗暴地复制全部会话。

---

# 10. 工作区与文件系统

## 10.1 工作空间设计

建议区分：

- Project Root：原始项目。
- Agent Workspace：某个 Agent 可操作的目录。
- Task Workspace：具体任务的隔离工作区。
- Artifact Store：结果文件存储。

## 10.2 Git 项目

对于会修改代码的并行任务，建议先为每个任务创建独立 Git Worktree，再允许并行写入。

```text
projects/
    +-- main-project/             # 主工作区
    +-- task-auth-backend/        # 独立 worktree
    +-- task-auth-frontend/       # 独立 worktree
    +-- task-auth-tests/          # 独立 worktree
```

各 Agent 在隔离工作区中工作。

完成后通过差异审查和验证，再合并回主分支。

## 10.3 非 Git 项目

对普通文档、设计和数据任务采用任务目录或受控副本。

不要假设所有任务都适合 Git Worktree。

## 10.4 合并策略

- 不直接让多个 Agent 同时改写同一个文件。
- 检查冲突。
- 运行验收测试。
- 显示可审查的 Diff。
- 对受保护分支合并请求用户批准。

对于无法自动合并的结果，应创建冲突处理任务，而不是静默覆盖文件。

---

# 11. 权限、安全与审批

## 11.1 安全目标

ApiX 将成为用户电脑上多个高权限 Agent 的控制中心。

因此，需要比普通聊天应用更加严格的执行安全策略。

**Director 的规划权限不应自动转化为操作系统执行权限。**

## 11.2 权限类型

建议使用能力授权机制：

| 权限 | 示例 |
|---|---|
| File Read | 读取指定目录 |
| File Write | 修改指定项目 |
| Shell Execute | 执行允许的命令 |
| Network Access | 访问指定域名 |
| Git Operation | 创建分支、提交、合并 |
| Credential Use | 使用指定凭证 |
| External Action | 发邮件、发布、支付 |
| Agent Management | 启动、停止或修改员工 |

每项权限记录授权主体、范围、有效期和审批要求。

权限保证按接入方式分三级：

| 接入方式 | ApiX 能保证的行为 | 界面必须说明的限制 |
|---|---|---|
| 发现/观察外部 Agent | 读取可获得的元数据或事件 | 无法撤销外部进程原有的文件、网络和凭证权限 |
| ApiX 托管启动 Agent | 控制启动参数、工作目录、进程生命周期和 ApiX 自身的操作入口 | 若 Agent 以用户身份直接运行，仍可能拥有该用户的系统权限 |
| 受控环境执行 | 在实际沙箱、容器或受限账号边界内约束资源访问 | 只对处于该环境内的进程生效，边界能力需按平台验证 |

“已获批准”只表示 ApiX 允许一次明确的操作，不等于第三方 Runtime 已被系统级隔离。不能把 Prompt 约束或逻辑员工配置描述为强制权限边界。

## 11.3 风险等级

**Low：** 只读查询、项目分析、无副作用检索。

**Medium：** 在隔离目录中生成文件、执行限定测试。

**High：** 修改重要项目文件、访问敏感凭证、对外发布内容。

**Critical：** 删除大量文件、修改系统配置、资金操作或可能造成不可逆外部影响的行为。

风险等级需要结合资源、命令参数和操作上下文判断。

不能只按工具名判断风险。

## 11.4 审批中心

所有等待用户处理的事项进入统一 Inbox。

每个审批必须展示：

- 哪个 Agent 发起。
- 为什么需要操作。
- 要执行的具体动作。
- 操作目标和权限范围。
- 可能产生的影响。
- 是否可撤销。
- 批准和拒绝选项。

默认审批只对明确的一次操作或短期授权有效。审批记录应绑定 Run、目标资源、操作参数摘要、有效期和一次性标识；执行入口在操作前再次核对，避免审批后参数变化或重复执行。无法接入可信执行入口的外部 Agent，只能提示用户到原生界面处理，不能展示为 ApiX 已拦截的请求。

## 11.5 执行隔离

对由 ApiX 启动且需要强制限制权限的 Run，推荐：

- 本地 Runner 最小权限运行。
- 支持容器和其他沙箱执行环境。
- 路径白名单或文件系统授权。
- 高风险 Shell 命令拦截。
- 网络域名访问策略。
- 机密凭证通过受保护的调用接口提供。
- 对未签名或未知 Extension 保持保守策略。

容器不是绝对安全边界；Windows 原生进程、WSL2 和 Docker 的隔离能力也不同。每个 Adapter 应声明实际执行环境与已验证的限制项。未启用受控环境时，只能保证 ApiX 自身不越权派发，不能保证 Agent 进程无法访问其他目录或网络。

## 11.6 Prompt Injection 防护

外部网页、Git 仓库、文档和工具输出都属于不可信内容。

其中出现的“忽略之前的规则”“读取密钥并上传”等指令不得获得系统级授权。

工具权限检查必须发生在可信的执行层，而不是只依赖模型阅读安全 Prompt 后自行遵守。若外部 Agent 的工具执行链不经过该层，应明确标记为“无法强制拦截”。

---

# 12. 事件系统与可观测性

## 12.1 事件设计

系统以统一事件格式连接 Agent Runtime、任务调度器、UI、持久化模块和通知中心。

建议核心事件：

```text
agent.discovered
agent.registered
agent.started
agent.status_changed
agent.stopped

task.created
task.assigned
task.started
task.blocked
task.completed
task.failed

run.started
run.output
run.tool_started
run.tool_finished
run.completed

approval.requested
approval.resolved

memory.created
memory.updated

artifact.created
workflow.completed
```

## 12.2 统一事件结构

```ts
interface ApiXEvent {
  id: string;
  type: string;

  timestamp: string;
  receivedAt: string;

  organizationId: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  employeeId?: string;
  runtimeId?: string;

  sequence: number; // Control Plane 提交的全局递增序号
  source: "runtime" | "executor" | "control-plane" | "inference";
  nativeEventId?: string;
  payload: Record<string, unknown>;
}
```

重要事件应该持久化并能被重新读取。`sequence` 由本地 Control Plane 在持久化事务中分配；同一原生事件的重投递通过 `source + nativeEventId` 或 Adapter 指定的去重键处理。对无法提供稳定原生 ID 的来源，需要保存去重策略及其局限。

UI 连接中断后，应先读取快照，再按全局序号补齐遗漏事件；若历史已被清理，应显式返回最早可读序号和“有缺口”标记，不能伪装成连续实时轨迹。

## 12.3 状态来源

运行状态（如 Running、Waiting、Failed、Unknown）与状态依据分别建模：

- **Observed**：从 Agent 或执行器实际收到，记录来源和最后观测时间。
- **Inferred**：根据进程、文件或超时推测，记录推断规则及有效期。
- **Unavailable**：没有可靠信号，状态显示为 Unknown。

UI 必须能够区分状态及其可信程度。失去观测后不能无限期保留旧的 Running 状态。

## 12.4 指标系统

建议监控：

- 任务成功率。
- 从提交到完成的延迟。
- Agent 执行时长。
- 工具错误率。
- 任务重试次数。
- 审批等待时长。
- 预算消耗。
- 同时运行 Agent 数。
- 上下文压缩次数。
- 任务恢复成功率。

每项指标应明确其计算口径，避免把 Agent 自称成功误计为通过验证的成功。

---

# 13. 数据库设计

初期采用 SQLite。

建议主要实体包括：

| 表 | 核心字段 |
|---|---|
| `agent_runtimes` | id、adapter_id、executable_path、version、discovery_source、capabilities |
| `employees` | id、runtime_id、display_name、role、department_id、policy、configuration |
| `departments` | id、name、manager_id |
| `projects` | id、name、root_path、status |
| `tasks` | id、project_id、status、assignee、priority |
| `task_dependencies` | task_id、dependency_id |
| `agent_runs` | id、task_id、employee_id、adapter_id、native_session_id、process_identity、origin、status、idempotency_key |
| `run_events` | id、run_id、sequence、source、native_event_id、type、payload |
| `approvals` | id、run_id、action、target、parameter_hash、expires_at、status、resolution |
| `artifacts` | id、task_id、path、type、checksum |
| `memories` | id、scope、content、source、version |
| `workflow_packs` | id、name、version、definition |
| `budgets` | id、scope、limit、period |
| `usage_records` | run_id、provider、tokens、estimated_cost |
| `audit_logs` | id、actor、action、target、timestamp |

涉及任务、Run、审批和事件的更新需要事务保证一致性。

重要外部操作还应使用幂等标识，避免客户端重试导致重复提交。适配器无法提供幂等保证时，重启恢复必须先核对外部会话或把结果标为未知，禁止自动重试有副作用的动作。

## 13.1 状态与执行记录分离

一个 Task 可以拥有多个 Run。

例如：

```text
Task: 实现登录接口
    |
    +-- Run 1: 执行失败
    |
    +-- Run 2: 修复错误
    |
    +-- Run 3: 测试通过
```

不能仅通过修改 Task 当前状态覆盖掉历史执行。

## 13.2 数据迁移

数据库表必须使用显式 Schema Version 和迁移脚本。

不允许新版本启动时直接重建用户数据库。

升级前应备份关键数据，并对迁移失败提供回滚机制。

---

# 14. 服务 API 与通信协议

## 14.1 桌面内部 API

建议定义与传输层无关的服务接口，方便以后从 IPC 切换到 HTTP 或远程 RPC。

核心接口：

```text
runtimes.discover
runtimes.list
runtimes.probe

employees.list
employees.register
employees.updatePolicy

projects.create
projects.list
projects.get

tasks.create
tasks.assign
tasks.cancel
tasks.retry

runs.start
runs.observe
runs.cancel
runs.resume

approvals.list
approvals.resolve

memories.search
memories.create
memories.delete

director.plan
director.executePlan
director.replan
```

## 14.2 远程服务接口

后续开放远程控制时可采用：

```text
GET    /api/runtimes
POST   /api/runtimes/discover
GET    /api/employees
POST   /api/employees
POST   /api/employees/{id}/runs

GET    /api/tasks
POST   /api/tasks
PATCH  /api/tasks/{id}

POST   /api/runs/{id}/cancel

GET    /api/approvals
POST   /api/approvals/{id}/resolve

GET    /api/events
```

事件流可以通过 WebSocket 或 SSE 提供。

无论使用何种通信方式，认证、授权、幂等与状态版本检查都必须由服务端执行。

---

# 15. Director 的内部架构

Director 不应该只是一个拥有全部工具的超大型 LLM Agent。

建议将其拆成可独立验证的模块。

```text
User Goal
    |
    v
Intent & Context Analyzer
    |
    v
Planning Engine
    |
    v
Policy Validation
    |
    v
Agent Matcher
    |
    v
Task Scheduler
    |
    v
Execution Supervisor
    |
    v
Result Verifier
    |
    v
Reporting & Memory
```

## 15.1 Intent Analyzer

识别：

- 用户真正希望达成的结果。
- 工作领域。
- 项目上下文。
- 必要输入。
- 风险级别。
- 预期交付物。

## 15.2 Planning Engine

产出结构化计划：

```ts
interface ExecutionPlan {
  goal: string;

  tasks: TaskProposal[];

  dependencies: Dependency[];

  requiredCapabilities: string[];

  budgetEstimate?: BudgetEstimate;

  risks: string[];

  approvalRequirements: string[];
}
```

## 15.3 Policy Validation

在调度前检查：

- 计划是否满足用户权限。
- 是否存在循环依赖。
- 预算是否超限。
- 是否需要人工批准。
- 是否涉及未经授权的工作目录。

## 15.4 Execution Supervisor

维护任务执行状态。

在超时、失败或阻塞时执行确定性处理。

只有需要重新理解目标或制定新方案时，才再次调用 LLM。

## 15.5 Result Verifier

通过测试、Schema、文件检查、交叉审查或用户审批来验证成果。

不能把模型生成的总结本身当成验收证据。

## 15.6 Director 的自主等级

提供三个模式：

**Manual**

每个任务计划由用户批准后执行。

**Assisted**

系统可以自动执行低风险任务，关键步骤请求批准。

**Autonomous**

在用户指定的工作区、预算、工具范围和时间限制内自动执行。

即使处于 Autonomous 模式，超出授权范围的操作也必须重新审批。

---

# 16. 用户体验细节

## 16.1 统一收件箱

所有需要用户注意的事件进入一个入口：

- Agent 等待回复。
- 工具请求授权。
- 任务阻塞。
- 代码等待合并。
- 预算即将耗尽。
- 任务完成等待验收。

支持通知合并与优先级排序，减少频繁打断。

## 16.2 员工卡片

展示：

- 名称和头像。
- 职务、部门。
- Runtime。
- 当前状态。
- 当前任务。
- 能力标签。
- 最近任务成功率。
- 最近资源消耗。

支持打开原生 Agent 会话或终端，但必须考虑具体 Runtime 的能力限制。

## 16.3 Agent 能力雷达

可以将 Agent 的可用能力按维度展示：

- 编码。
- 调试。
- 研究。
- 文档。
- 工具使用。
- 长任务稳定性。

分数应来自实际基准任务、人工评价或经过验证的任务记录。

早期没有足够数据时，应显示“样本不足”。

## 16.4 费用面板

提供以下维度：

- 每个 Agent 的费用。
- 每个项目的费用。
- 每个任务的费用。
- 每个 Provider 的费用。
- 总预算和剩余预算。

对于通过固定订阅使用的 Agent，应显示“订阅内使用”或“费用未知”，不要将它强行计算为精确 API 费用。

---

# 17. 实施路线图

各阶段按可验证能力划分，不预设工期。Phase 0 是技术验证，Phase 1 对应首个可发布的 P0；Phase 2 对应 P1。后续阶段按真实用户需求调整。

## Phase 0：技术预研

**目标：验证 ApiX 能否可靠接入并管理外部 Agent。**

任务：

- 完成第 5.3 节所列现有代码、Windows 本地传输与打包约束的验证。
- 实现 Agent Registry 原型。
- 接入 Pi SDK/RPC。
- 接入一个主流 CLI Agent。
- 验证运行事件采集。
- 对每个 Adapter 分别验证取消、重连和原生会话恢复，并记录不支持项。
- 验证本地持久化。

交付物：

- Agent Adapter API v0。
- 两个可工作的 Adapter。
- 基础真实运行面板，不混用演示轨迹。
- 接入能力与限制清单。

验收：

能在 ApiX 内发现、启动、观察两个 Agent；重启后能识别旧 Run 或明确标记为未知；不能取消或恢复的能力在 UI 中如实显示。

## Phase 1：Agent Management MVP

**目标：管理多个本地 Agent。**

实现：

- Agent 扫描。
- 员工注册。
- 手动任务派发、项目选择和简单任务列表。
- 对受托管 Run 的真实状态、事件及操作能力展示。
- 本地 SQLite 的 Task/Run/事件/交付物记录和迁移。
- 对支持取消的受托管 Run 提供停止操作，并确认结果。
- 对 ApiX 控制的敏感执行入口实施单次审批。
- 基础结果验收和重启后的历史查看。

暂不引入复杂自动规划。

验收：

用户能够在一个界面完成两个 Agent 的启动、任务观察、停止受支持的 Run、查看可追溯结果；重启后记录仍在，无法控制的外部会话不会出现虚假的操作按钮。

## Phase 2：Director 与任务系统

**目标：从管理工具升级为真正的任务编排中心。**

实现：

- Director 对话。
- 结构化任务拆分。
- Agent 自动匹配。
- DAG 调度；并行写入前先建立独立工作区或 Worktree。
- Kanban。
- 任务审批。
- 失败处理。
- 自动验收基础能力。
- 基础预算与简单项目记忆。

验收：

一条用户目标能够被拆成可审查的任务计划，由两个以上 Agent 在不互相覆盖的工作区中完成，并留下验收证据。

## Phase 3：多 Agent 协作

**目标：实现完整虚拟团队体验。**

实现：

- 部门经理。
- 会议机制。
- 多 Agent 方案评审。
- 更复杂的 Worktree 合并和多仓库工作区。
- 共享交付物。
- 跨团队依赖治理与复杂冲突处理。
- Workflow Packs。

验收：

完成一个具有明确分工、并行执行、测试和成果审查的多 Agent 项目。

当前实现与操作说明见 [Phase 3 协作实现](./Phase%203%20协作实现.md)。

## Phase 4：记忆与长期工作

**目标：支持跨会话、跨任务的项目连续性。**

实现：

- Task Memory。
- Project Memory。
- 全文检索。
- 可选语义检索。
- 记忆编辑和删除。
- 结构化项目档案。
- 长任务恢复。

验收：

重启 ApiX 后，能够恢复任务状态、读取已有项目决策，并继续一个未完成的工作目标。

当前实现与操作说明见 [Phase 4 记忆与长期工作实现](./Phase%204%20记忆与长期工作实现.md)。

主 Agent 对话、可编辑协作提案和桌面 Agent 发现的当前实现见 [ApiX 主 Agent 与多 Agent 调度实现](./ApiX%20主%20Agent%20与多%20Agent%20调度实现.md)。

## Phase 5：远程与生态

**目标：从个人桌面系统扩展为多设备 Agent 管理平台。**

实现：

- SSH Agent。
- 远程 Agent Runner。
- Adapter 插件生态。
- Workflow Pack 分享。
- 远程状态同步。
- 多设备任务管理。
- 高级团队权限。

这部分不应成为 MVP 的必要前置条件。

---

# 18. MVP 范围控制

为了避免产品早期过于庞大，建议明确首个可发布版本的边界。

## P0：首个可发布版本，对应 Phase 1

- Windows 上可用的本地工作台与服务；桌面封装形式由技术验证确定。
- 基础 Agent 发现。
- Pi 和至少一种主流 Agent 集成。
- Agent 员工列表。
- 项目选择与手动任务启动。
- 带来源和可信度的事件、运行状态及历史。
- 简单任务列表与交付物查看。
- 本地 SQLite 持久化。
- 对支持取消的 ApiX 托管 Run 提供停止与结果确认。
- 对 ApiX 控制的敏感执行入口实施审批。
- 基础任务验收与重启后记录恢复。

## P1：第二阶段

- 多 Agent 自动分派。
- Director 单目标任务拆分、DAG 调度和重规划。
- 并行写入所需的工作区隔离与 Git Worktree。
- 简单项目记忆。
- 自动化成果验收。
- 基础预算系统。

## P2：体验增强

- 完整像素办公室。
- 会议动画。
- 员工升级系统。
- 能力雷达图。
- 排行榜。
- 多领域 Workflow Packs。

## P3：未来扩展

- 远程 Agent。
- 多设备同步。
- 插件市场。
- 高级长期记忆。
- 多用户与团队部署。

**优先保证真实执行和状态准确，再增强办公室沉浸感。**

---

# 19. 项目成功指标

## 19.1 产品指标

| 指标 | 初期目标 |
|---|---|
| 新用户完成首个 Agent 连接 | 5 分钟内 |
| 首个任务创建 | 3 次主要交互以内 |
| 基础运行状态准确性 | 不虚构不可观测状态 |
| 任务历史恢复 | 重启后可重建任务状态 |
| 权限审批可追溯 | 100% 记录 |
| 关键任务失败可见性 | 所有已检测失败均有明确状态 |
| 用户能够停止支持取消的 ApiX 托管 Run | 记录取消请求与实际停止结果，不将“已请求”当作“已停止” |

## 19.2 工程指标

- Agent 进程异常退出不会导致整个应用崩溃。
- 多任务并行运行时状态不互相覆盖。
- 重复的事件不会导致任务重复完成。
- 执行日志能关联到具体任务和 Run。
- 对声明为受控环境执行的 Run，验证其无法访问未授权工作区；对其他 Run 明确展示权限边界。
- 任务恢复后不会盲目重复不可逆操作。
- 数据库升级不会删除用户任务历史。

## 19.3 核心北极星指标

**每周由 ApiX 管理并通过验收的有效任务数量。**

相比 Agent 数量、会议次数或聊天轮数，这更能反映 ApiX 是否真正提升用户的工作能力。

---

# 20. 主要风险与解决策略

## 风险一：第三方 Agent 接口变化

**问题：** CLI 参数、Hook、会话格式和 SDK 版本可能改变。

**对策：** Adapter 独立版本管理、能力探测、兼容性测试以及降级支持。

## 风险二：过度 Agent 自主

**问题：** Director 可能错误理解目标、分配任务或重复执行。

**对策：** 结构化计划、授权边界、有限预算、明确验收和人工接管。

## 风险三：多个 Agent 冲突

**问题：** 并行修改文件可能互相覆盖。

**对策：** 独立工作区、文件锁、差异检查和合并审批。

## 风险四：Token 成本失控

**问题：** Agent 反复讨论、互相审查或陷入死循环。

**对策：** 最大执行轮次、任务预算、会议轮数限制、硬停止策略。

## 风险五：记忆污染

**问题：** 错误推断被持久化后影响后续任务。

**对策：** 来源记录、权限过滤、冲突检测、人工纠正与记忆版本管理。

## 风险六：界面好看但不实用

**问题：** 虚拟办公室可能带来额外维护成本，却无法帮助用户完成任务。

**对策：** 沉浸视图与专业管理视图并存，保证所有动画都对应真实状态。

## 风险七：本地高权限执行

**问题：** 统一管理中心可能扩大恶意工具或 Prompt Injection 的影响。

**对策：** 最小权限、独立执行环境、审批与审计、不可信输入隔离。

## 风险八：许可与第三方协议

**问题：** 各开源项目许可证不同，商业复用可能存在限制。

**对策：** 优先借鉴设计思想；复用代码前逐项核对 LICENSE、NOTICE、依赖许可证和使用条款。

---

# 21. 与参考项目的差异化战略

ApiX 不应简单地复制已有的虚拟公司产品。

先区分三类参考：本机会话管理、跨 Runtime 控制台、同框架多 Agent 编排。下表只比较官方资料可确认的产品定位；具体版本能力和 Windows 支持应在 Phase 0 复测。

| 参考项目 | 主要管理对象 | 可借鉴点 | 对 ApiX 的限制或启示 |
|---|---|---|---|
| [agent-deck](https://github.com/asheshgoplani/agent-deck) | 多种 CLI Agent 的会话 | TUI/Web、会话状态、MCP/Skills 管理，以及 conductor 监督会话 | 最接近“总监监督员工”；Windows 通过 WSL 使用，不能照搬为原生 Windows 方案 |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) | 多种编程 Agent 的持久会话 | 运行状态、终端、差异审查、工作区和 HTTP API | 依赖 tmux，Windows 通过 WSL2 使用 |
| [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) | 本地或远程 Agent 后端与会话 | 多后端控制台、ACP Agent、自动化 | Windows 提供 Docker 使用方案；应参考其后端边界，而非假设能接管任意外部进程 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 任务看板和编程 Agent 工作区 | 任务规划、差异审查、成果反馈 | [2026 年公告](https://vibekanban.com/blog/shutdown)称项目转为社区维护，适合借鉴交互而非依赖其服务路线 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | 在框架内定义的角色化 Agent | 角色、委派、流程与验收 | 更偏编排框架，不能直接替代本机 Agent Registry |

原文列出的项目仍可提供产品与工程参考：

### 来自 Claw-Empire

- CEO 与员工的角色关系。
- 可视化虚拟办公室。
- 部门协作。
- 会议。
- Workflow Packs。
- 任务看板。

### 来自 Paperclip

- 严格的组织和岗位模型。
- Heartbeat 和按需唤醒。
- 审批流程。
- 预算和任务治理。
- 审计记录。

### 来自 Superset

- 复用用户已有的 Agent。
- 统一工作区。
- CLI 启动和配置。
- 多会话运行管理。
- 远程开发思路。

### 来自 AgentBro

- 本地 Agent 发现。
- Hook 事件采集。
- 权限通知。
- Skills、MCP 和配置管理。
- SSH 远程会话。

### 来自 Pi

- 清晰的 Agent SDK/RPC 接入模式。
- 状态与事件流分离。
- Session 和上下文管理。
- 扩展驱动的工具能力。

## ApiX 自己要建立的核心差异

**第一，真正的 Agent 资产管理。**

用户现有的 Agent 可被发现并注册为逻辑员工；启动、观测、控制和接管能力按 Adapter 分别声明，不承诺任意进程都能被完整管理。

**第二，能力驱动的调度。**

根据 Agent 的实际能力、成本、权限和任务表现进行选择。

**第三，跨 Runtime 的统一任务生命周期。**

不论底层是 Pi、Claude Code 还是 Codex，都通过统一的 Task、Run、Approval 和 Artifact 模型管理。

**第四，独立于 Agent 的项目记忆。**

即使用户切换底层 Agent，项目目标、任务、决策和经验仍保留在 ApiX。

**第五，真实且透明的执行控制。**

优先建立可靠状态、分级权限保证、执行恢复和成果验收机制，并以 Windows 本机体验作为产品差异之一。

---

# 22. 最终产品形态

完整的 ApiX Agent OS 将包含五大空间：

### 1. CEO Office

用户与 Director 沟通目标、审查计划、管理重大决策。

### 2. Agent Company

查看部门、员工、能力、工作状态和组织关系。

### 3. Mission Control

查看所有任务、项目、执行记录、审批和运行情况。

### 4. Knowledge Center

管理项目知识、会话历史、决策和长期记忆。

### 5. System Center

管理 Agent Runtime、模型、Skills、MCP、配置、权限、预算和远程连接。

这五个空间应共享同一套 Agent Registry、任务数据库、执行事件和权限系统，而不是互相独立的数据孤岛。

---

# 23. 关键产品决策

为了避免后续开发方向摇摆，建议正式确立以下决策：

**ADR-001：ApiX 是 Agent 管理层，不替代现有 Runtime。**

**ADR-002：Agent Runtime、逻辑员工和执行实例必须分离。**

**ADR-003：Director 负责规划和管理，实际操作由受控执行器完成。**

**ADR-004：采用事件驱动的统一 Task/Run 状态模型。**

**ADR-005：默认 Local-first，远程管理作为独立扩展能力。**

**ADR-006：任务历史、Agent 原生会话和长期记忆分别存储。**

**ADR-007：只有经过可信执行入口或受控环境的操作才能声明强制权限控制；外部独立会话的限制必须明确展示。**

**ADR-008：优先实现 Agent 接入与任务可靠性，再建设复杂的像素动画。**

**ADR-009：Workflow Packs 使用版本化配置定义。**

**ADR-010：用户对 ApiX 托管任务拥有请求中止、记忆管理和最终审批权；实际中止结果须由 Adapter 或执行器确认。**

---

# 24. 建议的首个技术验证任务

正式进行大规模 UI 改造之前，先构建一个最小的 Agent 管理闭环。

**验证目标：**

用户在 ApiX 中输入：

“检查这个项目是否有明显的代码质量问题，并生成改进建议。”

期望流程：

1. ApiX 发现 Pi 和另一款已安装的 Agent。
2. 用户选择目标项目。
3. 用户在明确的两步任务模板中指定代码分析与结果审核；此阶段不依赖完整 Director 自动规划。
4. 第一个 Agent 在授权工作区执行分析。
5. ApiX 记录 Adapter 能提供的运行事件，并标记事件来源与缺口。
6. 第二个 Agent 审核分析结果。
7. ApiX 输出综合报告。
8. 用户可以查看每一步的执行历史和证据。
9. 关闭并重启 ApiX 后，任务与成果仍可读取；仅在 Adapter 支持且身份核对成功时恢复运行控制。

完成这个闭环后，再加入虚拟办公室、复杂会议、自动化长期记忆和更多 Agent。

这个验证将同时检验最难的几个技术问题：

- Runtime 接入是否可靠。
- Task/Run 模型是否合理。
- 多 Agent 协作是否真实可控。
- 执行事件是否完整。
- 本地持久化是否稳定。
- ApiX 托管运行与外部会话的权限边界是否被正确执行和展示。

---

# 25. 项目总结

ApiX Agent OS 希望建立的是一个超越单个 Agent 的个人智能工作系统。

用户不再需要关注每一项工作应该打开哪一个 AI 工具、在哪一个终端运行、由哪个模型完成。

用户只需要管理目标、资源和重要决策。

ApiX 则负责组织适当的 Agent、维护任务状态、协调执行、记录知识、控制风险，并提交可验证的成果。

**最终愿景：**

> 用户负责决定做什么；ApiX 负责组织谁来做、怎样协作以及如何验收；各个 Agent 负责在明确的权限和责任范围内完成工作。

ApiX 要成为用户个人电脑上 AI Agent 的真正管理中心，而不只是它们的启动器。

---

# 附录 A：参考开源项目

1. Claw-Empire<br>
   https://github.com/GreenSheep01201/claw-empire

2. Paperclip<br>
   https://github.com/paperclipai/paperclip

3. Superset<br>
   https://github.com/superset-sh/superset

4. AgentBro<br>
   https://github.com/shirenchuang/agentbro

5. Pi<br>
   https://github.com/earendil-works/pi

6. agent-deck<br>
   https://github.com/asheshgoplani/agent-deck

7. Agent of Empires<br>
   https://github.com/agent-of-empires/agent-of-empires

8. OpenHands Agent Canvas<br>
   https://github.com/OpenHands/OpenHands

9. Vibe Kanban<br>
   https://github.com/BloopAI/vibe-kanban

10. CrewAI<br>
    https://github.com/crewAIInc/crewAI

11. Agent Client Protocol<br>
    https://agentclientprotocol.com/get-started/introduction

# 附录 B：已确认基础与下一步工程验证

已确认的仓库事实见第 5.3 节。进入实现设计前，还需用最小原型验证：

- Pi RPC/SDK 与现有 Session、Provider、工具事件模型的映射。
- `packages/server` 在 Windows 上的传输替代、客户端认证和进程恢复方式。
- 第二个 Runtime 的公开接口、版本兼容与实际可用的取消/恢复能力。
- Web 原型配置迁移到本地服务后的数据格式和凭证存放边界。
- SQLite 驱动、Schema 迁移、事件重放和故障恢复。
- Windows 上的沙箱或受限执行方案，以及无法强制限制时的产品提示。
- 桌面封装、安装包与自动更新成本。

这些验证决定 ApiX Agent OS 应采用渐进式升级、模块追加，还是局部架构重构。每项结论应附可复现的测试场景与不支持能力清单。

**文档结束。**

---

# 附录 C：Phase 2 实现状态（ApiX Agent OS MVP）

当前 `codex/agent-os-mvp` 分支已实现 Phase 2 的首个可验证闭环：

- Director 页面接收目标，按确定性规则拆分为最多四个步骤，并根据员工岗位匹配执行者。
- 计划步骤写入 `plans`、`tasks`、`task_dependencies` 和 `approvals`；每一步仍需单次启动审批。
- DAG 调度器在前置任务完成后启动已批准的后置任务；前置失败、取消或状态未知会阻塞后续步骤。
- Git 项目计划任务创建 detached worktree，运行目录、状态和失败原因写入 `workspaces` 与事件表。非 Git 目录不会被伪装成隔离工作区，计划任务会拒绝启动。
- 任务详情接口可读取完整事件和交付物历史，不受工作台最近事件展示数量限制。

当前仍是确定性计划和单机调度，未实现 Director 的 LLM 自主重规划、并行写入冲突合并、复杂 DAG 编辑器和自动化成果验收。这些属于后续 Phase 2 增强项。
