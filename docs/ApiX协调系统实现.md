# ApiX 协调系统：实现、接口与验收

本文件描述 `codex/agent-coordinator` 的实现。早期 Phase 文档保留为设计历史。

## 1. 产品与身份

ApiX 是管理者 Agent，负责沟通、需求整理、计划、分工和监督。Pi 是推理基础设施；注册为员工的 Pi 是另一个身份。用户对 ApiX 说目标，ApiX 输出澄清问题、需求摘要、任务计划和有实际状态依据的进度。代码、报告等任务成果由员工执行产生，并附来源与验收记录。

UI 以项目中的目标会话为单位，支持多个目标并行。需求不完整时不能创建执行计划；完整度达到 100%、无待处理冲突并获得用户确认后，进入任务安排。

## 2. 分层架构

| 层 | 组件 | 责任 |
| --- | --- | --- |
| 交互层 | TypeScript 目标工作台、管理页面 | 沟通、检查需求、修改计划、权限选择、验收 |
| 应用层 | Coordinator | 目标会话、版本、确认、派发和用户中途干预 |
| 领域层 | Requirement Engine、Permissions、Task Tracker | 完整度、执行门槛、权限版本、真实状态派生 |
| Agent 层 | ApiX Agent、ModelBackend | 管理者身份、Pi 推理、结构化需求与计划 |
| 协作层 | Scheduler、Mailbox | DAG 调度、通信、事件、交付物关联与资源租约 |
| 记忆层 | Memory Ledger | 独立持久化事件、快照、回放及检索 |
| 基础设施 | SQLite、Runtime Adapters、Git worktree | 存储、第三方 CLI 进程、隔离工作目录 |

核心路径：用户 → Coordinator → Requirement Engine → 用户确认 → ApiX 计划 → Permissions → Scheduler → Runtime Adapter → 员工。真实运行事件回到 Task Tracker 和 Memory，实际输出进入 artifacts，用户验收后目标才完成。

ApiX 的 Pi 调用关闭工具，使用自己的管理者身份提示。模型仅建议数据，不具有授权能力。所有副作用都经过控制平面的需求与权限检查。

## 3. 核心接口

完整类型定义位于 `src/contracts.ts`，实现入口见《代码索引》。关键类型如下：

```ts
type PermissionMode = 'full_access' | 'ask_approval' | 'read_only';
type Requirements = Record<
  'goal' | 'scope' | 'constraints' | 'deliverable' | 'acceptance', string
>;
interface PlanStep {
  prompt: string;
  employeeId: string;
  dependsOn: number[];
}
interface ModelBackend { infer(prompt: string): Promise<string> }
interface Policy { mode: PermissionMode; version: number }
```

| API | 输入要点 | 行为 |
| --- | --- | --- |
| POST /api/coordination/sessions | projectId, goal | 建立独立目标会话 |
| GET /api/coordination/sessions | projectId，summary=1 可选 | 项目目标；摘要模式省略对话、能力、指导和完整任务 |
| POST /api/coordination/sessions/:id/messages | revision, content | 沟通、带证据提取字段；不执行任务 |
| POST /api/coordination/sessions/:id/answers | revision, field, value | 显式编辑需求；增加需求版本 |
| POST /api/coordination/sessions/:id/confirm | revision | 检查完整度，记录确认版本并生成计划 |
| POST /api/coordination/sessions/:id/plan | revision, planVersion, steps | 生成新计划 ID，撤销旧待审任务 |
| POST /api/coordination/sessions/:id/dispatch | planVersion | 按最新权限授权并启动/排队 |
| POST /api/coordination/sessions/:id/revise | revision, reason | 撤销未启动任务、请求停止活动 Run、重开需求 |
| GET /api/coordination/sessions/:id/timeline | 可选 at 事件序号 | 最近快照和此前事件 |
| GET /api/coordination/memory | projectId, q | 项目事件关键词检索 |
| POST /api/permissions | projectId, subject, mode, version | 更新 ApiX 或员工权限，旧授权失效 |
| GET/POST /api/manager/settings | provider, model | 管理者实际模型配置 |
| POST /api/adapters | id, name, executable, args, format | 自定义非交互 CLI 注册 |
| POST /api/tasks/:id/review | accepted, fingerprint | 验收冻结代码；旧内容指纹拒绝 |
| GET /api/tasks/:id/delivery | 任务 ID | 工作区路径、代码差异、冻结版本、进程线索及恢复指纹 |
| POST /api/tasks/:id/recovery | revision, runId, fingerprint, reviewed, confirmedStopped?, employeeId? | 当前计划内失败/中断任务检查后重新批准，可换员工；unknown 须人工确认原进程停止 |
| GET/POST /api/projects/:id/execution | POST：version, projectLimit?, employeeLimit?, paused? | 项目与员工并发设置、版本化暂停新启动 |
| POST /api/projects/:id/execution/runtime | version, runtime, paused | 明确恢复已报告额度/速率限制的运行时 |
| GET /api/snapshot | If-None-Match 可选 | 原完整数据格式；无变化返回 ETag/304，重启使用新标记 |

