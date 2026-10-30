# 功能索引（INDEX）

- **用途**：一张表定位每个功能的当前契约、验收方式与已知限制。新增或变更功能提交时必须更新对应行（见 `AGENTS.md` 开发与提交规则）。
- **状态**：active = 当前主线维护；beta = 可用但仍在打磨；frozen = 已隔离不再演进（修改需先解除隔离并说明理由）。
- **验收记录**：`协作/` 下按日期命名的自审/验收文档；近期记录在 `协作/审查/YYYY-MM/`；历史证据在 `协作/归档/YYYY-MM/`，归档不等于失效。
- 首版生成于 2026-10-25，来源：README「核心功能」表 + `协作/` 目录最新验收标题。

| 功能 | 状态 | 契约文档 | 验收方式（脚本/测试） | 最新验收记录 | 已知限制 |
| --- | --- | --- | --- | --- | --- |
| 后端源码中文注释与历史报告 | active | 各后端模块中文注释；[2026-10-24-zcode全面测试报告](归档/测试报告/2026-10-24-zcode全面测试报告.md)（历史记录） | TS/C# 语法等价及 PowerShell Token 核验、`npm run build`、`npm run check`、assistant-loop/token-usage 回归 | [2026-10-27-后端中文注释同步自审](../协作/归档/2026-10/2026-10-27-后端中文注释同步自审.md) | 提示词含两处已确认的引号替换；未重跑全量/浏览器/真实模型；历史报告不代表当前版本验收 |
| 前端 HTML 渲染安全（P9） | active | [开发约定](开发约定.md)（前端 HTML 转义） | `npm test`（html、coding-view、execution-ui、readiness、delivery-review 等）+ `npm run test:ui:html`、既有 UI 验收脚本 | [2026-10-25-P9辅助渲染模块迁移与自审](../协作/归档/2026-10/2026-10-25-P9辅助渲染模块迁移与自审.md) | 20 个模块已迁移，手写实体转义集中到 html.ts，旧 escapeAssistant 导出兼容；模板不替代 URL/CSS 校验，lint 非完整污点分析 |
| 流式对话与会话管理 | active | [架构设计](架构设计.md)（主循环）、README「配置指南」「请求体限额」 | `npm test`（conversation-ui/conversation-model 等）+ `npm run test:ui:browser` | [20261024-Agent消息幂等开发与自审](../协作/归档/2026-10/20261024-Agent消息幂等开发与自审.md) | 消息类 256KB / 配置类 64KB / 默认 30000 字符（2026-10-25 起，见 README） |
| 项目工具（文件/进程/验证） | active | [开发约定](开发约定.md)（生产 Git 与项目扫描）、[架构设计](架构设计.md) | `npm test`（assistant-*、command-*、project-io）+ 任务流/恢复浏览器回归 | [2026-10-25-生产Git与扫描异步化及自审](../协作/归档/2026-10/2026-10-25-生产Git与扫描异步化及自审.md)；[Windows 命令入口 UTF-8 修复](../协作/审查/2026-10/2026-10-28-Windows命令入口UTF8修复自审.md)（33 项原生回归） ；[CI 路径与 watchdog 自审](../协作/审查/2026-10/2026-10-29-CI长短路径与取消清理watchdog自审.md)（本地定向 40 项通过，远程 CI 待执行） | 递归扫描使用 2 Worker / 32 排队 / 120 秒期限；单文件原子写入、SQLite 与未知进程探测仍同步；Windows 需 22.19–22.x 或 24.22–24.x |
| 自动协作（Director 计划） | active | README「核心功能」、[使用指南](使用指南.md) | `npm run test:ui:task-flow` | [20261022-交互执行重构自审](../协作/归档/2026-10/20261022-交互执行重构自审.md) | 每步 Run 启动前需单独审批（设计如此） |
| 能力调度 | active | [架构设计](架构设计.md)、[开发约定](开发约定.md)（生产 Git 与项目扫描） | `npm test`（coordinator、autonomy、workflow 等） | [2026-10-25-生产Git与扫描异步化及自审](../协作/归档/2026-10/2026-10-25-生产Git与扫描异步化及自审.md) | 异步准备阶段占用执行槽；暂停后排队、取消不启动 Agent，保留托管工作区证据 |
| 规划会议 / 集成审查等遗留域 | frozen | docs/参考/（历史设计） | `npm test`（collaboration 等回归） | [20261018-P0可信验收开发与自审](../协作/归档/2026-10/20261018-P0可信验收开发与自审.md)（superseded 前最后记录） | 已由 409 开关隔离；拆分计划见 [2026-10-24-问题解决方案](../协作/归档/2026-10/2026-10-24-问题解决方案.md) P6 |
| 额度与预算 | active | [使用指南](使用指南.md)（额度） | `npm test`（inference-accounting、evaluation-budget） | [20261024-四项能力验证与自审](../协作/归档/2026-10/20261024-四项能力验证与自审.md) | ApiX 预算记录不等同于平台余额 |
| Token 用量账本、上下文优化与任务面板 | active | [Token 设计与实现契约](专题/Token用量与优化.md)；[Reasonix 源码核查与 R3 方案](设计/2026-10-29-Reasonix源码核查与ApiX缓存优化方案.md)；[后续设计](设计/README.md) | `npm test`（token-usage、assistant-loop、model-backend、prompt-diagnostics 等）+ `npm run check`、`npm run test:ui:tokens`；真实对照见记录 | [Reasonix 源码核查自审](../协作/审查/2026-10/2026-10-29-Reasonix源码核查与缓存方案更新自审.md)（源码阅读与文档）；[设计与实现文档自审](../协作/审查/2026-10/2026-10-29-Token缓存设计与实现文档自审.md)（仅文档）；[诊断实施自审](../协作/审查/2026-10/2026-10-28-最终请求诊断实施自审.md)；[真实对照](../协作/审查/2026-10/2026-10-28-最终请求诊断真实对照实测.md)；[其他实测与审查](../协作/审查/2026-10/README.md) | 仅 ApiX API；CLI/旧历史用量及费用未知；节省模式须显式启用，小样本收益不代表跨任务收益；诊断重启/淘汰后精确前缀未知、供应商缓存原因未知；稳定帧与 DeepSeek 原生缓存适配待实施；历史全量超时及复测边界见原自审 |
| 并行执行与调度 | active | [架构设计](架构设计.md) | `npm test`（scheduling、workflow） | [20261022-多Agent失败自动恢复自审](../协作/归档/2026-10/20261022-多Agent失败自动恢复自审.md) | — |
| 执行监督（mailbox/锁） | active | [架构设计](架构设计.md) | `npm test`（messaging、agent-health） | [20261024-Agent消息幂等开发与自审](../协作/归档/2026-10/20261024-Agent消息幂等开发与自审.md) | SSE 事件流为事件驱动（写入即 50ms 去抖推送）+ 30s 兜底轮询 + 15s 心跳（2026-10-25 起，P11） |
| Git 代码交接（worktree/交付冻结） | active | [使用指南](使用指南.md)（验收）、[开发约定](开发约定.md)（生产 Git 与项目扫描） | `npm test`（coordinator、project-io、project-baseline、delivery-*、coding-*） | [2026-10-25-生产Git与扫描异步化及自审](../协作/归档/2026-10/2026-10-25-生产Git与扫描异步化及自审.md) | 异步 Git 队列 4 并发 / 64 排队；冻结复核状态、权限和指纹，集成应用按仓库互斥；不保证磁盘/Git 总耗时 |
| 失败恢复 | active | [架构设计](架构设计.md) | `npm run test:ui:recovery` + `npm test`（workflow-recovery、fault-policy） | [20261022-多Agent失败自动恢复自审](../协作/归档/2026-10/20261022-多Agent失败自动恢复自审.md) | 恢复需人工确认，不自动重放未确认操作（设计如此） |
| 模型配置与供应商中心 | active | README「集中配置 Agent 供应商」 | `npm run test:ui:providers` + `npm test`（model-*、agent-providers） | [20261022-JSON契约与供应商中心自审](../协作/归档/2026-10/20261022-JSON契约与供应商中心自审.md) | Codex API 用 Responses、Claude 用 Anthropic Messages；Chat Completions 不能直供 CLI |
| 历史追踪（项目侧栏/归档） | active | [使用指南](使用指南.md) | `npm test`（chat-history、static-files） | [20261020-项目目录整理自审](../协作/归档/2026-10/20261020-项目目录整理自审.md) | — |
| 知识库与工具治理 | active | [四项能力接口与使用说明](参考/四项能力接口与使用说明.md)、[开发约定](开发约定.md)（前端 HTML 转义） | `npm run test:ui:knowledge` + `npm test`（tool-knowledge、knowledge-concurrency、html） | [2026-10-25-P9知识库自动转义实施与自审](../协作/归档/2026-10/2026-10-25-P9知识库自动转义实施与自审.md)；视图后续见 P9 渲染安全行 | 1MiB/文档、1.5MB 请求上限；SQLite 无 FTS5 时回退到 `instr(lower(...))` 全表匹配，检索仍可用但成本随分块增长；索引在主线程执行，超过 50ms 输出分块/入库耗时日志（P10 基线测量中，是否 Worker 化待数据） |
| 所有者门禁（owner access） | active | [四项能力接口与使用说明](参考/四项能力接口与使用说明.md) | `npm test`（tool-knowledge、static-files 登录页）+ 冒烟（全面测试报告 §R2） | [2026-10-24-全面测试报告](../协作/归档/2026-10/2026-10-24-全面测试报告.md) | owner-access.json 必须为无注释 JSON，令牌 32–128 字符 |
| Windows 桌面版（Electron） | beta | [Windows桌面版](专题/Windows桌面版.md) | `npm run test:desktop` + `npm run test:desktop:app -- <exe路径>`；正常窗口导航/退出/重启检查 | [2026-10-26-Electron实际运行验证与自审](../协作/归档/2026-10/2026-10-26-Electron实际运行验证与自审.md)；[UTF-8 命令入口与开发版冒烟](../协作/审查/2026-10/2026-10-28-Windows命令入口UTF8修复自审.md) | 监督脚本须保留 UTF-8 BOM、C# 显式 UTF-8；旧包需重建；仅 Windows x64；Git 等 CLI 需自行安装；未配置签名或自动更新；应用探针核对包内 Node/npm 与项目 Worker |
| Node/npm 项目验证 | active | [Node-npm项目验证](专题/Node-npm项目验证.md)、[开发约定](开发约定.md)（生产 Git 与项目扫描） | `npm run test:npm` + `npm test`（project-io、coordinator 大目录响应性） | [2026-10-25-生产Git与扫描异步化及自审](../协作/归档/2026-10/2026-10-25-生产Git与扫描异步化及自审.md) | 副本准备和容量扫描使用 Worker，保留 20 副本 / 1GiB 等原有预算；仅 Node 22.19–22.x / 24.22–24.x、npm 10/11，其他限制见契约文档 |
| 本地 HTTP 回归夹具 | active | [local-fetch](../test/local-fetch.mjs)、[service-diagnostics](../test/service-diagnostics.mjs) | `npm test`（service-diagnostics、coordinator、npm-http 等） | [2026-10-25-生产Git与扫描异步化及自审](../协作/归档/2026-10/2026-10-25-生产Git与扫描异步化及自审.md) ；[CI 路径与 watchdog 自审](../协作/审查/2026-10/2026-10-29-CI长短路径与取消清理watchdog自审.md)（本地定向 40 项通过，远程 CI 待执行） | 默认关闭连接、不重放写入；协调夹具启动 30 秒、等待按实际总时限；生产持久连接另有慢 Git/大目录回归 |
| 文档与本地产物管理 | active | [目录结构](目录结构.md)、[文档导航](README.md)、[Code Wiki](CodeWiki/README.md) | Markdown 链接存在性、源码事实/行号核验、`git diff --cached --check`；归档脚本 `-WhatIf`、占用失败回归与实跑；历史夹具仅语法通过 | [Code Wiki 代码结构文档复核自审](../协作/审查/2026-10/2026-10-30-CodeWiki代码结构文档自审.md)；[整理自审](../协作/审查/2026-10/2026-10-28-文档与临时产物整理自审.md) | 本机临时归档不提交 Git；保留桌面打包与占用目录；Code Wiki 需随源码、导出、路由和表结构变化维护；历史复验夹具未适配当前鉴权；旧脚本仍可能生成 `.tmp-*`，用归档脚本收拢 |

## 维护规则

1. 提交新增功能或变更现有功能行为时，同分支更新本表对应行（契约文档、验收方式、验收记录、限制），与「审查结论记录到 `协作/`」并列执行。
2. 功能被移除或长期冻结时，状态改 frozen 并在已知限制中注明隔离方式。
3. 开发审查与验收历史移入 `协作/归档/YYYY-MM/`；产品旧说明移入 `docs/归档/`。本表指向最新适用证据。
