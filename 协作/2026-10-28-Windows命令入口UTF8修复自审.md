# Windows 命令入口 UTF-8 修复自审

结论：本轮范围自审通过。此前的 ConvertFrom-Json 故障已修复：原真实命令失败用例、完整受管命令/日志回归、桌面后端回归及真实 Electron 开发版冒烟均通过。自审人为 Codex，不是独立审查或人工批准。

## 范围与根因

- 基线 3a4a516，继续使用 codex/token-usage-optimizer。用户授权修复、测试、自审与提交；本轮不推送、不合并、不启动子 Agent。
- 本机 Node 24.22.1、Windows PowerShell 5.1.26100.9711、系统默认代码页 936。
- Windows PowerShell 5.1 通过 `-File` 加载无 BOM 的中文监督脚本时，使用系统默认编码。固定的无凭据探针显示：无 BOM 时，本应为 UTF-8 的 stdin 中 `中文😀` 被读成乱码；同脚本加 BOM 后恢复原值。本机宿主环境值被误解码后，原 ConvertFrom-Json 对 Node 发出的合法 JSON 报语法错误。
- 单独补脚本 BOM 后，原 `Get-Content -Raw` 仍按默认编码读取中文 C# 源码，探针中出现 Add-Type 编译错误；再明确 `-Encoding UTF8` 后，JSON 和监督器启动均恢复。两个编码点必须同时明确。
- 原生 ConvertFrom-Json 异常还会附带整段输入，可能把环境变量和凭据写入错误日志。新增固定协议错误，防止这一错误路径回显配置。

## 改动

- windows-command.ps1 增加 UTF-8 BOM 和维护说明；C# 加载增加 `-Encoding UTF8`。保留现有 Console UTF-8 设置，不更换 PowerShell 二进制、不改系统代码页或宿主环境。
- 用 try/catch 包含配置解析和环境字典构造。要求顶层 JSON 对象及 PSCustomObject 形式 env，拒绝空输入、畸形 JSON、顶层数组或无效 env。先检查 JSON 以 `{` 起始，防止 5.1 管道展开单元素数组后把数组误作对象。
- 解析失败只输出既有协议 `error|<Base64("Invalid command configuration")>|no_worker` 并 exit 1，不打印异常正文。在调用 C# Run 之前拒绝，因此没有 Job 或 worker 启动。
- 仍沿用 managedCommand 和 desktop/startBackend 的既有 error 帧处理；不改 Job Object 权限、身份核验、两阶段 go 协议、超时、取消、停止和日志脱敏逻辑，也不修改 C# 可执行代码。
- 补充 command-lifecycle.test.mjs 的两个回归测试，并更新 Windows 使用文档及 docs/INDEX.md 对应条目。

## 测试证据

先加入新测试、尚未修复脚本时，两个定向回归均失败（before.log）；修复后连同原失败的真实命令测试，3/3 通过。最终补上临时目录清理路径断言后，静态检查与两个新增回归再次通过（final-check.log）。

最终验证：

| 验证 | 结果 |
| --- | --- |
| npm run build | 通过 |
| npm run check | 通过，含 TS、入口语法、孤儿 dist 和强制 lint |
| command-lifecycle、assistant-tools、command-bridge、command-logs | 33/33 通过，0 失败、取消、跳过；约 111 秒 |
| npm run test:desktop | 7/7 通过，0 失败、取消、跳过；约 36 秒 |
| 真实 Electron 开发版隐藏窗口冒烟 | 通过，使用独立中文数据目录，不调用模型 |

新增回归明确验证：

- 脚本 BOM 保留；通过实际 Windows PowerShell 5.1 执行命令，中文 cwd、中文/emoji 参数和环境变量，以及引号、反斜杠、转义换行均按原值抵达 Node worker；退出码 0、executionComplete=true、processesEnded=true。
- 四种非法配置（畸形 JSON、env=null、顶层单元素数组、空输入）均 exit 1，stderr 为空，stdout 只含固定错误帧，不含测试秘密标记、job 或 started 消息。
- 原已有回归覆盖实际正常/失败退出、后代进程清理、重复停止/超时竞争、错误创建身份、终止失败/未知、权限撤销、恢复门禁、SQLite 持久化故障及跨块日志脱敏。全部通过，没有绕过或削弱原断言。
- 桌面回归覆盖后端/后代停止、监督进程丢失、启动失败、端口复用/冲突、显式 Node 和开发监听。
- 真实 Electron 复用仓库 main.cjs 与新监督脚本，以 `--smoke-test` 隐藏启动并自动退出：API 200、19 个静态资源均 200、rendererErrors=[]、nodeExposed=false，退出后后端端口不可连接。查看了启动截图，正常显示空白新对话工作区，无错误页。

临时探针、修复前后日志、原生/桌面测试日志、Electron 冒烟结果和截图统一在 `.tmp-windows-command-json-review/`，不提交运行目录或个人配置。

## 最终自审

- 审查了全部最终 diff 和新增记录，以及调用方 managedCommand、同步/异步 Inspect 和桌面 startBackend。它们都指向同一脚本，UTF-8 C# 加载也覆盖 Inspect 路径。
- 有效配置的执行流程及 worker 环境隔离保持；错误配置在执行前拒绝，旧 error/no_worker 协议可被两类调用方识别，未扩大权限或把未知执行冒充成功。PS 解析失败不再附带原文。
- 明确文件清单暂存，提交前核对 Git 规范化后的 blob 与自审快照一致，再提交；BOM 必须同时在工作区和暂存对象中保留。

## 未验证项与限制

未运行完整 npm test、付费模型/CLI、多种 Windows 系统代码页或 Node 22；未重新构建/安装 Windows 分发包。真实 Electron 使用开发版显式 Node，不能冒充已验证安装包。旧版本已有的日志未自动清理；以前的解析错误日志可能仍包含当时的配置正文。对本轮发现并修复的错误路径，回归已确认新输出不含输入原文。