编辑接口使用 revision/planVersion 防止覆盖过期数据；同一目标的异步推理期间拒绝冲突编辑。每次计划编辑创建全新 plan ID 作为 planVersion。不同目标可以独立推进。

## 4. 核心流程时序

### 正常执行

1. 用户提交目标，记录 user/apix 交互及初始快照。
2. 用户补充信息，ApiX 通过 Pi 返回结构化澄清、字段证据及冲突。字段证据必须出现在本次用户消息中；用户可以直接修改摘要。
3. Requirement Engine 检查五项字段；完整度表示字段覆盖率，不是语义正确性的保证。
4. 用户确认当前 revision；ApiX 按员工岗位生成 1～8 步计划；依赖只能指向前序步骤，保证无环。
5. 请求批准模式等待用户审查；管理者和全部目标员工均为完全访问且模型计划有效时自动派发。模型失败的规则草案始终等待人工检查。
6. 控制平面为每个任务生成双方权限版本绑定的 grant，记录启动审批。调度器启动无依赖步骤，其余步骤排队。
7. 适配器在 Git worktree 启动员工，发放本次 Run 的 mailbox 凭据；记录原生事件和实际输出。
8. 前置成功后推进依赖；失败向下游传播。员工执行完成后目标进入待验收，全部任务通过验收才完成。

### 运行中的自主指导

1. 员工通过带 Run 凭据的 `/api/agent/messages` 向 `apix-director` 发送 `type=event`、`payload={kind:'progress_update',summary,blocked}`。服务器用凭据绑定项目、任务和发送者，拒绝身份伪造。
2. ApiX 对进度报告做幂等登记，并核对当前计划、需求版本、权限 grant、员工和 Run 状态。Pi 只选择 `guide`、`escalate` 或 `observe`，以及从已确认需求选取的关注点。指导正文由控制平面从已批准任务和确认需求构造，不允许模型新增任务或授权。
3. `guide` 发送有来源和版本的 mailbox 消息，员工读取、确认并继续执行；`escalate` 把阻塞展示给用户；`observe` 只记真实进度。每个任务最多自动发送三次指导，之后转为用户关注，避免循环指令。
4. 运行超过一分钟且近期没有员工报告时，ApiX 主动发送一次进度请求。用户还可向运行中的员工发送当前任务范围内的补充说明，或通过“中途调整”撤销旧计划并请求停止。
5. 决策、消息与状态写入目标会话、mailbox 事件和独立账本。计划或权限在推理期间变化，结果丢弃并记录跳过原因。员工进程必须主动读取 mailbox；不能读取的 CLI 不支持即时进程内指导。

### 中途修改与撤权

用户请求调整 → 取消待启动步骤并撤销审批 → 请求停止活动 Run → 需求 revision 增加、确认失效 → 用户检查工作区 → 修改并重新确认。旧 Run 处于 running/stopping/unknown 时阻止新计划启动，避免把停止请求当作停止完成。

权限更新增加版本，所有旧版本 grant 失效；降低授权会请求停止活动任务。已派发的旧计划需通过“调整需求”重新安排。外部 CLI 已经完成的动作无法撤回。

### 失败与重启

