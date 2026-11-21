# 01 · 信息架构

## 1.1 现状核对（读代码得出，不是估算）

| 项 | 实测 |
|---|---|
| `<main id="page-*">` | 11 个：overview / assistant / settings / coordinator / workspace / director / missions / knowledge / memory / projects / resources |
| 侧栏入口 | 9 个 `<button class="nav-item" data-page-target>`：assistant、overview、coordinator、missions 常显；settings、knowledge、memory、projects、resources 藏在 `<details class="assistant-more">` 里 |
| 无导航入口的页面 | `workspace`（HTML 里就是 `active-page` 默认页）、`director`；两者只能靠页面内跳转进入 |
| 前端模块 | `web/*.ts` 共 29 个，其中 24 个通过 `html` 标签模板产出 HTML |
| 模块依赖（关键） | `coordinator.ts` 已挂载 requirements-form、scheduling-view、execution-view、autonomy-view、workflow-graph、readiness、runtime-interaction-form；`assistant.ts` 挂载 delivery-view、token-usage-view、collaboration-scene、runtime-interaction-form |
| 结论 | **同一个任务生命周期已被拆成：契约/调度/执行在 coordinator，交付审阅与用量在 assistant，工作区在 workspace 且无入口。** 页面数量不是主因，重复挂载才是。 |

因此这次改版的主要工作是**重新挂载已有模块**，而不是重写渲染逻辑。

## 1.2 现有页面处置表

| 现有页面（模块 / 入口） | 目标位置 | 处置 | 理由（一句） |
|---|---|---|---|
| `overview`（overview.ts / 常显） | 总览 | 保留 | 唯一跨任务视图，回答"今天我要处理什么"。 |
| `assistant`（assistant.ts + assistant-view.ts / 常显首位） | 全局命令条 + 右侧对话抽屉 | 降级 | 它同时挂着 `delivery-view` 与 `token-usage-view`，这两块不属于对话，应回任务页；对话本身是动作不是地点。 |
| `coordinator`（coordinator.ts / 常显） | 任务页 → 详情 → 运行 | 合并 | 该模块已加载契约表单、调度、执行、自主、工作流图、就绪检查六个子视图，本质就是任务详情。 |
| `workspace`（HTML 静态 / 无入口，默认页） | 任务页工作区抽屉；项目页 Worktree 区块 | 降级 | 无导航入口证明它只作为流程中转；工作区是任务的从属资源。 |
| `director`（HTML 内联 / 无入口） | 任务页概览「调度与预算」；总览预算卡 | 合并 | 内容是"给 ApiX 目标 → 计划 → 派工"，属于任务创建前置，不是独立工作区。 |
| `missions`（coordinator.ts 渲染 / 常显） | 任务页（列表 + 详情） | 保留并拆分 | 页面里塞了三套对象（Runtime 扫描 / 员工注册 / 任务列表），员工部分独立成页。 |
| `settings`（coordinator.ts 渲染 / 折叠内） | 设置 | 保留 | 低频、全局、与任何单一任务无关。 |
| `knowledge`（knowledge.ts / 折叠内） | 知识 → 知识库 / 工具安全 | 保留 | 已有独立模块与 `test:ui:knowledge` 验收脚本。 |
| `memory`（HTML 内联 + personal-memory.ts / 折叠内） | 知识 → 项目记忆 | 合并 | 记忆的写入者是员工、读取者是任务，属上下文资产。 |
| `projects`（HTML 内联 / 折叠内） | 项目 | 保留 | worktree、项目基线、交付证据的唯一归属地。 |
| `resources`（HTML 内联 / 折叠内） | 知识 → 能力与工具 | 合并 | Skills 与 MCP 和"工具安全"共用权限模型；现有 `resource-tabs` 已是页内分段范式，直接复用。 |
| （新增）员工 | 员工 | 新增 | `employee.ts`、`employee-settings.ts`、`agent-run-view.ts` 三个模块现在只能寄生在 missions 与 assistant 中。 |

账：11 − 6（assistant、coordinator、workspace、director、memory、resources 不再作为页面）+ 1（员工）= 6 页；一级入口 9 → 6。

## 1.3 新侧栏（6 个一级入口）

| 序 | 入口 | 承载模块（现有） | 默认视图 | 角标 |
|---|---|---|---|---|
| 1 | 总览 | overview.ts | 待你处理 | 三类待办计数之和 |
| 2 | 任务 | coordinator.ts（列表 + 四标签）、delivery-view.ts、token-usage-view.ts | 「需要你」分组 | 待审阅数 |
| 3 | 员工 | employee.ts、employee-settings.ts、agent-run-view.ts | 全部员工 | 后端不可用员工数 |
| 4 | 项目 | 现有 project-grid + 项目基线 | 全部项目 | 无 |
| 5 | 知识 | knowledge.ts、personal-memory.ts、resources 的 `resource-tabs`、工具安全 | 知识库 | 未知来源条目数 |
| 6 | 设置 | application-settings.ts、provider-center.ts | 应用 | 未配置供应商数 |

