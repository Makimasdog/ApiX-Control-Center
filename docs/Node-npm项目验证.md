# Node/npm 单包项目接入

首版使用 Windows 受管命令，支持 Node 22.19–22.x、npm 10.x、`package.json` 与匹配的 npm v3 `package-lock.json`。实际验证平台是 Windows / Node 22.19.0 / npm 10.9.2。pnpm、Yarn、workspaces、依赖覆盖、项目 `.npmrc`、外部数据库、原生扩展及安装生命周期脚本不在支持范围。检查入口限直接 `node <固定项目文件>`、`node --test` 或 `tsc`；复合 shell、内联 eval、动态 loader、引号命令等明确不支持。检查入口、测试文件与配置由宿主列入保护范围；共置测试时需将可修改范围细化到生产文件。根项目和锁定包的依赖规格限明确版本、`^`/`~` 版本范围，或项目 `vendor/*.tgz`；下载来源限 npm 公共 registry，必须单独批准。

## 用户流程

1. 添加或选择项目，创建对话，打开“交付与详情”。
2. 点击“只读诊断项目”：查看身份、运行时、Git 变更摘要、脚本及 pre/post 生命周期、源码容量与阻塞原因。诊断不执行项目 JS、安装、读取 `.env` 或发送模型请求；只使用项目外绝对 Git 入口，清除 Git 环境覆盖并禁用 fsmonitor。
3. 填写可修改源码路径，选择是否允许依赖下载，生成方案。方案列出固定脚本内容与顺序、Node/npm 入口、安装策略、产物目录及契约哈希。
4. 批准该版本。批准只保存到既有 `verification_contract` 事件，不执行安装、不调用模型。模型只能申请批准。修改 package/lock、脚本或冻结范围后，重新生成方案并批准；源码任务确需改这些文件时也使用该路径。不能用旧批准静默放行。
5. 发送目标。主 Agent 使用文件工具修复，用 `run_check {checkId:"npm-project"}` 依次运行全部候选 `typecheck → build → test`，每项包含其显式批准的 pre/main/post 脚本。
6. 检查失败时使用当前失败命令的 `operationId` / `outputRef` 读取 stdout/stderr 尾部，再修复重验。交付仍通过原有任务净差异、请求修改、新版本和用户验收流程处理。

新 API 均绑定现有未归档/删除会话：

- `GET /api/assistant/sessions/:id/project-diagnosis`
- `POST /api/assistant/sessions/:id/npm-proposal`：`{network:false,writablePaths:["src"]}`，只生成方案。
- `POST /api/assistant/sessions/:id/npm-approval`：上述参数加 `approved:true,version,contractVersion`，核对项目活跃/未知操作与会话版本后保存。

原 Node 单脚本 API 与历史数据保留，无新表或历史可信证据回填。新增 `diagnose_project` 为只读模型工具；`configure_verification` 额外支持 `npm:{network:boolean}`。固定脚本仍用原 `checks` 格式。

## 证据与执行

源码、检查配置、依赖包文件及非敏感说明以有界文件清单和字节哈希绑定；不忽略未声明的普通源码。源码最多 3000 项 / 8 MiB；依赖最多 40000 项 / 256 MiB；每个产物目录最多 6000 项 / 32 MiB。目录枚举和复制也有预算，复制后再次核对源与副本哈希。

每次检查在 `APIX_DATA_DIR/npm-validation/run-*/workspace` 创建新副本，不复制用户 `node_modules`，不共享可写依赖或 npm 缓存，不在源目录执行 `npm ci`。副本只含已核对源码，不包含 `.git`、`.env`、根/嵌套 `.npmrc`、私钥等已知凭据文件。`dist`、`coverage` 为宿主固定候选，不能与可修改范围重叠；源项目存在非空候选目录时要求用户核对并移出，不复用旧产物。构建产物只生成在本次拥有的副本中。

使用发现并冻结的 Node/npm 路径，以参数数组执行 `npm ci --ignore-scripts --no-audit --no-fund --engine-strict --include=dev --include=optional --registry=https://registry.npmjs.org`。无下载批准增加 `--offline`。全局和用户 npm 配置分别使用空文件；宿主仅传必要 Windows 变量、固定 PATH、私有 HOME/TEMP/cache 和 CI 设置，不继承模型凭据、NODE_OPTIONS 或用户 npm 配置。

npm 10 的 `ignore-scripts` 会关闭安装脚本，但显式 `npm run` 仍执行指定脚本，并跳过自动 pre/post。因此宿主按批准顺序分别执行 `npm run --ignore-scripts <name>`。需要安装脚本的包被拒绝或标记准备不完整，不能据此假定关闭脚本后任意项目都可运行。参见 [npm ci v10](https://docs.npmjs.com/cli/v10/commands/npm-ci/) 和 [npm scripts v10](https://docs.npmjs.com/cli/v10/using-npm/scripts/)。

准备证据包含实际命令终态、npm/Node 版本和入口哈希、配置策略、lock 哈希、安装后依赖全树哈希/容量/数量。每个检查后再次核对副本源码和依赖；改写输入则拒绝原证据。产物保存本次所有权、文件清单、容量与哈希。结束时源工作区与契约也必须匹配；用户在源目录的并发修改不会被覆盖，也不会被副本的成功结果验收。

所有命令沿用 Windows Job、取消、120 秒单命令期限、SQLite 原子终态与日志存储。准备/检查失败、取消、未知和准备不完整分别保存；失败不删除诊断资料，重启不会重放。正式验收核对所有安装和检查命令的输出/日志引用，而非只检查最后一条命令。日志保留期仍为 7 天，任务审阅沿用原容量和期限。

副本保留最多 20 次；启动前已有资料超过 1 GiB 时拒绝新准备，单次可再占用至 384 MiB，扫描/执行监测另限 60000 项 / 384 MiB。运行中每 1.5 秒监测资源，超限取消；这不是硬磁盘配额。保留资料由用户核对后手工整理，产品不自动删除源目录或历史诊断。

这是可审计的本机托管验证，不是 OS 沙箱。批准的脚本仍可访问本机或自行发起网络请求；`network:false` 限制宿主的依赖准备，不提供脚本网络隔离。恶意项目、任意 npm 脚本与大型仓库不在保证内。

## 工程验证与演示

`npm run test:npm` 运行真实离线 tgz 依赖的准备、构建/测试、尾部日志修复、v2 和现有验收流程。夹具是固定决策，不构成模型自主能力证明。标准 `npm test` 包含新增测试。

`npm run test:npm:browser` 启动独立生产服务和回环协议夹具，在 `.tmp-p0-p2/npm-browser.json` 输出 URL 与临时目录。用实际浏览器完成以上流程后，向报告的 `result` 路径写入观测结果 `{passed:true}`；未完成则 15 分钟 watchdog 失败。该命令本身不能代替浏览器核验。

真实付费模型必须取得独立预算批准；项目下载或脚本批准不能授权模型收费。没有预算时标记 `not_run`。
