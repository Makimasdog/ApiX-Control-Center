# Windows Electron 自用桌面版自审

日期：2026-10-21。执行与审查均由 Codex 完成，属于自审，不是独立审查或人工批准；未启动子 Agent。

## 范围

- `desktop/main.cjs`：Windows 桌面窗口、单实例、关闭确认、菜单、日志与配置入口、页面隔离、受限导航和 CSP、自动验收入口。
- `desktop/backend.cjs`：本机端口分配与复用、启动确认、外部环境文件、独立 Node、Windows Job Object 监督与进程清理。
- `desktop/electron-builder.cjs`：Windows x64 应用目录和当前用户 NSIS 安装包；明确复制后端生产依赖。
- `scripts/prepare-desktop.mjs`：TypeScript 构建后的资源暂存、Node/FTS5 检查、独立 Node/npm 和许可证、仅生产依赖安装、密钥排除。
- `scripts/verify-desktop.mjs`：核对分发依赖与密钥排除，将整包复制到仓库之外再启动验证，最后清理临时程序副本。
- `src/execution/windows-command.cs`：监督协议允许 `timeoutMs=0`，用于桌面后台服务；普通 Agent 命令仍经过 100–120000ms 校验，既有正数超时、取消、恢复检查保持有效。
- `test/desktop.test.mjs`：真实 Windows 进程与本地 HTTP 测试。
- `package.json` / `package-lock.json`：桌面命令和固定开发依赖 Electron 45.0.0、electron-builder 26.15.3；核对已有锁定包的版本，没有更新既有依赖版本。
- `README.md`、`docs/专题/Windows桌面版.md`：开发、打包、数据、退出行为和验证说明。

沿用原网页、HTTP 路由、流式对话、模型调用及员工执行逻辑；不重写业务前后端。桌面版默认使用 `%APPDATA%\ApiX-Control-Center`，不自动迁移网页版数据库或复制仓库 `.env`。

## 调用方、错误路径和边界检查

1. 启动链为 npm 构建 → 暂存 → Electron → Windows 监督进程 → 独立 Node → 现有 server。保留 `process.execPath` 为真正的 Node，支持原有 JS 员工入口、npm 验证和 MCP 子进程调用。
2. 仅监听 `127.0.0.1`；保留现有 Host/Origin 校验。端口占用时选择新端口；只接受本实例子进程的绑定成功输出，不通过探测端口误接其他服务。
3. 外部 `.env` 可提供模型密钥，PORT 和 APIX_DATA_DIR 由桌面实例固定，不允许配置文件覆盖；不在构建产物中携带仓库密钥或数据库。
4. 渲染进程关闭 Node 集成，启用隔离与沙箱；禁止外站导航、新窗口和页面权限申请，设置同源 CSP。没有向页面开放任意 IPC 或进程执行桥。
5. 启动失败有超时与清理；停止幂等。关闭提示明确停止当前任务，不宣称可恢复或完成。Windows Job Object 清理后端及后代，不使用全局进程名终止，也不影响网页版实例。
6. 单独保存数据库和配置，卸载不主动删除。中断任务仍由现有业务的核对/恢复门槛处理；本次未更改数据库 schema 或迁移逻辑。
7. 暂存清理限定在工作区 `.tmp-desktop/backend` 与 `shell`，检查符号链接；分发使用资源白名单与生产依赖，检查原 `.env` 未被携带。
8. 分发自审发现 electron-builder 默认跳过 extraResources 来源根目录的 node_modules，首次仓库内启动被祖先依赖掩盖。已增加单独依赖复制映射，并将应用验收移到仓库外；修复后的完整程序在临时目录独立启动通过。

## 验证结果

环境：Windows x64，构建及测试使用 Node v24.19.0；原默认 Node v22.15.0 低于项目要求，未修改系统 Node 或全局 PATH。

- `npm run check`：通过。
- `node --test --test-concurrency=1 test/desktop.test.mjs`：最终文件 4/4 通过。覆盖配置优先级、程序/数据路径含中文和空格、启动失败、重复停止、后端与后代清理、监督进程异常退出、端口复用和占用回退。
- `node --test --test-concurrency=1 test/command-lifecycle.test.mjs test/command-bridge.test.mjs test/static-files.test.mjs`：26/26 通过；含超时、重复取消、错误身份、无法确认清理时的恢复门槛，以及静态资源访问边界。
- `npm run desktop:pack`：应用目录构建通过。最终依赖复制修复后重新运行 electron-builder NSIS 构建。
- 最终 `scripts/verify-desktop.mjs`：通过。把完整应用移到系统临时目录、离开仓库依赖树后启动；真实 `/api/snapshot` 返回 200，15 项入口脚本/样式全部返回 200，页面未暴露 Node，退出后监督进程和端口均关闭。
- 最终隔离验收结果与截图：`.tmp-desktop/smoke-so1ekc/smoke-result.json`、`window.png`；已查看窗口截图。产物检查确认独立 Node、npm、后端 SDK 均存在，个人 `.env` 不存在。
- Electron 二进制通过 npm 包内官方 SHA256 清单校验；应用 exe 的 Authenticode 状态为 NotSigned。
- 最终 diff（含新增文件）已自审；提交前检查暂存区与本文件列明范围一致。

## 未验证项和限制

- 未使用真实模型密钥执行付费推理、真实员工完整任务；不把页面/接口检查称为完整 Agent 工作流验收。
- 未在另一台全新 Windows 电脑运行，未测试 NSIS 安装/卸载交互界面、系统关机和全部异常环境；独立程序已在仓库外运行。
- 当前为 Windows x64 自用版本；未做签名、自动升级和自定义图标，Windows 可能提示来源未知。
- 不自动迁移原数据库；已运行任务在退出时停止，后续须核对。若原端口被其他程序占用而更换端口，页面同源偏好可能重置，数据库仍保留。

## 原有改动保护

开始时已有 `.gitignore`、`agent-discovery.mjs`、`server.mjs` 的未提交改动及 `.claude/skills/`、`test/MCP_test.py` 未跟踪文件；均保留且不纳入本次提交。构建使用当前工作区代码，前两个源文件原有注释改动不作为本次新增业务功能。未切换分支、推送或合并。

## 产物

最终 NSIS 重建命令：`node node_modules/electron-builder/cli.js --config desktop/electron-builder.cjs --win --x64 --publish never`，退出码 0。首次完整 `npm run desktop:dist` 后修复资源映射，再使用同一已构建资源重建安装包；未修改生成的前后端代码。

- 安装包：`.tmp-desktop/release/ApiX-Setup-0.1.0-x64.exe`
- 大小：146085509 字节（约 139.3 MiB）
- SHA256：`2E19BE056B6FADEDB138AF2217F1C2F46ACC8C3947F443C35784F10977032C5B`
- 签名状态：NotSigned。未进行发布或上传。
- 可直接启动的程序：`.tmp-desktop/release/win-unpacked/ApiX Control Center.exe`，必须连同整个目录保留。

自审结论：本次范围内未发现未处理的阻断问题，可提交。上述未验证项继续保留，不将自用版本描述为对外发布版本。
