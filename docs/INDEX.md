# 功能索引（INDEX）

- **用途**：一张表定位每个功能的当前契约、验收方式与已知限制。新增或变更功能提交时必须更新对应行（见 `AGENTS.md` 开发与提交规则）。
- **状态**：active = 当前主线维护；beta = 可用但仍在打磨；frozen = 已隔离不再演进（修改需先解除隔离并说明理由）。
- **验收记录**：`协作/` 下按日期命名的自审/验收文档；被新文档取代的记录移入 `docs/归档/` 并在此标注 superseded。
- 首版生成于 2026-10-25，来源：README「核心功能」表 + `协作/` 目录最新验收标题。

| 功能 | 状态 | 契约文档 | 验收方式（脚本/测试） | 最新验收记录 | 已知限制 |
| --- | --- | --- | --- | --- | --- |
| 前端 HTML 渲染安全（P9） | active | docs/开发约定.md（前端 HTML 转义） | `npm test`（html、coding-view、execution-ui、readiness、delivery-review 等）+ `npm run test:ui:html`、既有 UI 验收脚本 | 协作/2026-10-25-P9辅助渲染模块迁移与自审.md | 20 个模块已迁移，手写实体转义集中到 html.ts，旧 escapeAssistant 导出兼容；模板不替代 URL/CSS 校验，lint 非完整污点分析 |
| 流式对话与会话管理 | active | docs/架构设计.md（主循环）、README「配置指南」「请求体限额」 | `npm test`（conversation-ui/conversation-model 等）+ `npm run test:ui:browser` | 协作/20261024-Agent消息幂等开发与自审.md | 消息类 256KB / 配置类 64KB / 默认 30000 字符（2026-10-25 起，见 README） |
| 项目工具（文件/进程/验证） | active | docs/开发约定.md（生产 Git 与项目扫描）、docs/架构设计.md | `npm test`（assistant-*、command-*、project-io）+ 任务流/恢复浏览器回归 | 协作/2026-10-25-生产Git与扫描异步化及自审.md | 递归扫描使用 2 Worker / 32 排队 / 120 秒期限；单文件原子写入、SQLite 与未知进程探测仍同步；Windows 需 22.19–22.x 或 24.22–24.x |
| 自动协作（Director 计划） | active | README「核心功能」、docs/使用指南.md | `npm run test:ui:task-flow` | 协作/20261022-交互执行重构自审.md | 每步 Run 启动前需单独审批（设计如此） |
| 能力调度 | active | docs/架构设计.md、docs/开发约定.md（生产 Git 与项目扫描） | `npm test`（coordinator、autonomy、workflow 等） | 协作/2026-10-25-生产Git与扫描异步化及自审.md | 异步准备阶段占用执行槽；暂停后排队、取消不启动 Agent，保留托管工作区证据 |
| 规划会议 / 集成审查等遗留域 | frozen | docs/参考/（历史设计） | `npm test`（collaboration 等回归） | 协作/20261018-P0可信验收开发与自审.md（superseded 前最后记录） | 已由 409 开关隔离；拆分计划见 协作/2026-10-24-问题解决方案.md P6 |
| 额度与预算 | active | docs/使用指南.md（额度） | `npm test`（inference-accounting、evaluation-budget） | 协作/20261024-四项能力验证与自审.md | ApiX 预算记录不等同于平台余额 |
| 并行执行与调度 | active | docs/架构设计.md | `npm test`（scheduling、workflow） | 协作/20261022-多Agent失败自动恢复自审.md | — |
| 执行监督（mailbox/锁） | active | docs/架构设计.md | `npm test`（messaging、agent-health） | 协作/20261024-Agent消息幂等开发与自审.md | SSE 事件流为事件驱动（写入即 50ms 去抖推送）+ 30s 兜底轮询 + 15s 心跳（2026-10-25 起，P11） |
| Git 代码交接（worktree/交付冻结） | active | docs/使用指南.md（验收）、docs/开发约定.md（生产 Git 与项目扫描） | `npm test`（coordinator、project-io、project-baseline、delivery-*、coding-*） | 协作/2026-10-25-生产Git与扫描异步化及自审.md | 异步 Git 队列 4 并发 / 64 排队；冻结复核状态、权限和指纹，集成应用按仓库互斥；不保证磁盘/Git 总耗时 |
| 失败恢复 | active | docs/架构设计.md | `npm run test:ui:recovery` + `npm test`（workflow-recovery、fault-policy） | 协作/20261022-多Agent失败自动恢复自审.md | 恢复需人工确认，不自动重放未确认操作（设计如此） |
| 模型配置与供应商中心 | active | README「集中配置 Agent 供应商」 | `npm run test:ui:providers` + `npm test`（model-*、agent-providers） | 协作/20261022-JSON契约与供应商中心自审.md | Codex API 用 Responses、Claude 用 Anthropic Messages；Chat Completions 不能直供 CLI |
| 历史追踪（项目侧栏/归档） | active | docs/使用指南.md | `npm test`（chat-history、static-files） | 协作/20261020-项目目录整理自审.md | — |
| 知识库与工具治理 | active | 协作/20261024-四项能力接口与使用说明.md、docs/开发约定.md（前端 HTML 转义） | `npm run test:ui:knowledge` + `npm test`（tool-knowledge、knowledge-concurrency、html） | 协作/2026-10-25-P9知识库自动转义实施与自审.md；视图后续见 P9 渲染安全行 | 1MiB/文档、1.5MB 请求上限；SQLite 无 FTS5 时降级启动（检索不可用）；索引在主线程执行，超过 50ms 输出分块/入库耗时日志（P10 基线测量中，是否 Worker 化待数据） |
| 所有者门禁（owner access） | active | 协作/20261024-四项能力接口与使用说明.md | `npm test`（tool-knowledge、static-files 登录页）+ 冒烟（全面测试报告 §R2） | 协作/2026-10-24-全面测试报告.md | owner-access.json 必须为无注释 JSON，令牌 32–128 字符 |
| Windows 桌面版（Electron） | beta | docs/Windows桌面版.md | `npm run test:desktop` + `npm run test:desktop:app -- <exe路径>`；正常窗口导航/退出/重启检查 | 协作/2026-10-26-Electron实际运行验证与自审.md | 仅 Windows x64；Git 等 CLI 需自行安装；未配置签名或自动更新；应用探针核对包内 Node/npm 与项目 Worker |
| Node/npm 项目验证 | active | docs/Node-npm项目验证.md、docs/开发约定.md（生产 Git 与项目扫描） | `npm run test:npm` + `npm test`（project-io、coordinator 大目录响应性） | 协作/2026-10-25-生产Git与扫描异步化及自审.md | 副本准备和容量扫描使用 Worker，保留 20 副本 / 1GiB 等原有预算；仅 Node 22.19–22.x / 24.22–24.x、npm 10/11，其他限制见契约文档 |
| 本地 HTTP 回归夹具 | active | test/local-fetch.mjs、test/service-diagnostics.mjs | `npm test`（service-diagnostics、coordinator、npm-http 等） | 协作/2026-10-25-生产Git与扫描异步化及自审.md | 默认关闭连接、不重放写入；协调夹具启动 30 秒、等待按实际总时限；生产持久连接另有慢 Git/大目录回归 |

## 维护规则

1. 提交新增功能或变更现有功能行为时，同分支更新本表对应行（契约文档、验收方式、验收记录、限制），与「审查结论记录到 `协作/`」并列执行。
2. 功能被移除或长期冻结时，状态改 frozen 并在已知限制中注明隔离方式。
3. 被新验收文档取代的记录移入 `docs/归档/`，本表「最新验收记录」指向新文档。
