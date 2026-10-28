# Pi 入口检测修复与自审

日期：2026-10-16；基线：`e49b91b`；分支：`codex/readiness-p0-p2`。实施与审查均由 Codex 完成，本记录为自审，不是独立审查或人工批准。未启动其他 Agent。

## 问题与范围

用户反馈“Pi 未安装或不可用”。尚未拿到反馈设备的系统、安装方式或 `pi --version` 结果，不能确定该设备的具体根因。源码检查确认以下可复现问题：

1. ApiX 的 `npm ci` 不包含 Pi CLI；快速开始缺少实际安装步骤，仅在前置要求写了“已安装”。管理者当前通过 Pi RPC 推理，即使已经填写兼容 API URL、模型 ID 和 Key 也依赖 Pi。
2. Windows npm shim 只识别 `@earendil-works/pi-coding-agent`，遗漏旧包名 `@mariozechner/pi-coding-agent`。Pi 官方的[包名迁移说明](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home)确认两者关系。
3. 管理者独立入口只检查存在性，可能将目录或 `.cmd` 当作 JS 交给 Node；原生可执行文件也被错误地包装到 Node 参数里。就绪检查和实际启动另有重复逻辑。

用户随后追问“为什么一定要安装 pi”。结论是：这属于当前推理后端实现的外部依赖，不是通用 Agent 或多 Agent 调度的必然要求。主循环已经在 ApiX 内，但模型请求仍由 `askPiDirector` 发给 Pi RPC。此次修复只处理兼容检测与诊断，没有实现直接模型 HTTP 后端，也没有声称安装依赖已经消除。

## 修改与契约

- `src/runtime-adapters.ts`：统一入口文件校验；绝对路径、真实文件，拒绝目录、相对路径和 `.cmd/.bat/.ps1` 显式入口。JS 由当前 Node 执行；原生文件直接执行。显式配置无效时返回不可用，不静默选择另一个 CLI。Windows npm shim 从新旧官方包清单的 `bin` 解析真实入口，继续拒绝越界和不支持的扩展名，不经 shell 运行 shim。
- `control-plane.mjs`：管理者推理与就绪检查都使用 `managerCommand()`；员工咨询继续使用员工 Pi 入口，不受管理者覆盖影响。权限、预算和模型认证不变。
- `src/readiness.mjs`、`README.md`、`.env.example`：给出安装、同终端版本检查、PATH/真实入口及重启说明；说明配置 API 不能替代 Pi CLI。PowerShell 脚本执行受限时可用 `pi.cmd --version` 做终端诊断。文件入口只说明可发现，不宣称已认证或能连接模型。
- `test/coordinator.test.mjs`、`test/readiness.test.mjs`：覆盖新旧包名、无效入口、原生/JS 入口、管理者与员工隔离、明确配置不回退、真实 HTTP 就绪与错误诊断。

## 最终差异自审

已审查所有修改、新增测试、调用方、错误路径与边界：

- `managerCommand()` 是管理者的唯一解析入口；没有就绪状态与启动各自放宽校验的情况。
- 显式错误入口不会静默调用其他已登录 CLI；这也适用于其他运行时的 `APIX_*_ENTRY`，避免用户配置失效后换用另一个身份。
- npm 清单仅解析已知官方包名；不能借 `bin` 逃出包目录，目录不会被标记成可执行文件。未引入 shell 或自动下载执行。
- 新旧 Pi 包名兼容不代表所有旧版本的 RPC/模型协议已验证。原生入口存在也不证明该文件支持 Pi 协议；连接测试继续负责实际验证。
- 错误信息仅含固定帮助文本，不输出环境变量值、模型 Key 或项目上下文；入口缺失时不启动员工。
- 没有新增依赖、修改账本或数据库结构，没有安装、升级或卸载本机 Pi，没有重启用户服务。
- 自审结论：本轮检测与诊断修复范围通过，不能将其解释为已确认反馈用户设备修复或 ApiX 已独立于 Pi。

## 验证

- `npm run check` 与 TypeScript 构建通过。
- 定向 coordinator 回归 6/6 通过：普通循环实际文件失败修复、原有 Windows npm 解析、管理者/员工入口校验、新旧 Pi 包名、无效管理者 HTTP 诊断、自定义模型管理者调用。
- readiness 与 scheduling 回归 19/19 通过，保留认证未验证、额度、权限与预算边界。
- agent-os 与 environment 回归 11/11 通过（约 137 秒），包括 Pi/Codex 实际进程启动、停止与恢复、并行工作区、Director、环境密钥隔离。合计本轮 36 项通过，无失败或跳过。
- 验证使用本机临时目录、SQLite、HTTP 与实际 Node 子进程，模型用 fake-pi 夹具；未调用付费模型。

最终暂存使用明确文件清单，核对 Git blob 与审查内容一致并执行差异空白检查。保留用户原有 `.gitignore` 修改及未跟踪文件；不切分支，不推送、不合并。

未验证：反馈设备现场环境、真实 Pi npm 安装、真实旧版/新版 Pi 及付费模型联调；Linux/macOS 上的运行回归未执行。本轮不是全量回归，使用受影响的定向测试。
