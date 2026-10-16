# ApiX 当前架构、模块关系与主 Agent loop

代码基线：`codex/readiness-p0-p2`，`3f5f22c62d3b072c88af2ef91ef7963e86d4fcb5`，2026-10-16。本页描述该提交的实际实现，不代表当前启动进程已加载这个版本，也不是生产可用性认证。

[打开四图浏览页](../.archify/architecture-apix-current-20261016-192305/index.html) · [交互框架图](../.archify/architecture-apix-current-20261016-192305/overview/overview.html) · [交互模块图](../.archify/architecture-apix-current-20261016-192305/modules/modules.html)

## 1. 系统框架

```mermaid
flowchart TB
    U[用户：自然语言、多轮对话] --> UI[桌面对话式 Web 界面]
    UI --> API[server.mjs：本机 HTTP API]
    API --> HOST[control-plane.mjs：依赖装配与执行宿主]
    HOST --> MAIN[assistant-loop：ApiX 主循环]
    MAIN --> MODEL[model-backend：独立模型 API]
    MODEL -->|结构化动作| MAIN
    MAIN -->|工具调用| BRIDGE[宿主 execute 工具桥]
    BRIDGE --> LOCAL[文件、命令、验证、Skill 与项目记忆]
    BRIDGE -->|delegate| TEAM[契约规划、任务调度与自主验收]
    TEAM --> CLI[可选员工：Pi、Codex、Claude 等 CLI]
    CLI --> WT[托管 Git worktree：实现与产物]
    TEAM -->|宿主检查、冻结与交接| WT
    HOST --> DB[(SQLite：会话、事件、权限、预算、契约、证据)]
    TEAM -->|子流程结果| MAIN
    MAIN -->|公开活动、结果、批准与选择请求| UI
```

ApiX 自己实现主循环并调用模型 API。Pi 与 Codex、Claude 同属可选执行员工，主循环不依赖 Pi。OpenAI Chat Completions、Responses 和 Anthropic Messages 是模型接入协议，不意味着绑定某个模型品牌。

默认对话入口是 `/api/assistant/sessions`。旧 `/api/coordination/sessions` 目标工作台仍保留，并作为复杂委派的子流程。默认主循环的工具目录目前没有通用 `call_mcp`；界面的 MCP 资源登记不能直接等同于主循环已具备任意 MCP 工具调用能力。

## 2. 模块关系

```mermaid
flowchart TB
    HOST[control-plane：共享 Store 与依赖注入] --> LOOP[assistant-loop：会话与动作状态机]
    HOST --> COORD[coordinator：需求、计划与子会话]
    LOOP -->|通过宿主 infer| MODEL[model-backend：HTTP 模型推理]
    LOOP -->|通过宿主 execute| TOOLS[assistant-tools：文件、进程、规则与 Skill]
    LOOP --> NOTES[assistant_notes：跨对话项目笔记]
    COORD --> AGENT[apix-agent：架构、计划、审查与指导]
    AGENT -->|通过宿主 infer| MODEL
    COORD --> CONTRACT[architecture：接口、数据结构、边界与契约摘要]
    COORD --> COST[scheduling：能力、难度、费率、预算与候选排序]
    HOST --> DAG[task-scheduler：前置验收与准入]
    DAG -->|宿主 launch| RUN[CLI 进程、runtime-adapters 与 execution-control]
    HOST --> AUTO[autonomy：定时监督、检查与有界返工]
    AUTO -->|候选、改派与修复| COST
    AUTO -->|通过 coordinator 请求质量审查| AGENT
    AUTO -->|请求宿主验收、停止与冻结| RUN
    HOST --> GIT[code-handoffs：冻结交付与依赖代码交接]
    HOST --> MAIL[agent-mailbox 与 mailbox：任务通信和运行凭据]
    HOST --> PERM[permissions 与 workflow：权限和持续项目授权]
    HOST --> MEM[memory：协作事件账本与检索]
```

箭头表示直接调用或标注了“通过宿主”的间接调用，不等于每两个模块都直接 import。`control-plane.mjs` 仍集中承担不少装配和执行责任，当前不是已经拆成独立部署服务的微服务系统。