导航实现保持现状：`<button class="nav-item" data-page-target>` + `aria-current="page"`，760px 以下走 `#navigation-toggle` 抽屉（`inert`、Tab 循环、Esc、焦点恢复均已有实现，阈值统一到 767）。

侧栏底部保留现有的 `local-badge` 与版本号，并加一行 `Ctrl K 打开命令条` 提示。**不新增手动主题切换**：明暗跟随系统（`prefers-color-scheme`），与现有实现一致，避免引入第二套主题状态。

**删除 `<details class="assistant-more">`**：5 个入口藏进折叠是本轮信息架构问题的直接证据，6 个入口全部平铺。

## 1.4 任务页内部结构（主轴页）

| 区 | 宽度 | 内容 |
|---|---|---|
| 左：任务列表 | 320px（≤1023 折叠为顶部下拉；因侧栏 244px，1024 视口下详情只剩约 388px，不够两栏） | 三组：「需要你」（待审阅 / 等待输入 / 失败）→「进行中」→「已完成 · 近 7 天」 |
| 中：任务详情 | `--w-default` 880px 上限，随可用宽度收缩 | 粘性头部 + 4 个标签 |
| 右：上下文抽屉 | 480px，按需 | 工作区 / 对话 / 交互回答 |

四个标签按生命周期排序，且每个标签都对应**已存在的模块**，不需要新造视图：

| 标签 | 复用的现有模块 | 承载内容 |
|---|---|---|
| 概览 | scheduling-view.ts、autonomy-view.ts、workflow-graph.ts | 下一步行动卡、6 节点里程碑、调度与预算、员工与 worktree 摘要 |
| 契约与计划 | requirements-form.ts | 契约正文（目标 / 不做 / 验收标准 / 预算上限）、计划步骤、确认与修改 |
| 运行 | execution-view.ts、task-events.ts、runtime-interaction-form.ts、readiness.ts | 事件流（分组规则见 04 §4.4）、实时用量、停止运行 |
| 交付审阅 | delivery-view.ts、token-usage-view.ts | 交付物列表、diff 摘要、通过 / 打回、用量结算 |

「等待输入」不做成标签：它是阻塞态，用常驻待办条 + 运行标签内联卡呈现。

## 1.5 跨页常驻层

页面头下方 48px 待办条，6 页常驻：

| 位置 | 内容 | 点击 |
|---|---|---|
| 左 | `等待输入 2` `失败 1` `待审阅 3` | 打开对应抽屉，不离开当前页 |
| 右 | `预算告警`（仅超阈值时） | 跳到任务页对应任务 |

三项计数为 0 时整条 `hidden`（不占位）。计数来源沿用现有员工提问/审批接口，不新增后端字段。

## 1.6 深链

| 形态 | 示例 | 行为 |
|---|---|---|
| 任务 | `#/tasks/t_7f3a` | 切到任务页并选中该任务 |
| 标签 | `#/tasks/t_7f3a/run` | 同上并切到运行标签 |
| 交互 | `#/tasks/t_7f3a/interaction/i_2` | 打开交互抽屉并聚焦回答框 |
| 知识分段 | `#/knowledge/security` | 切开到工具安全段 |

实现：在现有页面切换函数前置一次 `location.hash` 解析，监听 `hashchange`；解析失败回落该页默认视图，不弹错。不引入路由库。

## 1.7 取舍记录

| 决策 | 选 | 因为 | 代价 | 可接受因为 |
|---|---|---|---|---|
| 主轴 | 任务 | 用户目标对象是任务，状态有唯一归属 | 任务页要挂 8 个模块 | 这些模块现已存在，只是换挂载点 |
| 对话 | 降级为命令条 + 抽屉 | 提需求发生在任意页；且它当前混装了交付审阅 | 首用需发现 `Ctrl K` | 空态与总览都提供显式发起按钮 |
| 员工 | 独立成页 | 三个模块已有独立状态（后端、在跑 Run、worktree 占用） | 多一个一级入口 | 员工是排障第一现场，任务页容纳不下 |
| 知识 | 一页四段 | 四者共用权限模型与检索 | 单页密度高 | 分段深链 + 段内单列，`resource-tabs` 已验证可行 |
| `workspace` | 抽屉而非页面 | 它当前连导航入口都没有 | 深链少一个页面 | 深链从 `#/workspace` 改为 `#/tasks/{id}/workspace` |
