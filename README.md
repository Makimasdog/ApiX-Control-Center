# ApiX Control Center

ApiX 是用户的管理者 Agent：与用户澄清需求、规划和分派任务、监督员工、收集真实交付物。Pi 提供 ApiX 的推理底座；Pi 员工与 ApiX 有独立身份和权限。默认入口是管理总览，显示当前项目的目标、待处理事项、员工动态和任务流转；点击事项进入目标工作台继续处理。

## 启动

需要 Node.js 22.19 或更新版本、Git，以及已安装并认证的 Pi（管理者推理）。执行员工可使用 Pi、Codex CLI、Claude Code、Gemini CLI、OpenCode、Kimi Code 或显式注册的自定义 CLI；每种 CLI 都需单独安装和认证。

```powershell
cd E:\Projects\wyy\ApiX-Control-Center
npm ci
npm start
```

打开 http://127.0.0.1:4173/ 。npm start 自动编译 TypeScript；升级代码后请重启原服务。默认 SQLite 位于用户目录 .apix-agent-os/apix.sqlite，可设置 APIX_DATA_DIR 和 PORT。

运行时须满足上面的 Node 版本要求，并支持 SQLite FTS5。可在启动前执行以下探测；若报 `no such module: fts5`，请切换到满足要求的 Node，避免在旧版本下误判数据库或测试故障：

```powershell
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE probe USING fts5(content)'); db.close();"
```

1. 添加已有 Git 项目，在“任务与员工”注册员工。从“管理总览”查看项目状态并创建目标。
2. 创建目标并选择“对话模式”或“约束模式”，与 ApiX 沟通，补全目标、范围、约束、交付物、验收标准。交互模式可在需求确认前切换；两种模式都必须满足同一确认门槛。
3. 确认需求，审查并修改计划；默认“请求批准”模式下点击批准后启动。
4. 点击员工姓名进入详情页，查看当前任务、进度报告、历史任务和已采集的 Token 用量；查看交付物、消息监督并验收。没有运行时用量数据的 Run 明确显示“未知”。

ApiX 目标对话使用独立的 POST SSE 流，逐步展示模型生成的澄清问题；流结束后以经过校验并保存的正式会话记录为准。现有 Agent mailbox 事件流继续用于消息状态更新。

对话模式下，管理者可返回自然回复、需求解释或真实任务状态说明；可见回复上限为 10,000 字符，超限或非法模型输出明确退回规则引导。聊天不会修改已确认需求或绕过计划审批。流式客户端断开不代表模型已停止；恢复后先读取正式会话，避免自动重发重复消息。

任务进行中，ApiX 会在员工长时间未报告时主动请求进度；员工上报进度后，ApiX 根据已确认的需求选择指导重点并发送 mailbox 消息。用户也可以在目标工作台向运行中的员工补充当前任务说明。员工运行时须主动读取 mailbox，才能在执行过程中收到这些消息；无法读取的第三方 CLI 会保留指导记录，不能保证进程内即时采纳。

“ApiX 推理模型”保存到后端并用于管理者 Pi 调用。可选择 Pi 已配置的 Provider/模型，或填写 OpenAI/Anthropic 兼容 API URL、模型 ID 与 API 类型。自定义 URL 使用 ApiX 数据目录下的独立 Pi 模型目录，不覆盖用户的 Pi 配置。远程接口需填写 API Key 的环境变量名并在启动服务前设置该环境变量；本地回环地址可无 Key。密钥不通过页面保存。侧栏“模型偏好”和 Skills/MCP 仍是浏览器配置，不能替代真实运行配置。

选择 Ollama、LM Studio 或填写本机 OpenAI 兼容 URL 后，可点击“读取本地模型”获取服务的模型目录。读取使用当前表单中的地址，不会自动保存、加载模型或生成回复；失败或空目录保留手动输入。需要认证的本地服务可在自定义配置中填写 Key 环境变量名。目录不保证模型已加载、支持对话或能成功推理，选择后仍需保存并进行实际对话验收。

## 身份和权限

- ApiX：独立的管理者 Agent，通过 Pi 无工具推理进行沟通和计划生成。
- 员工：独立 CLI 进程，在计划工作区执行任务。不会从管理者继承完全访问权限。
- 权限按项目及主体设置：ask_approval、full_access、read_only。完整需求始终需要用户确认。
- 仅当 ApiX 与所有被安排员工均有完全访问权限、计划通过校验且由推理模型生成时，才自动派发。
- 请求批准是计划/任务启动授权，不是每个工具调用的批准机制；本版本不提供操作系统沙箱。完全访问允许所支持的 CLI 关闭自身审批/沙箱。

## 运行时配置

可用 APIX_PI_ENTRY、APIX_CODEX_ENTRY、APIX_CLAUDE_ENTRY、APIX_GEMINI_ENTRY、APIX_OPENCODE_ENTRY、APIX_KIMI_ENTRY 指定对应 CLI 入口；APIX_MANAGER_PI_ENTRY 可单独指定管理者 Pi 入口。环境变量值为 JavaScript 入口或原生可执行文件的绝对路径，不接受 .cmd/.bat/.ps1。Windows 上全局 npm 安装的命令会根据包清单定位实际入口，找不到入口时显示为未安装。

Gemini 使用 stream-json，OpenCode 使用 `run --format json`，Kimi 使用 `--print --output-format=stream-json`。ApiX 通过标准输入传入任务，在统一 Run 中收集事件、结果和用量。请求批准指 ApiX 的任务启动审批；Gemini 的普通模式使用 `auto_edit`、完全访问使用 `--yolo`。OpenCode 与 Kimi 的工具权限仍由各自 CLI 配置决定，ApiX 不提供操作系统级隔离。首次使用请在终端分别完成 CLI 登录，并运行一个小任务验证版本、权限及工作目录行为。

自定义 CLI 在“任务与员工”登记可执行文件、参数数组及输出格式；Qoder 等需提供并验证非交互 CLI 或包装器。Trae、Qoder、WorkBuddy 的桌面应用发现不代表可托管执行。

## 开发与文档

```powershell
npm run check
npm test
```

新增核心模块与目标工作台使用严格 TypeScript，编译产物 dist/ 不入库。旧 HTTP/SQLite/进程托管及管理页面仍有 JavaScript，正在按边界逐步迁移。

- [协调系统实现与验收](docs/ApiX协调系统实现.md)：架构、接口、时序、权限、迁移和路线。
- [管理总览设计](docs/管理总览设计.md)：参考来源、信息架构、数据口径和扩展边界。
- [代码索引](docs/代码索引.md)：实际实现入口。
- [功能与限制](docs/功能与限制.md)：本版本能力边界。
- [消息协议](docs/agent-message-protocol.md)、[分支管理](docs/分支管理.md)、[第三方来源](THIRD_PARTY.md)。

测试使用假 CLI 和隔离数据库，不调用真实模型；当前机器未安装 Gemini/OpenCode/Kimi，尚未完成真实 CLI 联调。服务仅监听本机；管理 API 采用可信本机模式，不能直接暴露到网络。已有数据保留，旧直接派发 API 默认关闭；APIX_LEGACY_API=1 仅用于兼容旧流程和历史回归。
