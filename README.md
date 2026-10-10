# ApiX Control Center

ApiX 是用户的管理者 Agent：与用户澄清需求、规划和分派任务、监督员工、收集真实交付物。Pi 提供 ApiX 的推理底座；Pi 员工与 ApiX 有独立身份和权限。默认产品入口是目标工作台。

## 启动

需要 Node.js 22.19 或更新版本、Git，以及已安装并认证的 Pi（管理者推理）。执行员工可使用 Pi、Codex CLI、Claude Code 或显式注册的自定义 CLI。

```powershell
cd E:\Projects\wyy\ApiX-Control-Center
npm ci
npm start
```

打开 http://127.0.0.1:4173/ 。npm start 自动编译 TypeScript；升级代码后请重启原服务。默认 SQLite 位于用户目录 .apix-agent-os/apix.sqlite，可设置 APIX_DATA_DIR 和 PORT。

1. 添加已有 Git 项目，在“任务与员工”注册员工。
2. 创建目标，与 ApiX 沟通，补全目标、范围、约束、交付物、验收标准。
3. 确认需求，审查并修改计划；默认“请求批准”模式下点击批准后启动。
4. 查看员工状态、交付物、消息监督并验收；中途可请求调整需求。

“ApiX 推理模型”保存到后端并用于管理者 Pi 调用。认证凭据沿用 Pi 自身配置。侧栏“模型偏好”和 Skills/MCP 仍是浏览器配置，不能替代真实运行配置。

## 身份和权限

- ApiX：独立的管理者 Agent，通过 Pi 无工具推理进行沟通和计划生成。
- 员工：独立 CLI 进程，在计划工作区执行任务。不会从管理者继承完全访问权限。
- 权限按项目及主体设置：ask_approval、full_access、read_only。完整需求始终需要用户确认。
- 仅当 ApiX 与所有被安排员工均有完全访问权限、计划通过校验且由推理模型生成时，才自动派发。
- 请求批准是计划/任务启动授权，不是每个工具调用的批准机制；本版本不提供操作系统沙箱。完全访问允许所支持的 CLI 关闭自身审批/沙箱。

## 运行时配置

可用 APIX_PI_ENTRY、APIX_CODEX_ENTRY、APIX_CLAUDE_ENTRY 指定对应 Node CLI 入口；APIX_MANAGER_PI_ENTRY 可单独指定管理者 Pi 入口。环境变量值均为 JavaScript 入口绝对路径。

自定义 CLI 在“任务与员工”登记可执行文件、参数数组及输出格式；Qoder 等需提供并验证非交互 CLI 或包装器。Trae、Qoder、WorkBuddy 的桌面应用发现不代表可托管执行。

## 开发与文档

```powershell
npm run check
npm test
```

新增核心模块与目标工作台使用严格 TypeScript，编译产物 dist/ 不入库。旧 HTTP/SQLite/进程托管及管理页面仍有 JavaScript，正在按边界逐步迁移。

- [协调系统实现与验收](docs/ApiX协调系统实现.md)：架构、接口、时序、权限、迁移和路线。
- [代码索引](docs/代码索引.md)：实际实现入口。
- [功能与限制](docs/功能与限制.md)：本版本能力边界。
- [消息协议](docs/agent-message-protocol.md)、[分支管理](docs/分支管理.md)、[第三方来源](THIRD_PARTY.md)。

测试使用假 CLI 和隔离数据库，不调用真实模型。服务仅监听本机；管理 API 采用可信本机模式，不能直接暴露到网络。已有数据保留，旧直接派发 API 默认关闭；APIX_LEGACY_API=1 仅用于兼容旧流程和历史回归。
