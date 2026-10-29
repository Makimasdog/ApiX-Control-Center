# Codex 与 Claude Code 协作开发任务书

2026-10-12 用户已明确恢复双 Agent 协作，当前执行入口为 [第三轮双 Agent 协作计划](第三轮双Agent协作计划.md)。下文保留第一、二轮历史分工，不作为当前文件归属或未完成任务清单；工作模式见 [当前工作模式](../../当前工作模式.md)。

日期：2026-10-11
基线：`codex/agent-provider-adapters`，`0af1b0b`。开始执行前各自重新核对状态。
需求来源：用户要求为当前 Codex 与右侧终端中的 Claude Code CLI 规划、划分和分配下一步工作；新增对话模式下类似 Codex 的流式聊天体验。
参考：[Claude 工作检查与下一步开发计划](Claude工作检查与下一步开发计划.md)。
本轮新增需求：[ApiX 流式对话需求与验收](ApiX流式对话需求与验收.md)。所有协作计划、进度、交接和验收记录集中在项目根目录 `协作/`。

## 本轮目标与分工

完成对话模式下的连续流式聊天体验，以及管理者模型配置的正确性修复、统一平台目录及校验，建立可重复的回归验证。流式对话为新增用户需求，优先于测试环境整理和文档收口。第一轮不新增平台，不更换 UI 主题，不开发连接探测、调度恢复、OS 沙箱或记忆系统。

| 执行者 | 职责 | 可立即开始的工作 | 对另一方的依赖 |
| --- | --- | --- | --- |
| Codex（本聊天） | 后端、测试审查与集成 | V1 复验准备与测试审查；完成的后端任务保持交付 | V2/C4 重验等待 Claude R3 READY |
| Claude Code（右侧 CLI） | 流式聊天界面、配置前端、交互回归与文档 | R1 聊天修复 → R2 目录与配置 → R3 交接 | C2 已完成，目录接入无后端阻塞 |

执行状态以 [开发计划与进度](开发计划与进度.md) 和各自工作记录为准：Codex C1/C2/C3/C5 已完成，完整自动化通过；Claude 已交付前端初稿，L2 目录接入及实际浏览器发现的修复尚待完成。C4 首轮审查与验证已执行，整体聊天验收等待前端修复后重验。具体问题见 [集成审查与待修复](集成审查与待修复.md)。

## 文件归属

双方在现有共享工作目录协作，第一轮不切换分支或另建工作树。通过文件归属避免相互覆盖。

| 归属 | 允许修改的文件 |
| --- | --- |
| Codex | `src/model-providers.ts`、`src/coordinator.ts`、`src/apix-agent.ts`、`src/contracts.ts`（确有类型调整需要才改）、`control-plane.mjs`（管理者推理与流式路径）、`server.mjs`、`test/coordinator.test.mjs`、`test/apix-agent.test.mjs`、`test/fake-pi.mjs`、`test/agent-os.test.mjs`、`package.json`（仅测试命令所需调整）、`README.md`、`docs/功能与限制.md`、`协作/归档/2026-10/Codex工作记录.md` |
| Claude | `web/coordinator.ts`、`coordinator.css`（聊天与配置所需样式）、新增 `web/model-settings.ts`、`web/conversation-stream.ts`（确有必要才拆）、新增 `test/model-settings-ui.test.mjs`、`test/conversation-ui.test.mjs`、`.claude/MODEL_PROVIDERS.md`、`.claude/CHANGELOG.md`、`协作/归档/2026-10/Claude工作记录.md` |
| 本轮冻结 | `.gitignore`、`.claude/settings.local.json`、`.claude/skills/`、现有未跟踪的根目录说明与测试页面、其他 CSS、其他业务模块 |
| 共同约定 | 本任务书、需求及共享计划由 Codex协调维护；工作记录各自维护；其他未列出的文件须先在交接中提出并由本聊天协调归属 |

开始前的未提交内容包含 `.gitignore`、Claude 本地设置/skills、数份说明文件及检查报告。保留这些内容，不清理、不覆盖、不混入功能提交。`dist/` 是共享编译输出，完整构建和测试由 Codex 集中执行，避免同时编译或清理产物。

## 前后端接口约定

### 既有设置接口保持兼容

`GET /api/manager/settings` 与 `POST /api/manager/settings` 保持以下五字段形状：

