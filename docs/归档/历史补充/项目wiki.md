# ApiX Control Center 项目 Wiki

> 本文档是项目的综合说明书，随开发持续更新。\
> 最近一次更新：2026-10-13。对应分支：`codex/readiness-p0-p2`。\
> 当前权威说明另见：[架构设计文档](../../架构设计.md)、[README](../../../README.md)。

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [目录结构](#3-目录结构)
4. [系统架构与分层](#4-系统架构与分层)
5. [核心模块详解](#5-核心模块详解)
6. [HTTP API 参考](#6-http-api-参考)
7. [数据库模型](#7-数据库模型)
8. [Agent 与 CLI 接入](#8-agent-与-cli-接入)
9. [配置指南](#9-配置指南)
10. [开发与测试](#10-开发与测试)
11. [双 Agent 协作模式](#11-双-agent-协作模式)
12. [已验证范围与已知限制](#12-已验证范围与已知限制)
13. [文档导航](#13-文档导航)

---

## 1. 项目概述

ApiX Control Center 是一个**面向本机项目的多 Agent 协作工作台**。用户通过对话提出目标，ApiX（管理者 Agent）负责理解需求、规划任务、调度执行员工、监督进度，并要求用户审查代码后验收成果。

**核心定位：**
- 管理者始终通过 **Pi CLI** 进行推理（支持换用兼容 API）
- 执行员工使用各自独立的 CLI（Codex、Claude Code、Gemini CLI 等）
- 项目、对话、计划和运行记录持久化在本机 **SQLite**
- 系统仅监听本机，不提供面向公网的多用户认证

**不是什么：**
- 不是分布式调度集群
- 不提供操作系统级沙箱隔离
- 不同步供应商账单，预算控制仅限本应用新任务准入
- 自动协作不自动通过代码验收或合并源仓库

---

## 2. 技术栈

| 层次 | 技术选型 |
| --- | --- |
| 运行时 | Node.js ≥ 22.19.0（内置 SQLite，需支持 FTS5） |
| 语言 | TypeScript（严格模式）+ ES Module JavaScript |
| 界面 | 原生 HTML + CSS + TypeScript 模块（无前端框架） |
| 服务层 | Node.js 原生 HTTP（无 Express/Fastify） |
| 数据层 | Node 内置 `node:sqlite`，FTS5 全文索引 |
| 实时通信 | POST SSE（对话流）+ 独立 Mailbox 事件流 |
| 代码交付 | Git detached worktree，差异指纹，冻结交付 |
| 构建 | `tsc`（TypeScript 编译到 `dist/`） |
| 测试 | Node Test Runner（`node --test`），无第三方测试框架 |
| CI | GitHub Actions（Windows，Node.js 22.19.0） |
| 依赖 | 仅 devDependencies：`typescript`、`@types/node` |

生产依赖为零——所有运行时能力来自 Node.js 内置模块。

---

## 3. 目录结构

```
ApiX-Control-Center/
├── src/                    # 后端核心模块（TypeScript）
├── web/                    # 前端模块（TypeScript，编译到 dist/web/）
├── test/                   # 自动化测试（Node Test Runner）
├── dist/                   # TypeScript 编译输出（不入库）
├── docs/                   # 历史阶段设计文档
├── 协作/                   # 双 Agent 协作记录、审查结论、截图
├── 示例/                   # 界面截图
├── scripts/                # 真实协作验收脚本
├── server.mjs              # HTTP 服务入口
├── control-plane.mjs       # SQLite 初始化、进程托管、模块装配
├── agent-os.js             # 主界面 JS 入口
├── agent-discovery.mjs     # CLI 运行时发现
├── index.html              # 应用入口页面
├── *.css                   # 各页面样式（coordinator/desktop/overview 等）
├── package.json            # 无生产依赖；scripts: build/start/check/test
├── tsconfig.json           # 严格模式，target ES2022，NodeNext 模块
├── .env.example            # 阿里百炼配置模板
├── AGENTS.md               # 开发与提交规则（双 Agent 协作约定）
├── 架构设计文档.md          # 当前权威架构说明
└── 项目wiki.md             # 本文件
```

**临时目录**（均已在 `.gitignore` 中或属于 Codex 测试产物）：
- `.tmp-codex-round2-*/`、`.tmp-codex-validation/`、`.tmp-p0-p2/`、`.tmp-real-collaboration/`：各轮次 Codex 测试用隔离环境

---

## 4. 系统架构与分层

从用户输入到员工执行，系统经过以下七层：

```
用户浏览器 (index.html / web/*.ts)
    ↓ HTTP + SSE
server.mjs   [Host/Origin 校验、JSON 校验、路由]
    ↓
control-plane.mjs   [SQLite、进程托管、模块装配]
    ↓
src/coordinator.ts + src/apix-agent.ts   [需求、计划、派发、监督]
    ↓
src/scheduling.ts + src/planning-meetings.ts   [能力筛选、会议]
    ↓
src/task-scheduler.mjs + src/execution-control.mjs   [队列、并发、暂停]
    ↓
src/runtime-adapters.ts   [Pi / Codex / Claude Code / Gemini 等 CLI]
```

### 关键分层说明

| 层 | 入口文件 | 职责 |
|---|---|---|
| 界面 | `index.html`, `agent-os.js`, `web/coordinator.ts` | 默认对话工作区、项目/对话选择、工作详情 |
| 流式客户端 | `web/conversation-stream.ts` | UTF-8/SSE 分帧、增量文本、断流处理 |
| HTTP | `server.mjs` | 本机 Host/Origin 校验、所有 API 路由 |
| 宿主与持久化 | `control-plane.mjs` | SQLite 迁移、进程托管、模型调用、运行采集 |
| 协调 | `src/coordinator.ts`, `src/apix-agent.ts` | 需求门槛、对话决策、计划、派发、调整、恢复 |
| 需求与工作流 | `src/requirement-engine.ts`, `src/workflow.ts` | 五项需求门槛、自动协作授权 |
| 权限与记忆 | `src/permissions.ts`, `src/memory.ts` | 主体权限、任务授权、协调快照 |
| 调度 | `src/scheduling.ts`, `src/planning-meetings.ts` | 能力筛选、规划会议、预算准入 |
| 执行 | `src/runtime-adapters.ts`, `src/task-scheduler.mjs`, `src/execution-control.mjs` | CLI 参数、依赖排队、并发控制 |
| 消息 | `src/mailbox.mjs`, `src/agent-mailbox.ts`, `src/worker-context.ts` | 领取/确认/回复、凭据边界 |
| 交付 | `src/code-handoffs.mjs`, `src/task-delivery.mjs`, `src/delivery-inspection.mjs` | worktree 验证、差异指纹、冻结交付 |
| 观测 | `src/worker-events.ts`, `src/employee-insights.ts`, `src/task-tracker.ts` | 事件归一化、用量、任务状态 |
| 就绪 | `src/readiness.mjs` | 入口就绪提示，`GET /api/readiness` |

---

## 5. 核心模块详解

### 5.1 对话与需求（`src/coordinator.ts` + `src/apix-agent.ts`）

对话流程：用户发送消息 → `discuss` 方法将需求/历史/任务状态/记忆送入管理者模型 → 回复流式输出 → 结构化决策校验后落库。

**五项需求门槛**（`src/requirement-engine.ts`）：目标、范围、约束、交付物、验收标准。评分为已填字段数/5，阈值为 1（五项全填才通过）。普通问答不启动员工。

**计划生成**：`confirmSession` 生成 1–8 个步骤，员工必须真实可用，依赖只能指向前置步骤；事务中保存计划、任务、待审批记录、依赖、需求摘要及调度约束。

**会话状态**：`clarifying` → `ready` → `plan_review` → `running`/`queued`/`awaiting_acceptance`/`attention`/`completed`/取消。

### 5.2 执行适配器（`src/runtime-adapters.ts`）

为每种 CLI 封装参数格式和输出解析：
- **Pi**：JSONL RPC 模式，禁用 Skills/扩展/提示模板
- **Codex CLI**：原生 JSONL 事件
- **Claude Code**：`stream-json` 格式
- **Gemini CLI**：`stream-json`，普通模式 `auto_edit`，完全访问 `--yolo`
- **OpenCode**：`run --format json`
- **Kimi Code**：`--print --output-format=stream-json`
- **自定义 CLI**：显式登记可执行文件、参数数组、输出格式

员工在独立 Git worktree 中执行，通过标准输入接收任务上下文，凭据绑定到项目/员工/任务/运行。

### 5.3 权限模型（`src/permissions.ts`）

三级权限：`ask_approval`（默认）、`read_only`、`full_access`。

管理者推理工具矩阵：

| 权限级别 | 对话调用 | 计划调用 |
|---|---|---|
| `ask_approval` | 无工具 | 无工具 |
| `read_only` | `read`、`grep`、`find`、`ls` | 同左 |
| `full_access` | 只读 + `bash`、`edit`、`write` | 仅只读工具 |

管理者工具直接操作源项目目录，权限变化时宿主请求中止在途工具调用；但已发生的操作不回滚。

**自动协作**：初始关闭。开启须明确批准 + 至少一位可用员工，事务中记录版本。有活动任务时不能重新开启/修改。

### 5.4 调度与预算（`src/scheduling.ts` + `src/planning-meetings.ts`）

**能力筛选顺序**：必要能力标签 → 工具 → 上下文容量 → 指定员工（硬筛选）→ 已验收历史/项目熟悉度/费用/队列（软排序）。

**规划会议**：最多 3 位参与者，最多 2 轮，每位在独立目录中独立提出领取意向/依据/风险。应用建议生成新待审计划，不直接执行。当前接入：Pi 和支持 bare/restricted 模式的 Claude CLI。

**预算机制**：人工额度快照（非实时同步供应商账单）。费用为最小货币单位整数。严格模式下未知/过期快照阻止准入。指定管理者账户后，聊天/计划/监督推理也进入预留机制。

### 5.5 Git 交付与恢复（`src/code-handoffs.mjs`）

- 员工工作区：`APIX_DATA_DIR/workspaces/<taskId>`，Git detached worktree
- 差异检查使用临时 Git index，不改员工原 index
- 用户审查指纹后，服务用 `commit-tree` 冻结不可变交付
- 依赖员工取得已验收交付才能启动
- 三方应用冲突阻止启动并保留工作区
- 交付差异查询在独立 Worker Thread 中执行（最多 2 个），120 秒超时

### 5.6 Mailbox 消息系统（`src/mailbox.mjs`）

消息、尝试、事件、附件、租约锁持久化在 SQLite。员工 Bearer 凭据仅限对应 mailbox 行为，不授予管理 API 访问。四个阶段：领取 → 确认接收 → 完成处理 → 报告。第三方 CLI 须主动轮询才能收到实时指导。

### 5.7 就绪检查（`src/readiness.mjs`）

`GET /api/readiness?projectId=...` 返回：项目检查、管理者检查、模型检查、员工检查、预算检查。不预留费用，不宣称登录或额度已验证。前端 `web/readiness.ts` 提供对应修复入口。

---

## 6. HTTP API 参考

所有接口监听 `127.0.0.1:4173`（默认），修改类请求使用 JSON，需传当前 `revision`/`version`。

### 对话与会话

| 方法 路径 | 说明 |
|---|---|
| `GET /api/coordination/sessions?projectId=…` | 获取项目会话列表；`summary=1` 获取摘要 |
| `POST /api/coordination/sessions` | 创建会话 |
| `GET /api/coordination/sessions/:id` | 获取会话详情（任务、工作详情） |
| `POST /api/coordination/sessions/:id/messages/stream` | 流式对话（SSE） |
| `POST /api/coordination/sessions/:id/answers` | 更新结构化需求答案 |
| `POST /api/coordination/sessions/:id/confirm` | 确认需求、生成计划 |
| `POST /api/coordination/sessions/:id/plan` | 修改待审计划 |
| `POST /api/coordination/sessions/:id/dispatch` | 派发当前计划 |
| `POST /api/coordination/sessions/:id/revise` | 调整需求、使旧计划授权失效 |
| `POST /api/coordination/sessions/:id/stop` | 停止当前已知工作 |
| `POST /api/coordination/sessions/:id/planning-meetings` | 批准规划会议 |
| `POST /api/coordination/sessions/:id/planning-meetings/apply` | 应用会议建议 |

### 项目与配置

| 方法 路径 | 说明 |
|---|---|
| `GET/POST /api/projects/:id/workflow` | 查看/修改自动协作授权 |
| `GET/POST /api/permissions` | 查看/修改主体权限 |
| `GET/POST /api/projects/:id/execution` | 并发设置 |
| `GET/POST /api/projects/:id/scheduling` | 调度设置 |

### 任务与交付

| 方法 路径 | 说明 |
|---|---|
| `GET /api/tasks/:id/delivery` | 检查交付差异及指纹 |
| `POST /api/tasks/:id/recovery` | 恢复失败/排队任务 |

### 管理者模型

| 方法 路径 | 说明 |
|---|---|
| `GET/POST /api/manager/settings` | 查看/修改管理者模型配置 |
| `POST /api/manager/models` | 读取本地模型目录 |
| `POST /api/manager/test` | 已保存配置的连接测试（需 `projectId`、`settings`、`approved=true`） |

### 事件流

| 方法 路径 | 说明 |
|---|---|
| `GET /api/events/stream` | Mailbox 消息事件流（独立于对话 SSE） |
| `GET /api/readiness?projectId=…` | 就绪状态检查 |

**对话 SSE 事件类型**：`start`（会话 ID）、`delta`（文本片段）、`tool`（工具名/阶段/错误）、`complete`（正式会话）、`error`（失败）。

**旧 API**：`APIX_LEGACY_API=1` 开启直接派发/Director API（默认关闭，仅用于历史回归）。

---

## 7. 数据库模型

默认路径：`~/.apix-agent-os/apix.sqlite`，可通过 `APIX_DATA_DIR` 更改。

| 数据组 | 主要表 |
|---|---|
| 项目与员工 | `projects`、`employees`、`departments`、`project_repositories` |
| 计划与执行 | `plans`、`tasks`、`task_dependencies`、`approvals`、`runs`、`events`、`artifacts`、`workspaces` |
| 对话与需求 | `coordination_sessions`、`coordination_turns`、`coordination_checks`、`coordination_events`、`coordination_plan_briefs` |
| 管理者状态 | `apix_manager_settings`、`apix_workflows`、`apix_policies`、`apix_grants`、`apix_guidance`、`apix_ledger` |
| 项目记忆 | `project_profiles`、`memories`、`memory_revisions`、`memory_fts` |
| 消息与身份 | `agent_mailboxes`、`agent_messages`、`agent_message_attempts`、`agent_message_events`、`agent_message_artifacts`、`agent_locks`、`apix_agent_tokens` |
| 调度与预算 | `scheduling_profiles`、`scheduling_accounts`、`scheduling_policies`、`scheduling_tasks`、`scheduling_attempts`、`scheduling_reservations`、`scheduling_account_pauses` |
| 会议与交付 | `planning_meetings`、`code_handoffs`、`integration_reviews` |
| 执行配置 | `execution_settings`、`runtime_pauses`、`apix_run_usage`、`apix_adapters` |

**`apix_ledger`**：追加事件 + 协调快照，`stateAt(seq)` 返回指定序号前的最近快照和后续事件。不是完整事件溯源（不重建所有表）。

**`memory_fts`**：FTS5 全文索引，检索最多返回最近 50 个匹配项，目前为 Unicode 字面匹配。

---

## 8. Agent 与 CLI 接入

### 支持的执行运行时

| 运行时 | 入口环境变量 | 协议 |
|---|---|---|
| Pi | `APIX_PI_ENTRY` | JSONL RPC |
| Codex CLI | `APIX_CODEX_ENTRY` | 原生 JSONL 事件 |
| Claude Code | `APIX_CLAUDE_ENTRY` | stream-json |
| Gemini CLI | `APIX_GEMINI_ENTRY` | stream-json |
| OpenCode | `APIX_OPENCODE_ENTRY` | `run --format json` |
| Kimi Code | `APIX_KIMI_ENTRY` | `--print --output-format=stream-json` |
| 自定义 CLI | 在"任务与员工"登记 | 显式可执行文件 + 参数数组 + 输出格式 |

- `APIX_MANAGER_PI_ENTRY`：单独覆盖管理者的 Pi 入口
- Windows：不接受 `.cmd`、`.bat`、`.ps1`；全局 npm 命令按包清单定位实际入口
- Pi 子进程优先使用已安装 Git 的 Bash，不修改全局 PATH

### 接入注意事项

- 每种 CLI 须在终端单独完成安装和认证，再用小任务验证
- 员工须主动轮询 mailbox 才能收到实时指导
- Trae/Qoder/WorkBuddy 等桌面应用发现不代表可托管执行，需要非交互 CLI
- Gemini 完全访问使用 `--yolo`；OpenCode/Kimi 工具权限取决于原生 CLI 配置

---

## 9. 配置指南

### 快速启动

```powershell
git clone https://github.com/Makimasdog/ApiX-Control-Center.git
cd ApiX-Control-Center
npm ci
npm start
# 访问 http://127.0.0.1:4173/
```

环境变量（`.env` 文件）：

```dotenv
# 阿里百炼（密钥仅放本地，勿提交）
ali_url=https://dashscope.aliyuncs.com/compatible-mode/v1
ali_api_key=<你的密钥>
ali_model_name=<模型 ID>

# Pi 入口（PATH 中有 pi 时可省略）
# APIX_PI_ENTRY=C:/path/to/pi/dist/cli.js

# 可选
# APIX_DATA_DIR=自定义数据目录
# PORT=4173
# APIX_LEGACY_API=1   # 仅用于历史回归
```

`ali_api_key` 映射为进程内 `APIX_ALI_API_KEY`。在"ApiX 推理模型"页面选择自定义 URL，手动填写 URL 和模型 ID，协议选 `openai-completions`，Key 环境变量名填 `APIX_ALI_API_KEY`。

### 管理者模型配置

1. 选择 Pi 已配置模型，或填写兼容 API 的 URL、模型 ID、协议与 Key 环境变量名
2. 自定义配置写入数据目录下独立的 Pi 模型目录，不覆盖用户 Pi 配置，不经页面保存密钥
3. 保存后勾选一次费用批准，点击"测试已保存的模型连接"（测试用当前项目推理预算，90 秒超时，不派发员工）

### 本地模型目录

选择 Ollama/LM Studio/OpenAI 兼容 URL 后，点击"读取本地模型"获取目录列表。不自动保存或加载模型，仅用于辅助填写配置。

---

## 10. 开发与测试

### 开发命令

```powershell
npm run check   # TypeScript 静态检查 + node --check 关键 .mjs 文件
npm run build   # tsc 编译到 dist/
npm test        # 完整回归（当前 113 项，使用隔离数据库 + 假 CLI）
npm run test:real  # 真实协作验收（调用真实 Pi + 阿里模型，产生费用）
npm start       # 先 build 再启动服务
```

### 测试覆盖

| 测试文件 | 覆盖内容 |
|---|---|
| `test/agent-os.test.mjs` | Agent OS 入口 |
| `test/messaging.test.mjs` | Mailbox 消息协议 |
| `test/coordinator.test.mjs` | 协调器逻辑 |
| `test/apix-agent.test.mjs` | 管理者 Agent |
| `test/model-settings-ui.test.mjs` | 模型设置界面 |
| `test/conversation-ui.test.mjs` | 对话界面 |
| `test/local-models.test.mjs` | 本地模型目录 |
| `test/collaboration.test.mjs` | 协作流程 |
| `test/execution-control.test.mjs` | 执行控制 |
| `test/execution-ui.test.mjs` | 执行界面 |
| `test/scheduling.test.mjs` | 调度与预算 |
| `test/environment.test.mjs` | 环境检查 |
| `test/readiness.test.mjs` | 就绪检查 |
| `test/memory.test.mjs` | 项目记忆 |

**假 CLI 文件**：`test/fake-claude.mjs`、`test/fake-codex.mjs`、`test/fake-pi.mjs`、`test/fake-provider.mjs`——用于隔离测试，不调用真实付费模型。

### 提交规则（AGENTS.md）

1. 提交前审查最终 diff（新增文件、调用方、错误路径、数据一致性、访问边界）
2. 修复发现的问题并执行相关验证
3. 审查结论记录到 `协作/`，自审如实标注
4. 只有审查通过后才能提交
5. 用明确文件清单暂存（不用 `git add .`）
6. 未经用户要求不推送或合并

---

## 11. 双 Agent 协作模式

项目采用 **Codex + Claude Code CLI** 双 Agent 协作开发模式，由用户按轮次指定分工。

### 文件归属（当前第三轮）

| 归属方 | 可修改文件 |
|---|---|
| **Codex** | `src/coordinator.ts`、`control-plane.mjs`、`src/task-scheduler.mjs`、`src/execution-control.mjs`、后端测试、`server.mjs`、`package.json`、README、产品文档 |
| **Claude** | `web/coordinator.ts`、`web/execution-view.ts`（确有必要时）、`coordinator.css`、前端测试 |
| **保留** | `.gitignore`、`.claude/skills/`、已有未跟踪说明文件、其他模块 |

### 协作约定

- 领取时写 RUNNING + 基线 + 文件清单；交付时写 READY + diff + 测试结果 + 未验证项
- 双方只修改自己的文件；`dist/` 构建与完整测试由 Codex 集中执行
- 不使用 `git add .`、reset、clean 或自动切换分支
- 双方独立审查对方最终 diff，审查未实际发生不能标"互审通过"

### 协作历史摘要

| 轮次 | 主要内容 |
|---|---|
| 第一轮 | 流式对话（C5）、模型配置（C1/C2）、测试隔离（C3）、集成验收（V2/C4） |
| 第二轮 | 单 Agent 修复阶段：Claude 聊天交互/模型配置前端缺陷，由 Codex 接手修复 |
| P0–P2 | 六项改进：执行管理、恢复、浏览器验收；66/66 回归通过 |
| 能力会议预算 | S1 能力/账户档案、S2 规划会议、S3 执行/改派/反馈；82/82 回归（含超时复验） |
| N1/N3 | 本地模型目录读取、独立推理连接测试 |
| P0–P2 就绪改进 | 113/113 回归；真实 Pi/Codex/Claude 端到端联调补验通过 |
| 第三轮（计划中） | 排队任务换员工（C7/L7）；Codex 后端，Claude 前端 |

---

## 12. 已验证范围与已知限制

### 已验证

| 范围 | 状态 |
|---|---|
| 代码基线 `93595d9`（工具派发修复） | Windows CI，Node.js 22.19.0，100/100 测试 |
| 当前 P0–P2 就绪改进 | 113/113 完整回归 |
| 管理者真实模型（Pi + 阿里 qwen3.7-flash） | read/bash/write 工具 + 真实文件变化 + 任务派发通过 |
| 真实多员工端到端 | Pi 规划 + Codex 写入/冻结 + Claude 接收指导 + Node 验证 + 双员工验收通过 |
| 浏览器界面 | 1360×900 和 390×844 流式对话、详情开合、窄屏布局 |

### 已知限制

- Gemini CLI、OpenCode、Kimi Code 真实 CLI 联调**待验**
- 供应商用量同步、价格同步**未实现**
- 操作系统级沙箱**未实现**（worktree 和写入范围声明不等于 OS 沙箱）
- 远程多用户认证**未实现**（仅监听本机）
- 本轮新界面（P0–P2 就绪改进）视觉浏览器验收**待补**
- 全局账户余额管理**未实现**

---

## 13. 文档导航

| 文档 | 内容 |
|---|---|
| [架构设计文档](../../架构设计.md) | 当前模块、执行链、数据表、核心接口及边界（权威） |
| [README](../../../README.md) | 项目介绍、快速开始、功能表、配置指南 |
| [docs/代码索引.md](../../参考/代码索引.md) | 实现入口索引 |
| [docs/agent-message-protocol.md](../../参考/agent-message-protocol.md) | Mailbox 协议、运行身份、消息交接 |
| [协作/开发计划与进度.md](../../../协作/开发计划与进度.md) | 各轮次进度与历史 |
| [协作/第三轮双Agent协作计划.md](../../../协作/第三轮双Agent协作计划.md) | 当前轮次任务、接口约定、文件归属 |
| [协作/能力会议预算开发与审查.md](../../../协作/能力会议预算开发与审查.md) | 能力调度、会议、共享账户实现与验证 |
| [协作/桌面对话与自动协作开发审查.md](../../../协作/桌面对话与自动协作开发审查.md) | 交互和自动安排流程 |
| [协作/就绪改进P0到P2开发与审查.md](../../../协作/就绪改进P0到P2开发与审查.md) | P0–P2 六项改进 + 真实联调补验记录 |
| [协作/ApiX工具与任务派发修复审查.md](../../../协作/ApiX工具与任务派发修复审查.md) | 工具派发修复审查 |
| [AGENTS.md](../../../AGENTS.md) | 开发与提交规则 |
| [docs/分支管理.md](../阶段设计与分支历史.md#分支管理历史) | 分支历史 |

---

*本 Wiki 由 Claude Code 初次生成于 2026-10-13，后续随功能开发持续更新。*
