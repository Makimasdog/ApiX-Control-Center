> 当前开发分支已改为独立 ApiX 模型 API 后端，Pi 与其他 CLI 同为可选员工。本文中旧版 Pi 管理者描述保留为历史记录；当前接口与迁移见[独立后端说明](../协作/独立ApiX推理后端架构与验收.md)。

# ApiX Control Center 项目 Wiki

> 本文是项目的完整知识库，随开发进展持续更新。  
> 当前对应分支：`codex/readiness-p0-p2`，基线提交 `93595d9` 已通过 PR #6 合入 `main`。  
> 最后更新：2026-10-14。自主交付的最新范围见 [模块契约](自主交付与模块契约.md)和[稳定交付修复与自审](../协作/稳定交付修复与自审.md)。

---

## 目录

1. [项目定位](#1-项目定位)
2. [快速开始](#2-快速开始)
3. [技术栈](#3-技术栈)
4. [整体架构](#4-整体架构)
5. [目录结构](#5-目录结构)
6. [核心模块详解](#6-核心模块详解)
7. [数据库模型](#7-数据库模型)
8. [HTTP API 参考](#8-http-api-参考)
9. [前端页面与组件](#9-前端页面与组件)
10. [Agent 运行时接入](#10-agent-运行时接入)
11. [权限与授权体系](#11-权限与授权体系)
12. [需求工程（五维模型）](#12-需求工程五维模型)
13. [调度、预算与并发](#13-调度预算与并发)
14. [规划会议](#14-规划会议)
15. [Mailbox 消息与执行监督](#15-mailbox-消息与执行监督)
16. [Git Worktree 与代码交接](#16-git-worktree-与代码交接)
17. [管理者模型配置](#17-管理者模型配置)
18. [测试体系](#18-测试体系)
19. [开发与提交规则](#19-开发与提交规则)
20. [多 Agent 协作历史](#20-多-agent-协作历史)
21. [已验证范围与已知限制](#21-已验证范围与已知限制)
22. [文档导航](#22-文档导航)

---

## 1. 项目定位

ApiX Control Center 是一个**面向本机项目的多 Agent 管理平台**。

**核心理念**：用户是决策者，ApiX 是管理者 Agent，AI 员工（Pi、Codex、Claude Code 等）是执行者。ApiX 不直接产出代码，而是与用户澄清需求、生成计划、分派任务、监督进度、收集交付物，让多个 AI 工具像真实团队一样协同工作。

ApiX 使用 Pi CLI 作为推理底座（管理者推理），但管理者与员工的身份、账户和权限严格隔离，互不共享。

**不是什么**：ApiX 不是又一个编码 Agent，不替代 Pi/Codex/Claude，也不提供面向公网的多用户服务。

---

## 2. 快速开始

### 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | ≥ 22.19.0（需内置 SQLite FTS5 支持） |
| Git | 已安装；非 Git 或尚无提交的项目使用托管输入快照 |
| Pi CLI | 管理者推理所需 |
| 执行员工 CLI | 至少一种（Pi、Codex、Claude Code 等） |

### 安装与启动

```powershell
git clone https://github.com/Makimasdog/ApiX-Control-Center.git
cd ApiX-Control-Center
npm ci
npm start          # 自动编译 TypeScript 后启动
```

服务默认监听 `http://127.0.0.1:4173/`。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 4173 |
| `APIX_DATA_DIR` | 数据目录，默认 `~/.apix-agent-os/` |
| `APIX_PI_ENTRY` | Pi CLI 入口路径 |
| `APIX_MANAGER_PI_ENTRY` | 单独覆盖管理者的 Pi 入口 |
| `APIX_CODEX_ENTRY` | Codex CLI 入口 |
| `APIX_CLAUDE_ENTRY` | Claude Code 入口 |
| `APIX_GEMINI_ENTRY` | Gemini CLI 入口 |
| `APIX_OPENCODE_ENTRY` | OpenCode 入口 |
| `APIX_KIMI_ENTRY` | Kimi Code 入口 |
| `APIX_LEGACY_API` | 设为 `1` 启用旧直接派发 API（兼容历史流程） |
| `ali_url` / `ali_api_key` / `ali_model_name` | 阿里百炼配置 |

`.env` 文件在项目根目录自动加载，进程已有的同名环境变量优先。密钥仅在本地填写，不提交。

### FTS5 检查

```powershell
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE probe USING fts5(content)'); db.close();"
```

---

## 3. 技术栈

| 层次 | 技术选型 |
| --- | --- |
| 界面 | 原生 HTML、CSS、JavaScript；严格 TypeScript 模块（编译到 `dist/`） |
| HTTP 服务 | Node.js 原生 `http` 模块（无 Express/Fastify） |
| 实时通信 | POST SSE（对话流）、独立 GET SSE（mailbox 事件流） |
| 数据库 | Node.js 内置 SQLite（`node:sqlite`），需 FTS5 |
| 进程管理 | Node.js `child_process`，托管 CLI 子进程 |
| 代码交付 | Git detached worktree + `commit-tree` 冻结 |
| 类型检查 | TypeScript 5.9，`tsconfig.json` 严格模式 |
| 测试 | Node.js Test Runner，隔离数据库，假 CLI |
| 契约校验 | Ajv 8.20.0、ajv-formats 3.0.1；默认 JSON Schema 2020-12，支持显式 draft-07 |
| CI | Windows GitHub Actions，Node.js 22.19.0 |
| 许可证 | MIT |

---

## 4. 整体架构

```
用户浏览器 (index.html / web/*.ts)
        │  HTTP + POST SSE
        ▼
    server.mjs                ← 本机 Host/Origin 校验、路由、JSON 校验
        │
        ▼
control-plane.mjs             ← SQLite 初始化/迁移、模块装配、进程托管
        │
   ┌────┴─────────────────────────────────┐
   │         src/ 核心业务逻辑            │
   │                                       │
   │  coordinator.ts  ──►  apix-agent.ts  │  ← 会话、计划、派发、调整
   │       │                    │          │
   │  requirement-engine.ts  permissions.ts│  ← 需求评估、授权
   │  scheduling.ts     planning-meetings.ts│  ← 调度、规划会议
   │  task-scheduler.mjs  execution-control│  ← DAG、并发、暂停
   │  mailbox.mjs   agent-mailbox.ts       │  ← 消息、凭据
   │  code-handoffs.mjs                    │  ← worktree、冻结交付
   │  memory.ts   worker-events.ts         │  ← 账本、事件采集
   └───────────────────────────────────────┘
        │
   外部 CLI 子进程 (Pi / Codex / Claude / ...)
        │  stdin/stdout JSONL 或 stream-json
        ▼
   独立 Git Worktree (APIX_DATA_DIR/workspaces/<taskId>)
```

**调用链（正向）**：`web/coordinator.ts` → `POST /api/coordination/sessions/:id/messages/stream` → `src/coordinator.ts` → 需求/权限校验 → `resolveApproval` → `launch` → 外部 CLI。

---

## 5. 目录结构

```
ApiX-Control-Center/
├── index.html                  # 前端入口（对话工作区）
├── agent-os.js                 # 项目/员工/记忆管理，旧页面兼容
├── agent-discovery.mjs         # 本机桌面 Agent 发现
├── server.mjs                  # HTTP 服务入口
├── control-plane.mjs           # SQLite 装配、进程托管
├── coordinator.css / *.css     # 各页面样式
├── tsconfig.json               # TypeScript 配置
├── package.json                # 依赖与脚本
├── src/                        # 后端 TypeScript/JS 核心
│   ├── contracts.ts            # 类型定义与接口
│   ├── apix-agent.ts           # 管理者推理、计划校验
│   ├── coordinator.ts          # 会话协调主入口
│   ├── requirement-engine.ts   # 五维需求模型
│   ├── permissions.ts          # 权限与执行授权
│   ├── memory.ts               # 事件账本与快照
│   ├── scheduling.ts           # 能力筛选与均衡调度
│   ├── planning-meetings.ts    # 规划会议
│   ├── runtime-adapters.ts     # CLI 适配器注册
│   ├── task-scheduler.mjs      # DAG 调度
│   ├── execution-control.mjs   # 并发、暂停、额度错误
│   ├── mailbox.mjs             # Mailbox 核心
│   ├── agent-mailbox.ts        # 员工凭据与身份
│   ├── code-handoffs.mjs       # Git worktree、冻结交付
│   ├── worker-events.ts        # 事件归一化、用量采集
│   ├── employee-insights.ts    # 员工状态派生
│   ├── task-tracker.ts         # 目标状态派生
│   ├── worker-context.ts       # 任务上下文、已确认需求
│   ├── readiness.mjs           # 就绪检查
│   ├── task-delivery.mjs       # 交付检查共享逻辑
│   ├── delivery-inspection.mjs # Worker Thread 交付检查
│   ├── local-models.ts         # 本地模型目录读取
│   ├── model-providers.ts      # 模型提供商配置
│   ├── workflow.ts             # 自动协作授权
│   └── environment.mjs         # 环境变量加载
├── web/                        # 前端 TypeScript 模块
│   ├── coordinator.ts          # 主工作台 UI
│   ├── conversation-stream.ts  # SSE 分帧与流处理
│   ├── model-settings.ts       # 模型配置页
│   ├── readiness.ts            # 就绪提示与修复入口
│   ├── employee.ts             # 员工管理页
│   ├── execution-view.ts       # 执行设置页
│   ├── overview.ts             # 管理总览页
│   ├── requirements-form.ts    # 需求表单
│   └── scheduling-view.ts      # 调度设置页
├── dist/                       # TypeScript 编译产物（不入库）
├── test/                       # 测试文件
├── scripts/                    # 辅助脚本
│   └── verify-real-collaboration.mjs  # 真实协作验收脚本
├── docs/                       # 设计与参考文档
├── 协作/                       # Agent 协作记录与审查
├── 示例/                       # 截图
└── AGENTS.md                   # 开发与提交规则
```

---

## 6. 核心模块详解

### 6.1 `src/contracts.ts`

所有共享类型定义的单一来源：需求字段、计划结构、会话状态、权限模式、事件类型、存储接口。修改此文件影响全局。

关键类型：
- `PermissionMode`: `'full_access' | 'ask_approval' | 'read_only'`
- `RequirementField`: `'goal' | 'scope' | 'constraints' | 'deliverable' | 'acceptance'`
- `SessionDerivedStatus`: `'clarifying' | 'ready' | 'plan_review' | 'running' | 'queued' | 'awaiting_acceptance' | 'attention' | 'completed'`

### 6.2 `src/coordinator.ts`

会话协调主入口，32KB，管理完整会话生命周期：
- 创建/读取会话（`coordination_sessions`）
- `discuss`：将需求、历史、任务状态、参考记忆送入管理者模型，流式输出
- `confirmSession`：生成并校验 1–8 个任务步骤，事务中保存计划
- `dispatchSession`：按当前计划版本派发；自动协作时检查全部准入条件
- `revise`：调整需求，使旧计划授权失效
- `stop`：取消排队任务，撤销授权，请求停止受托管运行

### 6.3 `src/apix-agent.ts`

管理者推理封装：
- 构建 Pi 推理输入（系统提示、工具定义、上下文）
- 带证据的需求提取：从对话中识别五维字段
- 计划校验：检查员工真实可用、依赖指向合法、字段非空
- 规则降级：带工具的结构化调用若返回普通文本，最多再进行一次无工具格式整理

### 6.4 `src/requirement-engine.ts`

五维需求模型：
- 评估五个字段的完整度，评分 = 已填字段数 / 5，阈值为 1
- 检测字段冲突（如范围与约束矛盾）
- `ready: boolean`：五项都非空且无冲突才为 true
- 用户必须通过 `confirmSession` 显式确认版本，才进入计划阶段

### 6.5 `src/permissions.ts`

权限与版本化执行授权：
- 按项目 + 主体（ApiX 或员工）存储 `PermissionMode`
- `apix_grants` 表：按任务绑定项目、员工、管理者权限版本、员工权限版本
- 权限变更时旧授权自动失效；恢复任务须重新授权

### 6.6 `src/memory.ts`

事件账本与状态回放：
- `apix_ledger` 表：追加写入，序号单调递增
- `stateAt(projectId, aggregateId, atSequence?)` 返回最近快照 + 后续事件
- FTS5 关键词检索（`memory_fts`），最多返回最近 50 个结果
- 注意：这不是完整事件溯源，SQL 表是运行依据，账本提供追溯

### 6.7 `src/scheduling.ts`

能力筛选与均衡调度：
- 硬筛选：必要标签、工具、上下文容量、指定员工
- 软排序：可比已验收历史、项目熟悉度、人工估计费用/时间、队列长度
- 写入范围重叠检测：声明重叠的并行任务被拒绝

### 6.8 `src/task-scheduler.mjs`

DAG 调度器：
- 前置任务必须 `accepted` 后才能启动依赖任务
- 失败向下游传播
- 维护依赖图，按拓扑顺序推进

### 6.9 `src/execution-control.mjs`

并发控制与额度错误处理：
- 项目并发默认 4（范围 1–8），每位员工在本项目并发默认 1（范围 1–4）
- 版本化暂停设置
- 额度/速率错误自动暂停对应运行时或绑定账户

### 6.10 `src/mailbox.mjs` + `src/agent-mailbox.ts`

Mailbox 消息系统：
- 持久化消息、尝试、事件、附件、租约锁到 SQLite
- 支持：请求/回复关联、幂等冲突检查、超时/重试、交付物引用、拦截
- 员工 Bearer 凭据绑定项目/员工/任务/运行，仅限 mailbox 操作

### 6.11 `src/code-handoffs.mjs`

Git worktree 管理与交付冻结：
- 验证托管位置、任务记录、Git 根目录、公共目录、worktree 登记
- 差异检查使用临时 Git index，不改员工原 index
- 用户审查指纹后，`commit-tree` 冻结不可变交付
- 三方冲突阻止启动，保留工作区

### 6.12 `src/readiness.mjs`

就绪检查（`GET /api/readiness?projectId=...`）：
- 检查项目目录、Pi 入口、模型密钥环境变量、员工入口、管理者预算；非 Git 项目执行时建立计划级托管基线
- 不预留费用，不宣称登录或额度已验证

---

## 7. 数据库模型

数据库默认位于 `~/.apix-agent-os/apix.sqlite`，可通过 `APIX_DATA_DIR` 改变。

| 数据组 | 主要表 |
| --- | --- |
| 项目与员工 | `projects`, `employees`, `departments`, `project_repositories` |
| 计划与执行 | `plans`, `tasks`, `task_dependencies`, `approvals`, `runs`, `events`, `artifacts`, `workspaces` |
| 对话与需求 | `coordination_sessions`, `coordination_turns`, `coordination_checks`, `coordination_events`, `coordination_plan_briefs` |
| 管理者状态 | `apix_manager_settings`, `apix_workflows`, `apix_policies`, `apix_grants`, `apix_guidance`, `apix_ledger` |
| 项目记忆 | `project_profiles`, `memories`, `memory_revisions`, `memory_fts` |
| 消息与身份 | `agent_mailboxes`, `agent_messages`, `agent_message_attempts`, `agent_message_events`, `agent_message_artifacts`, `agent_locks`, `apix_agent_tokens` |
| 调度与预算 | `scheduling_profiles`, `scheduling_accounts`, `scheduling_policies`, `scheduling_tasks`, `scheduling_attempts`, `scheduling_reservations`, `scheduling_account_pauses` |
| 会议与交付 | `planning_meetings`, `code_handoffs`, `integration_reviews` |
| 执行配置与观测 | `execution_settings`, `runtime_pauses`, `apix_run_usage`, `apix_adapters` |

迁移策略：不删除旧表，保留历史 Director 等表兼容旧数据；迁移不丢失用户已有项目。

---

## 8. HTTP API 参考

所有 API 仅监听本机，信任本机用户，**不能暴露到公网**。修改类请求使用 JSON，须携带当前 revision/version 等乐观锁值。

### 会话与协调

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/coordination/sessions?projectId=…` | 获取项目会话列表，`summary=1` 返回摘要 |
| `POST /api/coordination/sessions` | 创建会话 |
| `GET /api/coordination/sessions/:id` | 获取会话详情、任务、工作详情 |
| `POST /api/coordination/sessions/:id/messages/stream` | 流式对话（POST SSE） |
| `POST /api/coordination/sessions/:id/answers` | 更新结构化需求字段 |
| `POST /api/coordination/sessions/:id/confirm` | 确认需求，生成计划 |
| `POST /api/coordination/sessions/:id/plan` | 修改待审计划 |
| `POST /api/coordination/sessions/:id/dispatch` | 按当前计划版本派发 |
| `POST /api/coordination/sessions/:id/revise` | 调整需求，使旧计划授权失效 |
| `POST /api/coordination/sessions/:id/stop` | 停止当前已知工作 |
| `POST /api/coordination/sessions/:id/planning-meetings` | 批准规划会议 |
| `POST /api/coordination/sessions/:id/planning-meetings/apply` | 应用会议建议（生成新待审计划） |

### 项目与权限

| 方法 路径 | 说明 |
| --- | --- |
| `GET/POST /api/projects/:id/workflow` | 查看/修改自动协作授权 |
| `GET/POST /api/permissions` | 查看/修改主体权限 |
| `GET/POST /api/projects/:id/execution` | 并发设置 |
| `GET/POST /api/projects/:id/scheduling` | 调度设置 |

### 交付与模型

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/tasks/:id/delivery` | 检查交付差异及指纹（Worker Thread 执行） |
| `GET/POST /api/manager/settings` | 管理者模型配置 |
| `POST /api/manager/models` | 读取本地模型目录 |
| `POST /api/manager/test` | 已保存管理者模型连接测试 |
| `GET /api/readiness?projectId=…` | 项目就绪检查 |
| `GET /api/events/stream` | Mailbox 消息事件流（独立 SSE） |

### SSE 事件格式（对话流）

| 事件类型 | 内容 |
| --- | --- |
| `start` | 会话 ID |
| `delta` | 文本片段 |
| `tool` | 工具名、开始/结束、错误标记 |
| `complete` | 正式会话记录 |
| `error` | 错误信息 |

工具事件账本只存元数据（工具名、阶段、错误标记），不保存命令参数或文件内容。

---

## 9. 前端页面与组件

| 文件 | 页面/功能 |
| --- | --- |
| `index.html` + `web/coordinator.ts` | 默认对话工作区：项目选择、会话管理、流式对话、工作详情（双模式） |
| `web/conversation-stream.ts` | UTF-8/SSE 分帧、增量文本、工具活动显示、断流处理 |
| `web/overview.ts` | 管理总览：项目目标、待处理事项、任务流转 |
| `web/employee.ts` | 员工管理：注册、能力声明、状态显示 |
| `web/model-settings.ts` | 管理者模型配置：自定义 URL、模型 ID、协议、Key 变量名、连接测试 |
| `web/readiness.ts` | 就绪提示与修复入口（Pi 入口、模型、员工、预算） |
| `web/execution-view.ts` | 并发与暂停设置 |
| `web/scheduling-view.ts` | 调度偏好与预算账本 |
| `web/requirements-form.ts` | 五维需求表单（约束模式） |

工作详情支持"对话模式"（自然语言）和"约束模式"（逐项表单），两种模式共享同一确认门槛。

---

## 10. Agent 运行时接入

### 内置适配器

| 运行时 | 入口环境变量 | 输出协议 |
| --- | --- | --- |
| Pi | `APIX_PI_ENTRY` | JSONL RPC |
| Codex CLI | `APIX_CODEX_ENTRY` | 原生 JSONL 事件 |
| Claude Code | `APIX_CLAUDE_ENTRY` | stream-json |
| Gemini CLI | `APIX_GEMINI_ENTRY` | stream-json |
| OpenCode | `APIX_OPENCODE_ENTRY` | `run --format json` |
| Kimi Code | `APIX_KIMI_ENTRY` | `--print --output-format=stream-json` |
| 自定义 CLI | 在"任务与员工"登记 | 显式声明格式 |

### 接入要点

- 入口不接受 `.cmd`、`.bat`、`.ps1`，可填写绝对路径或 JavaScript 入口
- Windows 全局 npm 命令会按包清单定位实际入口
- 每种 CLI 须在终端独立完成安装和认证，再用小任务验证
- 桌面应用被发现不等于有可托管的非交互 CLI
- 适配器存在不代表本机已安装、登录或完成真实联调

### Token 用量采集

| 来源 | 采集方式 |
| --- | --- |
| Pi | RPC 消息 usage 字段累加 |
| Codex | `turn.completed` 事件提取 |
| Claude | `result` 事件提取 |
| 未报告 | 显示"未知"，不虚构数据 |

---

## 11. 权限与授权体系

### 三级权限模式

| 模式 | 对话工具 | 计划工具 | 执行策略 |
| --- | --- | --- | --- |
| `ask_approval` | 无 | 无 | 须用户批准 |
| `read_only` | read/grep/find/ls | 同左 | 拒绝员工执行 |
| `full_access` | 只读工具 + bash/edit/write | 仅只读工具 | 可策略授权 |

权限按**项目 × 主体**独立设置。任一方为 `read_only` 拒绝执行；双方均为 `full_access` 才允许策略自动授权，否则须用户批准。

### 执行授权（`apix_grants`）

每个任务的授权绑定：
- 项目 ID、员工 ID
- 管理者权限版本、员工权限版本
- 授权来源（用户手动 / 策略自动）

权限变更时旧授权自动失效；恢复换员工、调整需求或改变相关设置都不能复用旧批准。

### 自动协作

- 默认关闭，首次开启须用户明确批准，选择至少一位可用员工
- 事务中设置管理者和员工完全访问权限，保存版本
- 已有活动、排队或状态未知任务时不能重新开启/修改授权
- 暂停自动安排不撤销已有权限，停止当前工作会撤销授权

---

## 12. 需求工程（五维模型）

五个必填字段：

| 字段 | 含义 |
| --- | --- |
| `goal` | 要解决什么问题，最终改变什么 |
| `scope` | 包含什么，不包含什么 |
| `constraints` | 技术、时间、权限限制 |
| `deliverable` | 可检查的具体成果 |
| `acceptance` | 通过什么检查才算完成 |

评分 = 已填字段数 / 5，阈值为 1（全部填写）。五项都非空且无冲突，用户通过 `confirmSession` 明确确认版本后，才进入计划阶段。

已确认的需求版本不能通过聊天修改；扩大范围须 `revise` 调整需求或新建会话。

---

## 13. 调度、预算与并发

### 调度优先级（均衡模式）

1. 硬筛选：必要标签、工具、上下文容量、指定员工
2. 软排序：已验收历史（质量依据）→ 项目熟悉度 → 人工费用/时间估计 → 队列长度

### 预算与额度

- 费用为声明币种的最小单位整数；订阅百分比不换算金额
- 额度采用人工快照（`scheduling_accounts`），支持保留线、观测/重置时间
- 项目预算和共享账户同时检查已用 + 预留 + 批准上界
- 严格策略：未知或过期快照阻止准入
- 指定管理者账户后，聊天/计划/监督推理也进入预留
- 无供应商费用时保留未测量预留，核对账单后人工结算
- 活动运行不可结算

### 并发

| 维度 | 默认值 | 范围 |
| --- | --- | --- |
| 项目并发 | 4 | 1–8 |
| 每位员工在本项目并发 | 1 | 1–4 |

降低并发或暂停不停止已运行进程。状态未知任务继续占用并发额度，须人工确认原进程停止。

---

## 14. 规划会议

待审计划可邀请最多三位参与者（当前支持 Pi 与 Claude CLI bare/restricted 模式）。

**流程**：
1. 单独批准会议费用
2. 第一轮：参与者独立提出可领取工作、依据、输入需求与风险
3. 有分歧可再进行第二轮（每个计划最多两轮）
4. 规则整理纪要，无额外主持模型调用
5. 应用建议 → 生成新的待审计划（不直接执行）

参与者在独立目录中运行，无项目工具和执行邮箱凭据。失败与过期建议保留记录。

---

## 15. Mailbox 消息与执行监督

### 消息协议

- 员工 CLI 须主动轮询 mailbox 才能收到运行中指导
- 管理者可发送：进度请求、范围内指导、同计划员工交接（须指定 `targetTaskId`）
- 员工通过 `GET /api/events/stream` 订阅消息事件流

### 指导决策逻辑

```typescript
if (report.blocked) → 'escalate', focus: 'verification'
else if (needsGuidance) → 'guide', focus: 'scope'|'verification'|'dependencies'|'delivery'
else → 'observe', focus: 'verification'
```

### 凭据边界

员工 Bearer Token 绑定项目/员工/任务/运行，仅限对应 mailbox 行为，不授予管理 API 访问。旧凭据不在恢复时重放。

详细协议见 `docs/agent-message-protocol.md`。

---

## 16. Git Worktree 与代码交接

### 工作区位置

`APIX_DATA_DIR/workspaces/<taskId>` — Git detached worktree。

非 Git 和尚无提交的项目由 `project-baseline.mjs` 先建立计划级托管输入快照，原目录不被初始化或提交。快照遵守 `.gitignore`，排除依赖、常见凭据及 ApiX 数据目录，拒绝链接和超限输入。交付、交接、重启检查复用既有 Git 流程；成果检查后从托管工作区导出，不能把集成变更应用到输入快照。详细限制见 [自主交付与模块契约](自主交付与模块契约.md)。

计划 JSON 或依赖校验失败时携带具体原因纠正一次，每次单独进行管理者预算检查；仍失败则保留待审草案，自主架构模式停止派发。连接失败不走内容纠正。点击消息或当前会话不会重新选择会话或清除编辑草稿。

### 验证流程

1. 检查托管位置、任务记录、Git 根目录、公共目录、worktree 登记
2. 路径使用 `realpathSync.native` 解析，兼容历史路径别名
3. 差异检查在独立 Worker Thread 执行（最多 2 个并行，120 秒超时）
4. 用户审查指纹后，`commit-tree` 冻结不可变交付对象

### 交付冻结

- 依赖员工取得已验收交付后才能启动
- 三方冲突阻止启动，保留工作区供用户解决
- 源仓库应用交付须单独集成审查，不自动合并主分支

### 恢复规则

恢复须满足：确认审查、匹配最近运行 ID、需求/授权版本及工作区指纹一致、前置任务已验收。重启时未完成运行转为未知状态。

---

## 17. 管理者模型配置

### 支持的模型来源

1. Pi 已配置模型（默认）
2. 兼容 OpenAI API 的自定义 URL（`openai-completions` 协议）
3. 阿里百炼（通过 `.env` 配置 `ali_url` / `ali_api_key` / `ali_model_name`）
4. 本地模型（Ollama、LM Studio 等，通过"读取本地模型"获取目录）

### 独立连接测试

`POST /api/manager/test` — 须包含 `projectId`、`settings`、`approved=true`。

- 使用当前项目推理预算预留，执行一次随机 nonce 回显校验
- 禁用工具、项目上下文、执行邮箱凭据
- 全局互斥：测试期间不能重复测试或修改配置
- 90 秒后请求终止；断开浏览器不取消调用
- 成功仅证明本次推理连接，不证明工具、员工或端到端协作

### Pi 子进程行为

Windows 下 Pi 子进程优先使用已安装 Git 的 Bash，不修改全局 PATH。管理者 Pi 使用 RPC 模式，禁用扩展、Skills 与提示模板。

---

## 18. 测试体系

```powershell
npm run check    # TypeScript 静态检查 + node --check 各 JS 文件
npm test         # Node Test Runner，隔离数据库，假 CLI，并发=1
npm run test:real  # 真实协作验收（需配置真实 CLI 和模型，可能产生费用）
```

### 测试文件

| 文件 | 覆盖范围 |
| --- | --- |
| `test/agent-os.test.mjs` | 项目/员工基础 CRUD |
| `test/coordinator.test.mjs` | 会话协调核心流程 |
| `test/apix-agent.test.mjs` | 管理者推理与计划校验 |
| `test/scheduling.test.mjs` | 能力筛选与调度 |
| `test/execution-control.test.mjs` | 并发控制与额度错误 |
| `test/collaboration.test.mjs` | 多 Agent 协作流程 |
| `test/messaging.test.mjs` | Mailbox 消息 |
| `test/memory.test.mjs` | 事件账本与检索 |
| `test/readiness.test.mjs` | 就绪检查 |
| `test/model-settings-ui.test.mjs` | 模型设置页 |
| `test/conversation-ui.test.mjs` | 对话 UI |
| `test/local-models.test.mjs` | 本地模型目录 |
| `test/execution-ui.test.mjs` | 执行设置 UI |
| `test/environment.test.mjs` | 环境变量加载 |

P0–P2 阶段历史回归为 113/113。当前测试包含自主质量闭环、契约校验、资源等待、恢复与原有完整回归，最新数量和结果以 [稳定交付修复与自审](../协作/稳定交付修复与自审.md)为准；独立能力探测与真实模型测试分别记录。

### 真实协作验收

```powershell
$env:APIX_MANAGER_PI_ENTRY = '你的真实 Pi cli.js 绝对路径'
npm run build
node scripts/verify-real-collaboration.mjs --approve-cost
```

验收记录保存在 `.tmp-real-collaboration/run-*/result.json`，不纳入 Git。

---

## 19. 开发与提交规则

（源自 `AGENTS.md`，2026-10-12 更新）

1. **双 Agent 协作**：Codex 与 Claude Code CLI 协作，任务归属由用户指定，见 `协作/` 目录
2. **每次修改纳入 Git 管理**：提交前审查最终 diff，包括新增文件、调用方、错误路径、数据一致性与访问边界
3. **审查结论记录到 `协作/`**：自审如实标注自审，不称独立审查或人工批准
4. **只有审查通过后才能提交**：提交前检查暂存区与被审查内容一致，审查后改动代码须重新审查
5. **明确文件清单暂存**：不使用 `git add .`、`reset`、`clean` 或自动切换分支；未经用户要求不推送或合并

### Commit 格式

```
<type>: <subject>

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

---

## 20. 多 Agent 协作历史

项目采用 Codex + Claude Code CLI 双 Agent 协作开发，历史记录见 `协作/` 目录。

| 文档 | 内容 |
| --- | --- |
| `协作/开发计划与进度.md` | 总体开发计划与阶段进度 |
| `协作/ApiX工具与任务派发修复审查.md` | 工具与任务派发修复的审查记录 |
| `协作/能力会议预算开发与审查.md` | 能力调度、规划会议、共享账户实现与验证 |
| `协作/桌面对话与自动协作开发审查.md` | 交互和自动安排流程的审查 |
| `协作/模型连接测试开发与审查.md` | 独立连接测试功能的审查 |
| `协作/就绪改进P0到P2开发与审查.md` | P0–P2 就绪改进及真实多员工补验记录 |
| `协作/主分支集成与Windows路径修复审查.md` | 主分支集成与 Windows 路径修复 |
| `协作/当前工作模式.md` | 当前协作模式说明 |

---

## 21. 已验证范围与已知限制

### 已验证

| 范围 | 状态 |
| --- | --- |
| 代码基线 `93595d9` | Windows CI（Node 22.19.0），静态检查 + 100/100 测试通过 |
| 连接测试功能 | 本地静态检查 + 104/104 回归 + 4/4 定向复验（假 CLI） |
| P0–P2 代码 | 113/113 完整回归通过 |
| 管理者真实模型 | Pi 0.74.2 + 阿里 `qwen3.7-flash`，read/bash/write 及任务派发验证 |
| 界面布局 | 1360×900 与 390×844 流式对话、详情收起、窄屏验收 |
| 真实多员工编码 | Pi 规划 + Codex 写入冻结 + Claude 接收代码及指导确认 + Node 验证，2026-10-13 通过 |

### 已知限制与待补齐

- Gemini/OpenCode/Kimi 真实 CLI 联调待补齐
- 本轮新界面视觉验收待补（浏览器工具不可用）
- 供应商用量同步、价格同步未实现
- 操作系统级沙箱未实现
- 远程多用户认证未实现
- 不能仅凭计划、工具事件或自然语言总结证明项目已完成

---

## 22. 文档导航

| 文档 | 位置 | 内容 |
| --- | --- | --- |
| README | `README.md` | 快速开始、功能表、截图、配置指南、权限说明 |
| 架构设计文档 | `架构设计文档.md` | 分层、模块、执行链、数据表、接口边界 |
| 代码索引 | `docs/代码索引.md` | 各模块职责与调用链 |
| 消息协议 | `docs/agent-message-protocol.md` | Mailbox、运行身份与消息交接 |
| 分支管理 | `docs/分支管理.md` | 分支历史与合并记录 |
| 协调系统实现 | `docs/ApiX协调系统实现.md` | 重构历史与阶段设计 |
| 管理总览设计 | `docs/管理总览设计.md` | 管理页面设计历史 |
| 早期功能说明 | `docs/功能与限制.md` | 历史阶段能力记录 |
| 项目 Wiki（本文） | `docs/项目Wiki.md` | 完整知识库，随开发更新 |

---

*本 Wiki 随项目开发持续更新。如发现内容与代码不符，以当前代码和 `架构设计文档.md` 为准。*
