# Windows 单 Agent Coding MVP：交付与 D 自审

日期：2026-10-18。Codex 实施及自审，不是独立审查或人工批准。按桌面提示词 A/B/C/D 实施，无子 Agent。工作分支始终为 `codex/readiness-p0-p2`，起点 HEAD 恰为 `e557afd96e5f71e3112cbe3a680d0f1cb180866b`，无基线后的新增差异。已读取 AGENTS、README、开发/架构和 P0 自审及对应执行代码。用户原有 `.gitignore`、`.claude/skills/`、MCP_test.py、说明文件及 HTML 均保留且不暂存。未切分支、push、merge、部署或调用收费模型。

## 交付范围与调用链

主 Agent 仍走 `assistant-loop → 工具目录/Schema → 权限、指纹、项目互斥 → control-plane 实际装配 → assistant-coding / assistant-commands → 文件工具 / Windows Job → SQLite 事件与结果 → 模型上下文 / UI`。`run_check` 继续调用同一个命令桥接，并由宿主验证契约、代码指纹和真实进程事实。模型成功声明不能代替证据。

| 变更集 | 完成内容与接口 | 修改文件 |
| --- | --- | --- |
| A（`ddfa6fb`） | 共用版本化宿主摘要；长结果与 UI 保持事实；预检未启动与未知分开；平台能力与启动诊断 | `src/assistant-result.ts`、`command-capabilities.ts`、`assistant-context.ts`、`assistant-commands.ts`、`assistant-loop.ts`、`assistant-tools.ts`、`command-lifecycle.ts`、`tool-registry.ts`；`server.mjs`；`web/assistant-view.ts`、`assistant.ts`；`test/coding-baseline.test.mjs`、`coordinator.test.mjs`、`service-diagnostics.mjs`、`service-diagnostics.test.mjs`；`package.json`、A 自审 |
| B（`5b8cb06`） | 搜索、范围读取、SHA 绑定局部编辑、会话文件差异；文件操作未知持久化与恢复 | `src/coding-files.ts`、`assistant-coding.ts`、`assistant-commands.ts`、`assistant-context.ts`、`assistant-loop.ts`、`assistant-result.ts`、`assistant-tools.ts`、`tool-registry.ts`；`control-plane.mjs`；`test/coding-files.test.mjs`、`coding-bridge.test.mjs`、`coding-harness.mjs`；`package.json`、B 自审 |
| C（`da2cd66`） | 预览截断前采集并脱敏日志；受控分页读取；实际 API/卡片/日志入口；源文件 SHA 与保存结果 SHA 分开 | `src/command-logs.ts`、`assistant-commands.ts`、`command-lifecycle.ts`、`assistant-context.ts`、`assistant-loop.ts`、`assistant-result.ts`、`tool-registry.ts`；`control-plane.mjs`、`server.mjs`；`web/assistant-view.ts`、`assistant.ts`、`assistant.css`；`test/command-logs.test.mjs`、`coding-view.test.mjs`、`coding-baseline.test.mjs`、`coding-harness.mjs`；`package.json`、C 自审 |
| D（本变更集） | 五个隔离工程场景、真实生产 HTTP 组装与日志访问边界、显式授权的真实模型评估入口及保护测试 | `scripts/evaluate-coding-real.mjs`；`test/coding-mvp.test.mjs`、`coding-real-entry.test.mjs`、`coding-http.test.mjs`；`package.json`；README、工具参考、变更回顾、协作索引、本报告 |