Pi 无法推理或返回非法 JSON → 标明规则降级 → 不自动执行。CLI 启动/退出失败 → 写入错误与真实状态 → 阻塞后续依赖。服务重启 → 活动 Run 标为 unknown 并记录恢复事件 → 不自动重新派发。

## 5. 共享 mailbox 与独立记忆

员工环境变量包含 APIX_AGENT_TOKEN、APIX_AGENT_ID、APIX_PROJECT_ID、APIX_MAILBOX_URL。数据库只存 token 哈希；运行结束后凭据失效。通过 `/api/agent/team` 查询团队，通过 `/api/agent/messages` 收发，通过 `/api/agent/messages/:id/ack|complete|nack` 确认或重试。项目、发送者、任务身份由凭据绑定，不相信请求自报身份。消息处理还会校验项目。

mailbox 保留请求关联、幂等、TTL、重试、交付物摘要引用、消息规则拦截及资源租约。详见消息协议。管理端的 Agent 消息监督位于“任务与员工”。员工无需共享各 CLI 的原生会话文件。

独立 apix_ledger 保存交互、需求/计划快照、执行授权、运行事件、消息、验收及输出来源。按项目检索，按全局事件序号重建目标最近一次已提交状态。旧版本事件无法追造；原有表和项目记忆继续保留。最近已确认目标摘要及用户维护的项目记忆进入新沟通作为参考，不能作为当前用户确认。

## 6. 权限边界

| ApiX / 员工 | read_only | ask_approval | full_access |
| --- | --- | --- | --- |
| read_only | 拒绝启动 | 拒绝启动 | 拒绝启动 |
| ask_approval | 拒绝启动 | 用户批准 | 用户批准 |
| full_access | 拒绝启动 | 用户批准 | 可自动派发有效模型计划 |

上述模式控制任务启动权限。外部 CLI 的文件/网络能力受其自身权限和系统用户约束；ApiX 当前不提供 OS 沙箱或逐工具审批。完整访问时 Codex/Claude 使用其对应权限跳过参数，Pi/自定义 CLI 的执行能力由运行时配置决定。

管理 API 仍处于可信本机模式。Host/Origin 检查、员工 token 和静态文件白名单不能替代多用户认证。不要把服务直接暴露到网络。

## 7. 验收标准与实现路线

本次已完成：TypeScript 协调领域、实际 Pi 管理者推理、需求门槛、版本化计划、权限闭环、独立事件记忆、运行适配器、员工 mailbox 接入及目标工作台。

自动化验收覆盖：不完整/过期需求拒绝、默认零执行、旧直接派发入口拒绝、只读拒绝、双方全权才自动执行、撤权停止、不可变计划、模型配置持久化、消息身份绑定、适配器命令替换拒绝、历史回放和重启、调度失败传播；保留旧版迁移、并行、集成、消息重试/超时/锁等回归。假 CLI 测试通过不代表所有真实版本已联调。

后续独立迭代按以下顺序验收：

1. 真实 Pi/Codex/Claude 版本兼容矩阵：在隔离测试项目验证授权参数、停止、错误输出与工作区产物；为 Qoder 等编写经过验证的原生适配器。
2. 逐工具审批与隔离：需要运行时支持或 OS 执行代理；以跨目录访问、网络访问、撤权中断测试作为门槛。
3. 记忆规模化：事件分页、全文索引、带来源的摘要压缩和可撤销记忆；验证历史重放一致性及检索预算。
4. 剩余基础设施迁移 TS：先进程托管和 SQLite 存储，再 mailbox、调度和管理页面；以本次行为测试维持兼容。
5. 后台监督与恢复：持续消息超时处理、运行租约、人工确认 unknown、受审批的重规划；不得自动重放可能已执行的副作用。

## 8. 升级与回退

升级前停止服务并备份 APIX_DATA_DIR。执行 npm ci、npm run check、npm test 后 npm start。旧数据原地保留，新增协调表和独立账本；旧聊天派发接口默认关闭。APIX_LEGACY_API=1 仅用于显式兼容旧流程，会放宽未绑定协调需求的旧任务门槛。

代码和产物分离：编辑 src/*.ts、web/*.ts，通过 tsc 生成 dist。旧 Pi fork 和历史工作树不受本次改造影响。回退使用升级前代码及备份数据库，不以删除表方式回退。
