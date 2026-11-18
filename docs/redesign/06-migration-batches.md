# 06 · 迁移批次

排序：风险最低 → 最高。每批是一个可独立提交、可独立上线的完整中间态，出口条件是门禁三条全绿：

```
npm run build && npm run check && npm run test:ui:browser
```

补充事实（决定批次边界）：

- `npm run build` = `tsc`，把 `web/*.ts` 编到 `dist/web/*.js`；`index.html` 逐个 `<script type="module" src="./dist/web/xxx.js">` 加载，**新增/删除页面会同时改 `index.html` 与 `dist`**。
- `npm run check` = `tsc --noEmit` + 10 个 `.mjs` 的 `node --check`（含 `web/agent-os.js`）+ `scripts/check-stale-dist.mjs` + `eslint . --quiet`。**删除或改名 `web/*.ts` 后若不 build，`check-stale-dist` 会因 dist 孤儿产物失败**。
- 页面切换、`aria-current`、事件委托都在 `web/agent-os.js`（`activatePage` 与一个大 `closest("[data-page-target],…")` 选择器）。**IA 合批必须改这个文件**。
- `npm run test:ui:browser` = `scripts/verification/verify-ui.mjs`，路由清单写死为 8 个：`assistant, overview, settings, coordinator, missions, memory, projects, resources`（不含 workspace / director / knowledge），窗口 1440/1024/768/390 × 明暗 = 64 组合，断言页宽、溢出元素、导航关闭、标题匹配、输入/按钮可访问名称、7 组语义色对比度、tablist 方向键、表单重复提交。
- 仓库规则（`AGENTS.md`）：每批提交前审查最终 diff、用明确文件清单暂存（不用 `git add .`）、更新 `docs/INDEX.md` 对应行、审查结论写入 `协作/`。

## 6.1 批次总表

| 批次 | 主题 | 风险 | 页面可见效果 | 硬编码目标 |
|---|---|---|---|---|
| B1 | 令牌层冻结 + 两处对比度缺陷 | 低 | 几乎为零（仅深色输入框边框更清楚） | 73 |
| B2 | 空间语法 + 页面头 | 低–中 | 11 页边距、宽度、标题层级统一 | ≤ 60 |
| B3 | 组件层替换 | 中 | 胶囊/空态/错误/表格/统计卡统一 | ≤ 46 |
| B4 | Run 事件组 + 用量条 | 中 | 协作进度的事件流折叠为过程组 | ≤ 40 |
| B5 | IA 合并为 6 页 + 待办条 + 深链 | 高 | 侧栏 6 入口、任务页四标签、跨页待办 | ≤ 20 |
| B6 | 命令条 + 对话降级 + 清零 | 高 | `Ctrl K` 发起任务，assistant 页消失 | 0 |

## 6.2 B1 · 令牌层冻结

| 项 | 内容 |
|---|---|
| 目标 | 建立唯一取值来源，阻止新硬编码回流；同时修掉两处已实测失败的对比度 |
| 文件范围 | 新增 `web/styles/tokens.css`；改 `web/styles/design-system.css`（顶部引入 + 既有变量改为引用令牌，名字与值不变 + 两处色值修正）；不动 TS、不动 HTML |
| 要点 | ① 空间（`--s-*`、`--w-*`、`--gutter`）、排版（`--fs-*`）、圆角、动效、`--z-*` 全量落地；② 浅/深两套语义色沿用现有值；③ `--border-control` 深色 `#5b6478` → `#66718a`（2.74 → 3.33:1），直接闭合 `docs/INDEX.md` 中"输入区与执行方式选择框边框对比度待修复"；④ 新增 `--accent-alt-text: #0b7f76`（4.87:1）供正文使用 |
| 验证 | 三条门禁；`npm run test:ui:browser` 的 `contrasts` 报告里 `text-*`/`on-accent`/`success`/`warning`/`danger` 五组数值与改造前一致（仅 `border-control` 相关略升） |
| 回滚 | `git revert <sha>`；本批未触碰 TS/HTML，回滚零副作用 |
| 出口 | 令牌文件是唯一含十六进制定义的文件；`design-system.css` 组件规则内不再新增裸色值；`docs/INDEX.md` 该行"已知限制"更新为已修复 |