```ts
type ManagerSettings = {
  provider: string;
  model: string;
  baseUrl: string;
  apiType: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  apiKeyEnv: string;
};
```

- 全空 provider/model/baseUrl 表示 Pi 默认配置，保留这一行为。
- 无 baseUrl 的旧 Pi provider/model 必须可查看、保留和保存，不静默清空。
- 有 baseUrl 的设置继续以 `provider: 'apix-custom'` 持久化；第一轮不改数据库结构。
- 保存成功只表示配置已保存，不表示连通性已验证。
- 远程自定义 URL 要求填写合法的 Key 环境变量名；回环 URL 可不填。使用解析后的 hostname 判断回环地址，统一前后端解释。
- 环境变量是否实际存在仍在调用时检查，第一轮不把服务环境的 Key 状态或密钥值发送到浏览器。
- 验证失败返回现有 HTTP 400 / `{error: string}`，不覆盖已保存配置。

### Codex 新增只读平台目录接口

`GET /api/manager/providers` 返回：

```ts
type ProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  apiType: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  requiresApiKey: boolean;
  defaultApiKeyEnv?: string;
  models: {
    id: string;
    name: string;
    contextWindow?: number;
    description?: string;
  }[];
  description?: string;
};
type ProviderResponse = { providers: ProviderConfig[] };
```

- 数据来自 `src/model-providers.ts` 的 `BUILTIN_PROVIDERS`，不复制目录。
- `defaultApiKeyEnv` 是变量名，不是变量值。
- 前端通过同源 API 读取目录，不直接 import `dist/src/*`，不扩大静态文件白名单。
- 用目录生成平台选项和模型选项；Pi 默认与自定义模式为前端固定选项。
- 接口失败时明确显示加载错误，避免把加载失败误判为 Pi 默认配置并覆盖已有设置；不加入第二份硬编码目录作为 fallback。
- Claude 可先完成状态逻辑和目录 fixture 的测试，Codex 接口就绪后再联调。接口变更由 Codex先更新任务书和交接记录。

### 流式聊天接口

复用现有 `POST /api/coordination/sessions/:id/messages/stream`，请求为 `{revision: number, content: string}`，事件保持 `start`、`delta`、`complete`、`error`。准确格式、状态处理和验收场景见 [流式对话需求](ApiX流式对话需求与验收.md)。第一轮不另建 WebSocket 或第二套聊天存储。任何协议调整先更新共同需求，避免两方各自扩展。

## Codex 任务清单

### C1：统一后端验证（优先）

把 `src/model-providers.ts` 中的验证接入实际保存流程，保留现有长度、前导 `-`、URL 协议/认证信息/查询参数/锚点、API 类型和变量名约束。补齐非法 URL 的可读错误，明确远程缺 Key 的保存策略，不为复用函数丢失已有校验。

验收：默认配置、旧 Pi provider/model、本地无 Key、自定义远程有 Key 可保存；非法输入、远程缺 Key 返回 400；任何失败均保留旧设置。测试使用隔离数据库和假 CLI，不读取真实 Key，不调用真实模型。

### C2：提供平台目录接口（可与 C1 顺序实施）

实现上述只读接口；验证目录来自单一来源、没有密钥值，并保持现有 Host/Origin 和静态访问边界。完成后在 `协作/归档/2026-10/Codex工作记录.md` 标记 `C2 READY`，附实际响应形状与检查结果，让 Claude 接入。

### C3：验证环境与测试隔离

上一轮系统 Node 为 `22.15.0`，FTS5 不可用；已验证 bundled Node 为 `24.19.0`。本轮优先使用已有可用运行时，不自行安装或更改全局 Node。

可用路径：

```powershell
& 'C:/Users/1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --version
```

将 `test/agent-os.test.mjs` 中依赖当前仓库创建 worktree 的旧测试改为临时 Git 仓库，保持原有依赖执行、审批、产物验收，不弱化断言。临时目录递归清理前验证绝对路径在本次创建的临时根目录内。确认 FTS5 能力、静态检查及原有回归。

### C4：集成与审查

在 Claude 报告 READY 后，审查前端改动和行为测试，统一调整 `package.json` 使新测试纳入常规测试命令。执行一次完整构建/测试及流式聊天、模式切换、模型配置的浏览器主流程验证；区分环境失败与功能失败，不重复运行无关测试。更新 README 与功能边界，把集成结果记入 `协作/归档/2026-10/开发计划与进度.md`，报告仍未完成的真实平台验收。

