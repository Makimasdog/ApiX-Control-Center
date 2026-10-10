# ApiX Control Center

ApiX 是本地多 Agent 管理中心。用户与 ApiX Director 沟通目标、检查并修改计划，然后批准员工 Agent 执行。任务、消息、审批、交付物和项目记忆保存在本地 SQLite。

此仓库只包含 ApiX 控制中心。Pi 与 Codex CLI 作为外部运行时接入，不包含它们的源码；未安装任一运行时也可以打开界面，但相关 Agent 无法执行。Trae、Qoder、WorkBuddy 目前只支持桌面应用发现，不支持托管执行。

## 启动

需要 Node.js 22.19 或更新版本；运行时需自行安装并配置 Pi 或 Codex CLI。

```powershell
git clone https://github.com/Makimasdog/ApiX-Control-Center.git
cd ApiX-Control-Center
npm start
```

打开 `http://127.0.0.1:4173/`。服务只监听本机地址。可设置 `PORT` 修改端口，设置 `APIX_DATA_DIR` 指定 SQLite 数据目录；默认数据位于用户主目录的 `.apix-agent-os`。如果 Pi 或 Codex 的全局命令无法定位，可分别设置 `APIX_PI_ENTRY`、`APIX_CODEX_ENTRY` 为对应 JavaScript 入口的绝对路径。

## 开发验证

```powershell
npm run check
npm test
```

测试使用仓库内的假 Pi 和假 Codex，不调用真实模型或消耗 API 配额。CI 在 Windows 上运行同样的检查。

## 架构与边界

- `server.mjs`：本机 HTTP API、静态页面和 SSE 事件流。
- `control-plane.mjs`：Director、项目、任务、审批、Agent mailbox、消息策略、SQLite 存储和运行适配器。
- `agent-discovery.mjs`：本机桌面 Agent 发现。
- `agent-os.js` 与 `index.html`：Web 工作台和监督界面。
- `docs/agent-message-protocol.md`：消息信封、权限、超时、重试、锁和事件协议。
- `docs/ApiX Agent OS.md`：产品目标与阶段设计。

批准任务后，ApiX 才启动 Pi RPC 或 Codex CLI 进程。计划任务使用独立 Git worktree；普通任务使用项目目录，可能发生文件冲突。资源锁是 ApiX 内部协作租约，不能阻止外部程序修改文件。当前 HTTP API 没有独立 Agent 身份认证，仅适合本机使用。

更完整的功能说明见 [docs/功能与限制.md](docs/功能与限制.md)。第三方运行时与项目来源见 [THIRD_PARTY.md](THIRD_PARTY.md)。