## 6.3 B2 · 空间语法 + 页面头

| 项 | 内容 |
|---|---|
| 目标 | 6/11 页共用边距、三档宽度与标题层级；消除每页自写 intro |
| 文件范围 | `web/index.html`（11 个页面头的统一结构）、`web/styles/design-system.css`、`web/styles/desktop.css`、`web/styles/styles.css`、`web/coordinator.ts`、`web/overview.ts`、`web/knowledge.ts` |
| 要点 | ① 落地 `--w-narrow/default/wide` = 640/880/1120 与 `--gutter` 4 档；② 页面级断点由 17 个阈值收敛到 4 个（≤767 / 768–1023 / 1024–1359 / ≥1360），组件级 ≤620 的 16 个阈值本批不动；③ `h1` 22/32、说明 13/20 且 ≤2 行；④ 纵向节奏按 `--s-4..6`；⑤ 删除 `text-align: justify` 与奇数间距（`9px` → `8px`） |
| 验证 | 三条门禁（64 组合已覆盖页宽溢出与可访问名称）；额外 `npm run test:ui:html` 防 HTML 视图回归 |
| 回滚 | `git revert <sha>`；结构变更与新样式同批，回滚后旧类仍可用 |
| 出口 | 11 页在 4 档宽度无横向溢出；页面头结构一致；`styles.css` 体积下降；`docs/INDEX.md`「前端视觉基线（画布）」行更新 |

## 6.4 B3 · 组件层替换

| 项 | 内容 |
|---|---|
| 目标 | 各页私有卡片/胶囊/空态/错误/表格收敛到 04 的 15 个组件 |
| 文件范围 | 新增 `web/styles/components.css`；改 `web/styles/design-system.css`、`desktop.css`、`styles.css`、`assistant.css`、`knowledge.css`、`agent-workbench.css`、`director.css`；改 `web/coordinator.ts`、`overview.ts`、`knowledge.ts`、`employee.ts`、`provider-center.ts` 的渲染片段（仍走 `html` 标签模板） |
| 要点 | ① 状态胶囊替换零散状态文本 + 圆点；② 空态与内联错误成对落地（区分「空」与「失败」，现状 32 处 `empty` 类名文案各异）；③ 表格统一行高 40、粘性表头、空态行；④ 统计卡 `tabular-nums` + 单位 `nowrap`；⑤ 可点元素 ≥32×32，焦点环统一 `outline 2px / offset 3px` |
| 验证 | 三条门禁；`npm run test:ui:html`；`npm run test:ui:providers`（供应商表格改造）；抽查每页至少一个空态与一个内联错误 |
| 回滚 | `git revert <sha>`；`components.css` 可整体移除，旧样式段本批不删 |
| 出口 | 同一语义在各页使用同一结构与同一组令牌；旧样式段标记待删（B6 统一删） |

## 6.5 B4 · Run 事件组 + 用量条

| 项 | 内容 |
|---|---|
| 目标 | 事件流由平铺改为过程组；失败与等待输入在折叠态也不丢 |
| 文件范围 | `web/task-events.ts`（新增分组纯函数）、`web/execution-view.ts`、`web/agent-run-view.ts`、`web/coordinator.ts`、`web/styles/components.css` |
| 要点 | ① 按 `kind` 白名单分组（生命周期 / 工具 / 输出 / 交互 / 投递 / 用量 / 异常）；② `tool.started` 与 `tool.finished` 配对合并；③ `runtime.error` 永不折叠；④ 当前运行行静态色条（`prefers-reduced-motion` 下不脉冲）；⑤ 未知 `kind` 走兜底模板；⑥ 用量条抽为共享组件，从主对话迁到任务页与员工页 |
| 验证 | 三条门禁；`npm run test:ui:task-flow`；`npm run test:ui:tokens`（用量视图改造）；事件条数守恒（折叠前后总数一致） |
| 回滚 | `git revert <sha>`；分组函数与视图解耦，回滚即回平铺 |
| 出口 | 100 条事件的 Run 折叠后可见行 ≤15；异常事件折叠态可见；`docs/INDEX.md`「Token 用量账本…任务面板」行更新 |

## 6.6 B5 · IA 合并为 6 页