| 责任 | 当前实现 | 关键边界 |
|---|---|---|
| 主循环 | `src/assistant-loop.ts` | `tool / ask / finish`，持久化等待与恢复状态 |
| 模型后端 | `src/model-backend.ts` | HTTP 流式推理，90 秒超时，可取消，失败不自动重试 |
| 工具和上下文 | `src/assistant-tools.ts` | 项目文件、直接进程调用、规则文件和 Skill 内容；不隐式使用 shell |
| 架构规划 | `src/apix-agent.ts`、`src/architecture.ts` | 冻结模块 paths、依赖、接口 schema、数据结构、验收条件和检查 ID |
| 成本与难度 | `src/scheduling.ts` | 质量门槛后比较费用；未知费用不当作零，预估不自动授予费用上界 |
| 排队与执行 | `src/task-scheduler.mjs`、`src/execution-control.mjs`、`src/runtime-adapters.ts` | 前置 accepted、权限、并发、额度和运行时准入 |
| 自动质量闭环 | `src/autonomy.ts` | 实际脚本、代码指纹、ApiX 自审、修复任务、再次执行 |
| 代码交接 | `src/code-handoffs.mjs` | 冻结版本后向依赖任务交接，不代表已合并原分支或推送 GitHub |
| 通信 | `src/agent-mailbox.ts`、`src/mailbox.mjs` | 按项目、任务和运行凭据控制访问；员工必须主动读取消息 |
| 记忆与授权 | `src/memory.ts`、`src/permissions.ts`、`src/workflow.ts` | 事件、笔记与授权分开；记忆和 Skill 本身不授予权限 |

## 3. 复杂任务协作流程

```mermaid
flowchart TD
    A[主循环决定委派复杂任务] --> B{员工、持续授权、实际验收脚本已准备？}
    B -->|否| C[检查现有项目与运行时，向用户申请 configure_agents]
    C -->|用户批准且配置成功| D[生成并校验统一架构契约]
    B -->|是| D
    D --> E[生成实现任务，并附加系统集成任务]
    E --> F[按能力门槛、难度、工作量、声明费率与预算选择员工]
    F --> G[冻结计划与授权；进入 DAG 队列]
    G --> H[前置任务 accepted 且准入通过后，在独立工作区启动 CLI]
    H --> I[收集真实产物与运行证据]
    I --> J[运行已授权验收脚本，检查代码边界与指纹]
    J --> K[实际检查通过后，由 ApiX 进行代码自审]
    J -->|测试失败或越界| R[生成明确修复任务；允许时选择其他合格员工]
    K -->|未通过| R
    R -->|未超限、进程已确认停止| H
    K -->|通过| L[accepted：冻结交付 commit]
    L -->|仍有后续模块或集成任务| G
    L -->|全部任务包含集成均已验收| M[子流程完成，结果与证据返回主循环]
    T[独立监督定时器：按风险发送检查点、检测超时、阻塞与失联] -->|指导或请求停止| H
    T -->|无法确认状态| X[attention：暂停并请求检查]
    R -->|达到上限或无合格员工| X
```

`architecture.bindArchitecture()` 自动附加依赖所有实现模块的 `integration` 任务。实现模块与集成任务都要通过实际检查和 ApiX 自审，才算整个协作子流程完成。自审返回 `reviewMode: apix_self_review`，不能将其称为独立审查。

默认自主交付策略为：最多修复 2 次、目标 120 分钟、员工运行 30 分钟、检查点基准 5 分钟。高风险检查间隔减半，低风险加倍。宿主的监督 tick 默认 15 秒；主循环检查子流程完成状态的 tick 为 1 秒。这些是不同的计时器。

当前动态调整包括排队改派、修复任务换人、确认停止后的恢复，以及显式修改需求后重新规划。冻结模块契约发生变化时不会任意继续执行；当前没有可在任何情况下自动重写全部架构契约的通用重规划引擎。

## 4. 主 Agent loop

