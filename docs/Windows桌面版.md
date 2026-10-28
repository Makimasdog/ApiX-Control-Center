# Windows 自用桌面版

Electron 复用现有网页和 HTTP 后端；后端仅监听本机端口。首次选择空闲端口，后续优先复用以保留同源页面偏好；被其他程序占用时改用新端口，数据库仍保留。桌面包携带构建时的 Node.js 和 npm，使用 Windows PowerShell 管理后端及其子进程，不需要 Docker。

## 开发与打包

在 Windows x64 上使用 Node.js 22.19–22.x 或 24.22+（24.x）（SQLite 必须支持 FTS5）：

```powershell
npm ci
npm run desktop:dev
```

首次安装依赖需要下载 Electron；首次打包还会下载 Windows 安装工具。已有终端若使用旧 Node，请先切换版本。构建会验证 Node 和 SQLite；它携带当前构建所用的 node.exe，不依赖接收电脑安装 Node。

```powershell
# 生成可双击启动的应用目录
npm run desktop:pack
# 生成 Windows 安装 exe
npm run desktop:dist
```

产物：

- `.tmp-desktop/release/win-unpacked/ApiX Control Center.exe`：直接启动；复制给其他目录时必须复制整个 `win-unpacked` 文件夹。
- `.tmp-desktop/release/ApiX-Setup-<version>-x64.exe`：当前用户安装包，版本取自根 `package.json`；可选择目录并生成桌面快捷方式，不需要管理员安装。

本版未配置代码签名或自动更新。安装包版本来自根 `package.json`。构建资源和产物使用已有 `.tmp*/` 忽略规则，不提交 Git。桌面前后端在 `.tmp-desktop` 暂存，修改源码后重跑上述命令即可。

安装依赖时若跳过了生命周期脚本，缺少 `node_modules/electron/dist/electron.exe`，可运行 `node node_modules/electron/install.js` 恢复锁定版本。离线恢复所用的 Electron ZIP 必须与该包的 `checksums.json` 匹配。构建需要当前 Node 版本的官方许可证，缓存为 `.tmp-desktop/node-<Node版本>-LICENSE.txt`；网络失败时应重试或补齐对应版本的完整许可证。

全局 npm 缓存出现 `EEXIST` 时，可为本轮构建指定独立缓存后重试：

```powershell
$env:NPM_CONFIG_CACHE = Join-Path $PWD '.tmp-desktop/npm-cache'
npm run desktop:pack
```

## 数据与模型配置

默认目录：`%APPDATA%\ApiX-Control-Center`。数据库 `apix.sqlite`、日志 `desktop.log` 和 `.env` 均位于此处。菜单“应用”提供打开目录和编辑配置入口。

首次启动仅从 `.env.example` 创建空白配置；**不会复制仓库的 `.env`、模型密钥或网页版数据库**。在“应用与协作设置 → Agent 供应商中心”新建供应商并填写 Base URL、模型 ID、协议和 API Key，再应用到 ApiX；Codex 与 Claude Code 员工也在同一页面绑定。桌面版 `.env` 仍可用于员工 CLI 或既有环境变量引用。不要向他人分发个人数据目录。日志每次启动覆盖，排错时先保存当前日志。

桌面版默认与网页版数据分开，不自动迁移。请勿让两个服务同时使用同一个数据库。需要自定义目录时，可在启动前设置 `APIX_DESKTOP_DATA_DIR`；这也用于隔离验收。卸载不会主动删除上述数据目录，重装仍可继续使用；备份时先退出应用，再复制整个数据目录。

## 启停和员工工具

重复启动会聚焦已有窗口。关闭窗口或菜单退出会确认停止任务，确认后停止本桌面实例的后端和全部受管子进程；这不是暂停/恢复功能。未完成任务再次打开后应按页面提示核对，不能当作已完成。异常关闭桌面进程时，监督进程的输入管道关闭，Windows Job Object 清理其后端和子进程。

Windows PowerShell 必须可用。Git、Codex、Claude 等员工工具仍需单独安装及认证；沿用本机账户和 PATH，也可在桌面 `.env` 配置真实的 `APIX_*_ENTRY`。桌面包带 Node/npm，不带这些第三方 CLI。新增安装 CLI 后重启桌面程序以刷新环境。

命令与桌面后端共用 `src/execution/windows-command.ps1`。该脚本必须以 **UTF-8 with BOM** 保存，供 Windows PowerShell 5.1 正确识别中文脚本；它显式按 UTF-8 读取同目录 C# 源码，stdin/stdout 也使用 UTF-8。单行 JSON 配置中的参数、目录和环境变量可包含中文、emoji、引号及转义换行。

入口只接受 JSON 对象及对象形式的 `env`。空输入、畸形 JSON、顶层数组或无效 `env` 会在启动 Job/worker 前返回固定 `error|<Base64 错误>|no_worker`，退出码 1；不会回显配置原文或环境变量。已打包的旧程序需要重新构建才能包含修复；本轮不追溯清理旧版本留下的错误日志。

## 验证

```powershell
npm run build
npm run check
npm run test:desktop
node --test --test-concurrency=1 test/command-lifecycle.test.mjs test/assistant-tools.test.mjs test/command-bridge.test.mjs test/command-logs.test.mjs
# 构建后验收真实 exe（隔离数据，不调用模型）
npm run test:desktop:app
```

后端进程测试覆盖外部配置、路径含中文和空格、启动失败、停止整棵进程树、监督进程异常退出、重启端口复用和端口占用回退。应用验收会先核对分发包的生产依赖、npm 和密钥排除，再把整包复制到仓库之外的临时目录启动，防止误用仓库里的依赖；验收后清理临时程序副本。

应用验收还会创建隔离项目，核对项目 Worker 完整扫描、项目指令和上下文读取、npm 方案使用包内 Node/npm，以及渲染错误为零。宿主安装了 Git 时同时检查 Git 诊断与仓库登记；未安装时跳过这两项。验收不调用模型、不安装项目依赖，也不运行项目检查脚本。超时失败时等待 Electron 关闭后清理临时程序副本，数据与日志保留用于排错。

指定其他输出目录的应用可运行 `npm run test:desktop:app -- "完整 exe 路径"`。旧包缺少新增探针证据时会明确报错，需要重新构建。最近实际运行记录见[2026-10-26 Electron 实际运行验证与自审](../协作/2026-10-26-Electron实际运行验证与自审.md)。

2026-10-28 的编码修复、40 项命令/桌面回归与真实 Electron 开发版冒烟见 [Windows 命令入口 UTF-8 修复自审](../协作/2026-10-28-Windows命令入口UTF8修复自审.md)。该轮没有重建安装包。

`--smoke-test` 参数仅用于自动验收：隐藏窗口，加载真实网页并请求 `/api/snapshot`，将结果写入隔离数据目录的 `smoke-result.json` 并保存 `window.png` 后退出；不调用模型或派发员工。

Agent 供应商中心支持直接填写 API Key。保存后立即生效，密码框清空且不会回显密钥；留空保留原配置。现有环境变量引用继续兼容。密钥以本机明文文件 `model-credentials.json` 保存于应用数据目录（与 `.env` 相同信任边界），不写入项目、供应商接口或 Git。更换服务地址或协议后需要重新填写密钥；旧会话继续引用其原有凭据。