| 项 | 内容 |
|---|---|
| 目标 | 落地 01 的合并、6 个一级入口、任务页四标签、跨页待办条、hash 深链 |
| 文件范围 | `web/index.html`（删 6 个 `<main>`、重建 6 个、侧栏重构、删 `<details class="assistant-more">`）、`web/agent-os.js`（`activatePage`、事件委托选择器、hash 解析）、`web/coordinator.ts`（任务页四标签编排）、`web/assistant.ts`（对话降级为抽屉，移出 delivery/token 视图）、`web/employee.ts`、`scripts/verification/verify-ui.mjs`（路由清单 8 → 6） |
| 要点 | ① 删除 `page-assistant/coordinator/workspace/director/memory/resources`，内容迁入标签、抽屉、知识分段、命令条；② 侧栏 6 项平铺 + `aria-current`；③ 任务页 320 / 880 / 抽屉 480；④ 常驻待办条（0 条时 `hidden`）；⑤ `#/tasks/{id}/{tab}` 深链与 `hashchange`；⑥ 760 → 767 阈值统一；⑦ `verify-ui.mjs` 的 `routes` 与 `#page-${route}.active-page` 等待条件同步更新 |
| 验证 | 三条门禁；`npm run test:ui:navigation`（导航与焦点恢复）；`npm run test:ui:projects`；`npm run test:ui:knowledge`；`npm run test:ui:agents`；`npm run test:delivery:browser` |
| 回滚 | `git revert <sha>`（HTML + agent-os.js + TS + 测试清单同一提交，整体回滚）；不允许只回滚其中一部分 |
| 出口 | 6 个 `<main>`、6 个入口、旧页面 id 全仓 0 命中；`verify-ui.mjs` 页面清单与新结构一致；深链冷启动可用；`docs/INDEX.md` 新增「控制台信息架构（6 页）」行 |

## 6.7 B6 · 命令条 + 对话降级 + 硬编码清零

| 项 | 内容 |
|---|---|
| 目标 | 提需求走全局命令条；对话以抽屉保留；73 处硬编码归零；删除已无引用的旧样式段 |
| 文件范围 | `web/index.html`（命令条与对话抽屉骨架）、`web/agent-os.js`（快捷键与焦点）、新增 `web/command-bar.ts`、`web/assistant-view.ts`、`web/styles/components.css`、`web/styles/design-system.css`、`web/styles/styles.css`、`web/styles/assistant.css`、`web/styles/desktop.css` |
| 要点 | ① `Ctrl K` 开关、`↑↓` 选择、`Enter` 确认、`Esc` 关闭、焦点陷阱与恢复；② 解析失败可展开手动表单（项目 / 员工 / 预算）；③ 无可用员工时给跳转而非死路；④ 先 `rg` 确认类名 0 引用再删旧 CSS；⑤ 清零后剩余 `rgba()` 阴影与遮罩登记在 §3.10 |
| 验证 | 三条门禁；新增 `npm run test:ui:command`（`scripts/verification/verify-command-bar.mjs`，沿用 `startDeliveryFixture` 模式，覆盖开关、键盘选择、焦点恢复）；`npm run test:ui:agents` |
| 回滚 | `git revert <sha>`；命令条可先移除快捷键绑定（侧栏底部入口保留），不阻塞任务页 |
| 出口 | 硬编码 0（除 §3.10 登记项）；命令条全键盘可用；`styles.css` / `desktop.css` 体积明显下降；`docs/INDEX.md` 三行更新（视觉基线 / 信息架构 / 命令条） |

## 6.8 每批的提交前清单（AGENTS.md 要求）

| 项 | 动作 |
|---|---|
| 审查 | 审阅最终 diff：新增文件、调用方、错误路径、数据一致性、访问边界 |
| 暂存 | 用明确文件清单 `git add <paths>`，不用 `git add .` |
| 文档 | 更新 `docs/INDEX.md` 对应行（契约文档 / 验收方式 / 已知限制） |
| 记录 | 审查结论、范围、验证结果、未验证项写入 `协作/审查/YYYY-MM/` |
| 提交信息 | 中文，写清"改了什么内容"，不只写文件名 |
| 未验证项 | 如实列出（例如"未做高 DPI 与屏幕阅读器实测"） |