```mermaid
flowchart TD
    A[收到用户新消息，写入持久化事件] --> B[重建上下文：初始与最新请求、摘要、历史、规则、记忆与项目状态]
    B --> C[独立模型 API 返回结构化决策]
    C --> D{action}
    D -->|ask| U[waiting_user：显示问题、单选或多选]
    U -->|用户回答通过版本校验| B
    D -->|tool| P{权限、拒绝记录、项目状态与参数校验}
    P -->|需要批准| Q[waiting_user：展示本次工具及参数]
    Q -->|批准且权限版本、文件指纹一致| E[宿主执行工具]
    Q -->|拒绝| B
    P -->|已获准| E
    E -->|普通工具| R[记录真实成功或失败结果、验证证据]
    R --> B
    E -->|delegate 返回子会话| W[waiting_agents：暂停主循环推理]
    W --> T[每秒检查子流程；调度与自主监督独立推进]
    T -->|仍在执行| W
    T -->|全部 accepted| V[写入 delegation_result，恢复主循环]
    V --> B
    T -->|阻塞、取消或需人工处理| X[attention]
    D -->|finish completed| F{有副作用时，是否有当前文件指纹的成功 verify？}
    F -->|否| R
    F -->|是，或本轮无需 verify| DONE[答复用户，completed；仍可接收下一轮消息]
    D -->|finish blocked| X
    C -->|格式错误、调用失败或达到本轮上限| X
    E -->|进程停止情况未知、权限变化| X
    X -->|用户检查并明确恢复| RESUME{仍有子会话？}
    RESUME -->|是| W
    RESUME -->|否| B
```

真实循环位于 `src/assistant-loop.ts:90`，核心是 `while (get(id).status === 'running')`。每次工具结果会参与下一次决策；主循环不是“生成一次计划后线性执行到结束”。

但它也不是不受约束的无限循环：每轮最多 24 步或 30 分钟。等待用户或员工时退出当前 `run()`，由用户回复或定时器重新 `kick()`。用户停止会取消模型请求和当前工具，并请求停止子流程；服务重启会把中断主会话置为 `attention`，需要检查后恢复，不自动重放未确认副作用。

`send_agent_message` 已在工具目录，但主循环处于 `waiting_agents` 时不会自主继续推理发送指导；这一阶段主要靠 `autonomy` 的检查点和协作消息处理推进。不能把这个设计描述为“主模型一直思考并实时管理每个员工”。

## 上下文、成本与交付的准确含义

- **上下文与记忆**：项目笔记在不同主会话之间共享；历史超过约 28000 字符且多于 8 条时压缩旧事件，保留最近 8 条、最多 6000 字符摘要、初始请求与最新请求。另有协作事件记忆，不是所有 Agent 共享无限上下文。
- **难度成本路由**：模型提供任务难度和工作量，候选员工依据用户声明的能力与模型档案筛选；已声明且模型匹配的费率用于费用预测。没有费率、额度或可信观测时保持未知，不能声称已经自动测得每个 Agent 的真实能力与实际账单。
- **验证强度**：执行成功不等于验收；但验收仍受已授权测试脚本和可审查代码范围限制，不能证明所有业务场景完美。
- **Git 与 GitHub**：已实现托管工作区、冻结交付与依赖交接。协作完成信息明确说成果保存在托管工作区；主循环完成不会自动等于合并原分支、推送 GitHub、创建 PR 或部署。主循环可在获得权限后执行相关命令，但这些不属于当前交付闭环的固定步骤。

## 主要源码证据

| 行为 | 位置 |
|---|---|
| HTTP 主会话入口 | [server.mjs](../server.mjs#L136) |
| 依赖注入、工具桥、delegate、子流程结果 | [control-plane.mjs](../control-plane.mjs#L1264) |
| 主循环、完成门槛、批准、恢复与 tick | [assistant-loop.ts](../src/assistant-loop.ts#L90) |
| 上下文压缩与项目笔记 | [assistant-loop.ts](../src/assistant-loop.ts#L79) |
| 架构与计划生成、授权后派发 | [coordinator.ts](../src/coordinator.ts#L204) |
| 契约验证、模块绑定与集成任务 | [architecture.ts](../src/architecture.ts#L49) |
| 能力门槛、费用预测、候选排序 | [scheduling.ts](../src/scheduling.ts#L141) |
| 前置验收与排队执行 | [task-scheduler.mjs](../src/task-scheduler.mjs#L3) |
| 返工、测试与自审、周期监督 | [autonomy.ts](../src/autonomy.ts#L91) |
| 自审标识 | [apix-agent.ts](../src/apix-agent.ts#L101) |
| 冻结交付与代码交接 | [code-handoffs.mjs](../src/code-handoffs.mjs#L50) |
| 子流程交付边界 | [coordinator.ts](../src/coordinator.ts#L474) |

图形核验、源码引用检查、浏览器检查与人工视觉复核是不同的结果，详见本次 `协作/` 自审记录。本页未改变 ApiX 的程序逻辑或运行配置。
