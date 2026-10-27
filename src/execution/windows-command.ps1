# =============================================================================
# windows-command.ps1 - PowerShell 启动脚本：调用 C# 监督器的入口
#
# 所属层级：执行层（src/execution/）
# 核心功能：
#   - 作为 Node.js 与 C# 之间的桥接层，接收命令行参数并启动 C# 监督进程
#   - 支持两种模式：监督执行（Run）和状态检查（Inspect）
#   - 配置 PowerShell 的 UTF-8 编码，确保协议通信的字符一致性
# 依赖关系：
#   - 被 [→ 见 src/execution/command-lifecycle.ts] 通过 spawn 调用
#   - 调用 [→ 见 src/execution/windows-command.cs] 中的 ApiXCommandJob 类
# =============================================================================

# 接收来自 Node.js 的参数：
#   -JobName    : Windows Job Object 名称，用于进程组隔离（格式：Local\ApiX-Command-<operationId>）
#   -Inspect    : 切换为检查模式（查询 Job Object 状态而非启动命令）
#   -Terminate  : 在检查模式下同时终止 Job Object 中的所有进程
#   -OwnerPid   : 监督进程（即本 PowerShell 进程）的 PID，用于身份校验
#   -OwnerBirth : 监督进程的启动时间戳（UTC Ticks），防止 PID 复用导致的误判
param([string]$JobName,[switch]$Inspect,[switch]$Terminate,[int]$OwnerPid=0,[string]$OwnerBirth='')

# 遇到任何错误立即终止，不继续执行后续语句
$ErrorActionPreference='Stop'

# 强制 stdin/stdout 使用无 BOM 的 UTF-8 编码，确保与 Node.js 的协议通信字符一致
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)

# 动态编译并加载同目录下的 C# 源代码（windows-command.cs）
# Add-Type 会将 C# 代码编译为内存中的程序集，使 ApiXCommandJob 类可用
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-command.cs') -Raw)

# 检查模式：直接调用 C# 的 Inspect 方法查询 Job Object 状态，然后退出
# Inspect 模式用于在命令执行期间或之后检查进程组是否仍然活跃
if($Inspect){[ApiXCommandJob]::Inspect($JobName,$Terminate.IsPresent,$OwnerPid,$OwnerBirth);exit}

# 监督执行模式：从 stdin 读取 JSON 格式的命令配置
# 配置格式示例：{"executable":"git","args":["status"],"cwd":"C:\\project","timeoutMs":30000,"env":{...}}
$config=[Console]::In.ReadLine() | ConvertFrom-Json
if($null -eq $config){exit 1}

# 将 JSON 中的 env 对象转换为 PowerShell 哈希表（C# 方法需要 IDictionary 类型）
$environment=@{}
foreach($entry in $config.env.PSObject.Properties){$environment[$entry.Name]=[string]$entry.Value}

# 调用 C# 监督器的 Run 方法，启动受管命令执行
# 参数依次为：Job 名称、可执行文件路径、参数数组、工作目录、超时毫秒数、环境变量表
[ApiXCommandJob]::Run($JobName,[string]$config.executable,[string[]]$config.args,[string]$config.cwd,[int]$config.timeoutMs,$environment)