### C5：流式对话后端与一致性（新增，优先）

核对并完善现有 SSE → Pi 推理 → 协调会话的路径，使多轮对话增量真实来自模型，最终消息与持久化会话一致。重点处理 JSON `question` 字段增量提取、转义/分片、现有 1,000 字符回复上限对连续聊天的影响，以及执行阶段把模型回复替换成固定状态摘要的行为；采用能够保留自然回复且不改变已确认需求和授权的最小方案。

验证 start/delta/complete/error 顺序、非流式运行时兼容、模型失败降级、断流后的会话同步、并发请求/过期 revision 拒绝与 busy 释放。必要时给假 Pi 增加可控的延迟分片，以在 complete 到达前断言前端可收到 delta，而不是事后检查拼接后的全文。

第一轮客户端断开不等同于后端已取消，不能据此自动重复执行请求；若不增加服务端取消能力，明确采用“重新读取正式会话后再继续”的恢复行为。需求确认、计划审批与派发门槛维持既有规则。完成后在工作记录标记 `C5 READY` 并说明任何协议或行为变化。

## Claude Code 任务清单

### L1：修复前端配置状态（立即开始，不等后端）

1. 平台切换时清除旧自定义模型名，或采用有明确平台归属的最小草稿机制；本轮优先直接重置，防止旧模型覆盖新平台选择。
2. 回填匹配平台至少比较 URL 与 API 类型；协议不一致保持自定义模式。保存 → 刷新 → 再保存不得改变协议、模型、URL、Key 环境变量名。
3. 初始化和手动切换共用字段显示逻辑：本地 Key 字段隐藏，远程提示正确，模式切换没有残留。
4. 保留无 URL 的旧 Pi provider/model。必要时增加最小的“Pi 已配置模型”编辑入口，不以默认配置替代旧值。
5. 设置或目录还未加载、加载失败时，避免允许无意清空原配置的保存操作；用户仍可明确选择默认配置。

不要修改后端、扩大静态路由、重写整个工作台或引入新依赖。

### L2：统一目录接入

使用约定的 `GET /api/manager/providers`，移除 `web/coordinator.ts` 中重复的提供商表和重复平台选项。仅在需要测试或理清状态时提取最小模块至 `web/model-settings.ts`；不为了拆文件引入一套表单框架。

本地列表仍为示例，保留输入实际模型名的能力，不宣称 `local-model` 会自动解析当前加载模型。真实目录发现放在下一轮。

### L3：前端行为回归

新增 `test/model-settings-ui.test.mjs`，使用现有 Node/TypeScript 工具，不新装 DOM 库。测试实际状态逻辑或 DOM 行为，避免测试里重写同一套实现；如无法低成本测试 DOM，提取必要状态函数后测试输入、输出与保存 payload。

至少覆盖：

- DeepSeek 自定义名称 → 百炼预设，最终 payload 为百炼选定模型。
- OpenAI URL + Responses 回填再保存，仍为 Responses。
- 本地配置刷新与切换，Key 字段显示一致。
- 自定义模型、远程 Key 环境变量名回填并保留。
- 旧 Pi provider/model 重开与再保存不丢失。
- 切回 Pi 默认配置明确清空自定义字段。
- 目录/设置请求失败不自动覆盖已有配置。

测试命令由 Codex统一纳入 `package.json`，Claude 不修改该文件。先做局部自检，最终编译和完整测试由 Codex 执行。

### L4：文档与交接

修正 `.claude/MODEL_PROVIDERS.md` 中 `.env` 自动加载、固定本地模型名称和接入可用性的表述；统一远程 Key 条件。更新 `.claude/CHANGELOG.md` 的实际历史提交及本轮改动，未提交内容如实写未提交。第一轮不补未经查证的最新型号、价格或性能宣称。

完成后写 `协作/归档/2026-10/Claude工作记录.md`：任务状态、修改文件、修复证据、局部测试结果、需要 Codex集成检查的内容、尚未完成事项。逐项标记 L1–L5；只有代码和局部自检完成才标 READY，不把计划标为已完成。

### L5：对话模式下的连续流式聊天（新增，优先）