没有重写模型传输、可信验收、调度器或员工 CLI。新增工具均实际进入模型目录；未以额外测试函数替代生产装配。详细工具输入/输出例子、界面入口和运行评估步骤集中在 [工具参考](../../../docs/参考/工具上下文与记忆.md#编码工具与评估)，避免多份操作说明。

## 五个工程场景

均为 Windows 本地实际文件、实际主循环、生产文件/命令桥接、SQLite 和批准的固定 Node 检查。模型决策使用受控序列；不代表真实模型成功率。检查脚本在可写 `src` 外冻结，不修改验收脚本来制造通过。

| 场景 | 可核对行为与实际结果 |
| --- | --- |
| 1 搜索修复 | `search_files` 定位 `src/add.cjs` 的 BUG；范围读取取得 SHA；真实检查先失败；唯一编辑 `a-b → a+b`，记录第 1 行差异；固定检查重验通过 |
| 2 大文件局部改动 | 超过 100 KiB、7,000 行 CRLF 源文件，只读目标附近不足 300 字节入上下文；哈希扫描字节如实报告；`module.exports=1 → 2` 后其他字节完全一致，检查由失败转通过 |
| 3 两个源文件 | `src/a.cjs`、`src/b.cjs` 各局部修改；预置用户注释与 user.txt 字节保留；get_diff 只归属本次替换，不把用户内容算作贡献；检查由失败转通过 |
| 4 日志末尾错误 | 检查先输出 25,000 字符，关键 `LATE_ASSERTION: expected 5, actual -1` 在末尾；预览截断，持久化日志完整；模型上下文通过 read_output tail 实际拿到错误再修复；重验退出码 0、证据通过 |
| 5 外部修改冲突 | 首次读取后模拟用户插入注释；旧 SHA 编辑拒绝且不产生写意图；重新读取再编辑，一次有效写入，用户注释保留，不自动重放旧补丁；最终检查通过 |

首次执行 `.tmp-p0-p2/p1-D-first.log` 为 5/5 通过。首次工件根目录：`.tmp-p0-p2/p1-mvp/1792325409450-0f6933f6-c5e0-4e17-ade9-700bad9d0eaa/`，其中 `scenario-1-search-repair`、`scenario-2-large-source`、`scenario-3-two-files`、`scenario-4-late-log`、`scenario-5-external-change` 各有 `index.html`（实际生产 renderer）、`evidence.json`（事件、检查版本/代码指纹、真实进程结果、diff、日志页）及 `project/` 副本。仅生成测试文件；工件忽略，不作为产品数据或用户代码提交。

`coding-http.test.mjs` 另经过 `server.mjs → control-plane → createAssistantInference → inferModel` 的本地协议服务、实际权限/API 批准、编码工具、真实可信检查、尾部日志、交付状态。证实会话完成且 verified、仍 not_accepted；跨会话日志 400；浏览器共用结果模块可加载，宿主命令模块 404。没有收费模型或员工 CLI。

浏览器对首次场景 4 HTML 实际展开命令、日志尾部、差异与交付卡，观察到末尾断言、修改前后 SHA、`verified / 尚未正式验收`；截图 `.tmp-p0-p2/p1-delivery-ui.png`。这是生产 renderer 的真实保存事件回看与离线页交互；实际 API 由上述 HTTP 测试覆盖，没有冒称跑过整套实时产品界面的浏览器端到端验收。

## 真实模型评估入口

`npm run eval:coding:real -- --inspect` 只读现有配置；`--settings-db`、`--session-id` 可选。未提供批准清单时明确 not_run/requests=0；读取配置也不自动授权收费。

批准清单绑定模型配置 SHA、费用币种/预算/每请求预留上界、请求次数（最多 24）、时间（最多 30 分钟），并明确批准隔离目录编辑、固定检查及服务商侧预算。通过生产 createAssistantInference、createScheduling、createAssistantLoop、文件/命令桥接执行小型加法修复。只批准 `src/add.cjs` 编辑及 `unit/check.cjs/5000ms` 检查，拒绝范围外请求；不修改用户项目/设置，不自动配置多 Agent。

费用继续按生产账本预留/结算，未知用量与实际费用为 null；上界是用户提供的估计，不是服务商强制限额，必须在服务商侧确认预算。报告包含配置摘要/版本、授权清单、代码哈希、工具与审批事件、拒绝完成次数、检查证据、用量/费用 null、账本、耗时和目录。密钥不打印；原始异常不输出到 CLI。结果与 SQLite 留在自己的临时目录供核对；失败不自动重试旧操作。

**本轮没有用户批准的收费预算，因此真实服务模型任务未执行，模型自主能力未验证。** 本地协议夹具使用显式测试批准清单跑同一入口：9 次请求、9 项 unmeasured/amount=1/actual=null 预留，先失败后通过，最终未正式验收。该结果属于离线工程证据，不能归入真实模型统计。

## 首次失败与修复证据

- A：`.tmp-p0-p2/p1-A-before.log` 2/2 失败，长结果错误显示成功、空白命令产生虚假未知；修复后相关 26 项通过，隔离暂存快照再构建/验证。不是可信验收被绕过的复现。
- B：`.tmp-p0-p2/p1-B-before.log` 3/3 失败（缺少代码工具）。首次组合 55/56 有夹具旧决策队列问题，修正队列使用，不删除断言；最终 `.tmp-p0-p2/p1-B-final.log` 58/58。
- C：`.tmp-p0-p2/p1-C-before.log` 2/2 失败（未采集完整日志）；首次 34/36 揭示尾部取页方向问题，修正从末尾反向分页。源 SHA 被结果 JSON SHA 覆盖的新增测试先失败再修复。容量清理相同时间戳下排序不稳定，改按 event_id；`.tmp-p0-p2/p1-C-final-v2.log` 21/21，另 `p1-C-focused.log` 39/39。计数来自不同定向范围，不合计为全量。
- D：五个场景首次 5/5；生产 HTTP 首次 1/1。评估入口首次 `.tmp-p0-p2/p1-D-entry-first.log` 为 1 通过/1 失败：入口错误地要求执行器可执行文件为绝对 process.execPath，而生产 run_check 固定传 `node`，因此拒绝检查并如实产生未知/attention，未假通过。保存 `p1-D-entry-first-report.json`；改为只允许固定 `node/check.cjs/5000ms`，未放宽检查脚本、写入范围或进程事实要求。之后 `p1-D-entry-after.log` 2/2 通过。
- 最终自审又发现评估报告“先序列化再替换密钥”的转义边界，以及非 KEY/TOKEN 命名的选定凭据未包含在工件脱敏列表。新增逐字段 artifactJson 契约测试先失败（`p1-D-redaction-before.log`，函数未实现）；随后以旧生产序列化调用的隔离脚本快照，通过实际入口和本地协议夹具回显测试凭据，真实复现报告未脱敏（`p1-D-redaction-production-before.log`，1 失败）。当前生产入口改为先逐字段处理所有字符串，再 JSON 序列化，显式包含选定 apiKeyEnv 的值，测试使用引号和反斜杠的虚构凭据；`p1-D-redaction-integration.log` 3/3 通过。快照仅在忽略目录/临时文件运行，没有覆盖当前实现或使用收费服务。
- 首次标准全量运行 `p1-npm-test-first.log` 在自审修复前已报告 215 项通过、未记录失败，但为修复上述问题主动中止，不能计作完整通过。按已核对的创建时间/命令身份终止仅该次测试树；两项 taskkill 竞态提示随后用特定 PID 查询确认已不存在。保留原始日志和中止说明；修复后重新运行标准全量 `p1-npm-test-final.log`，这是代码变更后的必要验证，不是自动重试失败用例。
- 基线公开 CI #29/run39119148887 已实际下载失败日志和 test-diagnostics：Windows Server 2025、Node22.19.0，327 项 326 通过/1 失败；首个失败在 SSE 用例启动等待 `/api/snapshot`，未进入业务断言，没有触发 35 分钟外层期限。与旧本机失败名称不同；启动延迟的具体原因仍未确认。诊断补丁不能宣称已解释间歇问题；详见 A 自审。

## 验证环境与命令

实际 Windows NT 10.0.26200 x64、PowerShell 7.6.5、仓库 Node 22.19.0；系统 Node22.15 未用于验收。命令中的 npm 通过 `node D:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js` 执行，PATH 前置 `.tmp-p0-p2/node22`。

| 实际检查 | 结果/记录 |
| --- | --- |
| `npm run check`、`npm run build` | 通过；`p1-D-check.log`、`p1-D-build.log` |
| `node --test --test-concurrency=1 --test-timeout=70000 test/command-lifecycle.test.mjs test/coding-mvp.test.mjs test/coding-real-entry.test.mjs test/coding-http.test.mjs` | 19 通过/0 失败/0 跳过，66.29 秒；`p1-D-directed.log`，真实 Windows 后代/超时/取消竞争仍通过 |
| 评估工件脱敏修复后的入口回归 | 3 通过/0 失败，9.75 秒；`p1-D-redaction-integration.log`；`npm run check` 再次通过（`p1-D-check-final.log`） |
| 标准 `npm test`（包含全部新测试；35 分钟外层 watchdog，触发即失败） | **356 通过、0 失败、0 取消、0 跳过**，测试耗时 1,241,537.28 ms（20 分 41.54 秒），外层进程退出码 0、未触发 watchdog；`.tmp-p0-p2/p1-npm-test-final.log`。首次中止记录另见上文，不替代最终结果 |
| 当前提交 GitHub CI | 未触发（未 push）；没有用历史绿色 CI 代替 |
| Linux/macOS 实机 | 未执行；WSL 列表为空、没有可用发行版，不安装环境。纯能力测试覆盖 linux 拒绝托管命令、目录禁用检查、文件工具仍可用，不能计作 POSIX 实跑 |
| 真实服务模型/收费/员工 CLI | 未执行；本轮新增能力不要求安装 CLI，生产推理协议由本地 HTTP 夹具验证 |

新测试全部加入标准 npm test，MVP 单独入口 `npm run test:coding:mvp`；评估脚本语法加入 check。CI 原有 Windows Node22.19.0、job45分钟、测试35分钟及总日志 always 工件继续生效。没有通过增加超时或失败自动重试制造全绿。

## 状态、权限与数据兼容性

没有新增并行数据库；复用 assistant_events、assistant_outputs、会话及现有 scheduling 账本。既有事件读取向后兼容；新 hostResultVersion=1 缺必要事实不成功，旧文件结果不一律判未知。源文件 sha256 和保存 JSON 摘要分开，长结果仍可按引用读；新命令预览截断不等于失败，日志缺失明确呈现。日志锚点不进普通上下文引用。

edit_file 与 write_file 标记写入，通过既有审批、项目互斥、停止/撤权和指纹；未知文件写入留下 intent，跨会话与重启仍阻止冲突写入，显式核对后恢复、不重放。未完成检查、失败、未知、缺契约不会显示为可信通过；修改代码或冻结检查使旧证据失效。普通非零退出可继续修复，不一律要求人工恢复。

日志在内存预览截断前采集、持久化前跨 chunk 脱敏；读取需要操作/引用归属当前会话，SHA 校验不通过暴露完整性错误。输出与 diff 在 UI 作为不可信文本处理；测试覆盖脚本/HTML 内容转义。API 只公开必要的浏览器共用结果模块，不公开宿主源码目录。

## 自审与剩余限制

自审检查 A/B/C 调用方、错误路径、持久化与恢复、工具 Schema/执行器、源码边界、日志归属与脱敏，以及 D 生产入口的默认不收费、配置版本、固定批准和 ledger。未削弱 P0 的可信检查/代码版本要求或 Windows Job 判定，没有新生产 HTTP 故障开关。D 暂存仅本轮 10 个明确文件；代码/测试/package 哈希与冻结审查清单一致，未混入用户原有变更。修复已发现的评估工件脱敏问题后，定向测试与完整 356 项全部通过，自审通过，可作本地开发提交；不代表人工验收、真实模型评估或发布批准。

最终完整运行中，基线 CI 曾失败的 SSE stale revisions 用例为第 241 项，6,172.45 ms 通过；这仍不能解释历史启动延迟。模型、生命周期、SQLite 账本失败、权限/可信验收、MCP、委派、模型选择及新代码工具/日志/评估入口均包含在该次标准全量结果中。五个场景再次生成独立证据工件；没有将不同定向测试的计数相加冒充全量。

更新的 README、工具参考、变更回顾、协作索引和本报告共 95 个本地文档链接校验通过；`git diff --check` 未发现空白错误。浏览器临时标签和只读证据服务在核对后已关闭，未保留后台服务。

1. Windows 有真实托管测试；Linux/macOS 仅诚实禁用命令，不声称 POSIX 进程治理或 OS 沙箱。
2. 源文件编辑 2 MiB、读取 8 MiB、搜索 400 文件/2 MiB/软 1.5秒/单文件256 KiB；原可信验收 3,000 项/8 MiB 限制和受保护依赖问题仍在。
3. 文件版本复查后改名不是与任意外部写入者之间的原子 CAS。出现写入或记录未知需核对；没有通用 checkpoint/回滚。搜索文件系统 I/O 软期限不能硬中断阻塞系统调用。
4. get_diff 是会话文件工具操作记录，非 Git 全工作区净差异，不涵盖命令修改；有界分页与截断如实报告。
5. 日志工件合计 8 MiB、7天读取期/惰性清理；事件历史片段另属既有数据库，不声称整个 SQLite 限额。文本 UTF-8 MVP，不是任意二进制终端的逐字节日志保真。超限仍保留有界尾部，缺失内容不可恢复。
6. 真实模型、供应商用量账单与自主成功率未验证，不能把离线固定决策当作生产任务成功率。评估费用上界依赖用户估计及服务商侧预算。
7. 基线间歇启动延迟根因未确认；新的诊断和当前测试结论不消除历史证据。未发布或宣称全面高度可用。

后续按优先级单独处理：P1 启动阶段诊断若捕获失败则定位首个 HTTP/退出证据；P1 用户授权后运行真实模型小修复评估并核对账单；P2 验收规模与依赖闭包、文件外部并发一致性和更精细工具卡展示；P2 其他平台命令托管。原生 Tool Calling、完整沙箱、多 Agent 新功能、通用日志平台不在本轮。