按 [流式对话需求](ApiX流式对话需求与验收.md) 完善现有对话区域：立即显示本轮用户消息、同一条 ApiX 消息累积真实增量、等待/生成/完成/失败状态、连续多轮输入、尊重阅读位置的滚动和最终会话对齐。完善断流错误、草稿保留、目标切换与异步结果归属，不以固定速度动画伪装模型流式输出。

复用当前布局和 SSE 协议，避免重写工作台。输入支持 Enter 发送、Shift+Enter 换行，并正确处理中文输入法组合态；生成期间明确禁用重复发送。如展示 Markdown，使用已有能力或最小安全实现，不将模型原文直接作为 HTML 注入。

新增 `test/conversation-ui.test.mjs`，覆盖分片/中文、增量展示、用户消息去重、complete 正式替换、error/EOF 草稿保留、连续两轮和切换目标不串消息等行为；实际 UI 验收记录在工作记录。C5 完成前可基于现有事件 fixture 开发，待后端 READY 后联调。

## 并行节奏和交接规则

以下第 1–2 项保留初始启动历史；当前启动顺序为 Claude R1 → R2 → R3、Codex V1 → V2，详见 [第二轮计划](第二轮修复与验收计划.md)。第 3–4 项继续作为集成规则。

1. **启动**：Claude 优先执行 L5，再做 L1/L3；Codex 优先执行 C5，再做 C1/C2。两边可立即并行，流式接口沿用现有形状。
2. **接口交接**：C5 READY 后完成流式联调；C2 READY 后 Claude完成 L2。Codex处理 C3，Claude处理 L4。
3. **集成**：双方各自标记 READY 后停止修改本轮文件，由 Codex进行 C4；发现前端问题交回 Claude修复，后端问题由 Codex修复。
4. **验收**：流式聊天验收、完整回归、关键配置序列通过，且文档与行为一致后，才把本轮标记为完成。

`协作/归档/2026-10/Codex工作记录.md` 与 `协作/归档/2026-10/Claude工作记录.md` 只由对应 Agent 写入，对方只读。内容包括任务 ID、状态（PLANNED / WORKING / BLOCKED / READY / DONE）、修改文件、运行命令及结果、待处理事项；READY 表示待集成，DONE 表示集成验收通过。需要修改对方文件时先记录请求，经本聊天协调后再换归属；不要用“顺手修复”绕过边界。

同一仓库开发期间不要执行 `git checkout/switch/reset/clean/stash`、全仓格式化、`git add .`、自动提交/推送或合并。最终提交由 Codex在双方停止写入、审查完成后按明确文件列表组织；本任务书不要求现在提交。需要服务验证时使用隔离 `APIX_DATA_DIR` 和独立端口，不保存到用户真实模型设置。遇到需要扩大范围或真实账号操作的事项，先交接，不自行执行。

## 可粘贴到 Claude Code 的启动指令

当前执行安排以 [第二轮修复与验收计划](第二轮修复与验收计划.md) 为准。C1/C2/C3/C5 已完成，以下启动指令已切换为前端修复和集成重验；上文 L1–L5 保留为任务定义。

```text
请读取 协作/归档/2026-10/第二轮修复与验收计划.md、协作/归档/2026-10/集成审查与待修复.md 和本任务书。按顺序执行 R1 聊天生命周期与实际实现回归、R2 统一目录与配置保留、R3 文档及交接。C2 已完成，L2 无后端阻塞；正式消息角色为 apix，目录字段为 defaultApiKeyEnv。严格遵守文件归属，保留其他未提交内容，不切分支、不修改后端/package.json、不提交或推送。验证证据与进度写入 协作/归档/2026-10/Claude工作记录.md，R3 READY 后暂停本轮改动，由 Codex 完成 V2/C4 集成重验。
```

## 下一轮分配（本轮验收后再启动）

| 工作 | Codex | Claude Code |
| --- | --- | --- |
| 模型连通性与本地发现 | 连接测试、超时/取消、脱敏错误、本地目录 API | 连接状态、模型列表交互、错误反馈 |
| 真实接入矩阵 | Pi 调用路径、实际模型使用证据、失败归类 | 配置过程和 UI 验收记录、文档 |
| 长期运行 | 恢复、监督与 mailbox 收件确认后端 | 真实状态和未确认提示、人工处理流程 |

下一轮接口另行明确，不在本轮预留代码或增加可选项。真实平台验证以已安装服务、账号认证和用户授权范围为依据，未验证项目如实标注。
