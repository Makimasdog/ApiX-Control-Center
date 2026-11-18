# 04 · 组件清单

三个贯穿约束：

1. 动态 HTML 必须经 `web/html.ts` 的 `html` 标签模板产出（ESLint 拦截 `innerHTML` 插值模板）。任何"富文本"退化为「纯文本 + 固定结构」，例如契约正文按段落数组渲染。
2. 每个可见 `input` / `select` / `textarea` / `button` 必须有可访问名称——`verify-ui.mjs` 已对 8 个路由逐页断言 `missingInputNames` / `missingButtonNames` 为空。
3. 新组件放 `web/styles/components.css`，只允许 `var(--…)`；命名用 `apix-` 前缀避免与 `legacy styles.css` 的 37KB 旧类冲突。

尺寸基线：控件高 `--h-control: 32px`（紧凑 28 / 大 36），图标 16px，触控最小目标 32×32，列表行 48，表格行 40。

---

## 4.1 页面头 PageHead

- **现状**：`page-intro`（2 处 TS 生成）+ 4 个页面在 `index.html` 手写 intro + `eyebrow` 装饰行 + 各页 `h1` 位置不一致。
- **结构**：`<header class="apix-page-head">` → `<div>`（`<h1>` + `<p class="apix-page-head__desc">`）→ `<div class="apix-page-head__actions">`（次按钮 ≤1、主按钮 ≤1、更多菜单）。
- **变体**：`default`（列表页）、`compact`（任务详情粘性头，`h2` 规格）、`with-meta`（标题下加状态胶囊 + 项目 + 员工）。
- **状态**：`default` / `loading`（标题位 160×22 骨架）/ `error`（说明位换成 `InlineError`）。
- **可访问名称**：`h1` 文本即页面名；按钮用动词文案（`新建任务`、`注册员工`）。
- **出现页面**：6 页全部；任务详情用 `compact`。

## 4.2 统计卡 StatCard

- **现状**：`overview.css` 内的统计块与 `agent-workbench.css` 的计数卡各写一套。
- **结构**：`<section class="apix-stat">` → `<span class="apix-stat__label">`（12/18 muted）→ `<span class="apix-stat__value">`（28/36，`tabular-nums`，单位同元素 `nowrap`）→ `<span class="apix-stat__delta">`（可选）。
- **变体**：`plain`、`link`（整卡可点 + 右下箭头）、`warning`（左侧 3px 危险竖条 + 图标）。
- **状态**：`default` / `hover`（`link`：`--surface-hover`，140ms）/ `focus-visible`（2px 环）/ `loading`（数值位 88×28 骨架）/ `empty`（`—` + 「暂无数据」）/ `error`（`—` + `读取失败`）。
- **可访问名称**：`link` 变体 `aria-label`「{标签}：{数值}，查看详情」。
- **出现页面**：总览、项目、员工。

## 4.3 任务卡 TaskCard

- **现状**：`#task-list` 内的行由 `coordinator.ts` 渲染，样式散在 `coordinator.css`（0 处硬编码，但结构与 missions 页其他卡片不一致）。
- **结构**：`<li>` → `<a class="apix-task-card">` → 行 1 标题（14/22，`line-clamp: 2`）+ 状态胶囊；行 2 元信息（项目 · 员工 · 相对时间）；行 3 用量条（4px）。
- **变体**：`default`、`attention`（橙色左竖条 + 等待点）、`done`（文本 `--text-muted`）、`selected`（`--accent-subtle` + 3px 主色竖条）。
- **状态**：`default` / `hover` / `focus-visible` / `selected` / `loading`（3 行骨架）/ `error`（行 2 换成 `InlineError`）/ `empty`（列表级空态）。
- **可访问名称**：链接名称 = 标题 + 状态（状态用 `aria-describedby` 关联）；计数徽标不进名称。
- **出现页面**：任务、总览、项目、员工。

## 4.4 Run 事件组 EventGroup

- **现状**：平铺列表，`task-events.ts` 逐条渲染 `kind`，`agent-run-view.ts` 复用同一批事件但样式不同。
- **结构**：`<ol class="apix-run-log">` → `<li class="apix-run-log__group">` → `<button class="apix-run-log__head" aria-expanded>`（图标 + 摘要 + 条数 + 时长）→ `<ol class="apix-run-log__body" hidden>` → 若干行。行固定三段：时间/图标、`kind` 模板、耗时或状态。
- **分组规则（按 kind 白名单，不猜文本）**：

| 组 | 包含 kind | 默认 |
|---|---|---|
| 生命周期 | `runtime.bound`、`turn.started`、`turn.finished`、`runtime.closed` | 折叠为 1 行摘要 |
| 工具调用 | `tool.started` + 配对 `tool.finished` | 合并 1 行（名称 + 耗时 + 结果），当前未完成的展开 |
| 输出 | 连续 `output.delta` | 合并为可展开文本，显示字符数 |
| 交互 | `interaction.opened` + `interaction.resolved` | 合并 1 行（问题摘要 → 回答摘要 → 耗时） |
| 投递 | `message.delivery` | 常驻可见，不折叠 |
| 用量 | `usage.updated` | 不进行，只更新右侧用量条 |
| 异常 | `runtime.error` | 常驻展开，永不折叠 |

- **状态**：`default` / `hover` / `focus-visible` / `expanded` / `running`（当前行左侧 2px 色条；`prefers-reduced-motion` 下不脉冲）/ `error`（`--danger-subtle` + `!`）/ `empty`（「还没有运行事件」）/ `loading`（3 行骨架）。
- **可访问名称**：分组按钮「工具调用 12 条，展开」；展开后 `aria-expanded="true"`。未识别 `kind` 走兜底模板显示原始 kind 文本，不抛错。
- **出现页面**：任务 → 运行；失败抽屉；员工详情（最近 Run）。

## 4.5 交互待办条 AttentionBar

- **现状**：不存在；等待输入只在 `runtime-interaction-form` 渲染处可见（主对话 / 协作页 / 员工 Run 视图三处各有一份）。
- **结构**：`<div class="apix-attention" role="region" aria-label="待处理">` → 3 个 `<button class="apix-attention__chip">`（圆点 + 计数 + 文字）→ 右侧可选 `预算告警`。
- **变体**：`inline`（页面头下方，48px）、`compact`（≤767，只留圆点 + 数字，文案进 `aria-label`）。
- **状态**：`default` / `hover` / `focus-visible` / `new`（1 次 300ms 高亮，不抢焦点）/ `empty`（整条 `hidden`，不占位）/ `error`（`待办读取失败` + 重试）。
- **可访问名称**：「等待输入 2 项，打开待办」。
- **出现页面**：6 页全部（任务页也显示，避免漏看别的任务）。

## 4.6 表格 DataTable

- **现状**：`desktop.css` 与 `styles.css` 各有一套表格样式，表头粘性与空态行不统一。
- **结构**：`<div class="apix-table-wrap" role="region" aria-label tabindex="0">`（窄屏横向滚动容器）→ `<table>` → `<caption class="sr-only">` → `<thead>`（`position: sticky`，`--z-thead`）→ `<tbody>`。
- **变体**：`default`、`dense`（行高 36，13px，用于事件与用量）、`selectable`（首列复选）。
- **状态**：`default` / `hover`（行底 `--surface-hover`）/ `focus-visible` / `sorted`（箭头 + `aria-sort`）/ `loading`（5 行骨架、表头保留）/ `empty`（`<tbody>` 单行空态：图标 + 文案 + 一个主操作）/ `error`（单行内联错误 + 重试）/ `partial`（个别行失败只影响该行）。
- **可访问名称**：`th` 带 `scope="col"`；排序按钮 `aria-label`「按{列名}排序」。
- **出现页面**：员工、项目、知识（知识库/能力与工具/工具安全）、设置（供应商）。

## 4.7 时间线 Timeline

- **现状**：不存在独立组件；`workflow-graph.ts` 的图与 `autonomy-view` 的阶段条各画一套。
- **结构**：`<ol class="apix-timeline">` → `<li class="apix-timeline__node" aria-current="step">`（圆点 + 标题 + 时间 + 可选说明），竖线用 `::before`，不额外造 DOM。
- **变体**：`horizontal`（≥1024，任务概览顶部 6 节点：需求 → 契约 → 调度 → 执行 → 审阅 → 交付）、`vertical`（<1024 与抽屉内）。
- **状态**：`done`（实心点 + 完成时间）/ `current`（环 + 加粗）/ `pending`（空心 + muted）/ `failed`（危险实心 + 原因一行）/ `skipped`（虚线 + 「已跳过」）。
- **可访问名称**：`aria-current="step"` 仅给当前节点；节点读作「{标题}，{状态}，{时间}」。
- **出现页面**：任务概览、失败抽屉。

## 4.8 抽屉 Drawer

- **现状**：只有移动端导航抽屉（`#navigation-toggle` + `.navigation-backdrop`，z-index 39/40）。
- **结构**：`<div class="apix-drawer-backdrop">` + `<aside class="apix-drawer" role="dialog" aria-modal="true" aria-labelledby>` → 头（标题 + 关闭）→ 体（可滚动）→ 底（可选操作）。
- **变体**：`context`（480px）、`wide`（720px，工作区）、`sheet`（≤767：底部全宽，`min(85vh, 640px)`，仅上两角 `--r-dialog`）。
- **状态**：`default` / `open`（240ms，右移 16px + 淡入）/ `closing`（156ms）/ `loading`（体内骨架）/ `error`（体内 `InlineError`）。
- **可访问名称**：`aria-labelledby` 指向标题；关闭按钮 `aria-label="关闭抽屉"`。
- **行为**：打开时焦点进标题（`tabindex="-1"`）、Tab 内循环、`Esc` 关闭、关闭回到触发按钮、主体 `inert`（沿用现有导航抽屉实现，抽成通用函数）。
- **出现页面**：6 页全部。

## 4.9 对话框 Dialog

- **现状**：原生 `<dialog>` + `.assistant-dialog`，`border-radius: 18px`、`::backdrop #131b2b66`、`apix-dialog-in 160ms ease-out`。沿用，不换实现。
- **结构**：`<dialog>` → `form[method="dialog"]` 或内容容器 → 标题（`h2` + `aria-labelledby`）→ 正文（`aria-describedby`）→ 操作行（右对齐，次按钮左、主按钮右）。
- **变体**：`confirm`（默认焦点在安全按钮）、`form`（含输入）、`danger`（见 4.13）。
- **状态**：`default` / `open` / `submitting`（主按钮 loading，宽度不变，`aria-busy`）/ `error`（正文上方 `InlineError`）/ `disabled`（主按钮禁用 + 一行原因）。
- **可访问名称**：标题文本；正文首段作为描述。
- **出现页面**：任务、设置、知识、项目。

## 4.10 命令条 CommandBar

- **现状**：不存在。最快落地方式是复用主对话输入区的组合控件（项目选择 `project-picker.ts`、执行方式、模型选择）。
- **结构**：`<dialog class="apix-command">`（原生 dialog 获得顶层与 `::backdrop`）→ 输入行（图标 + `<input role="combobox" aria-expanded aria-controls>` + `Esc` 提示）→ 结果列表 `<ul role="listbox">` → 底部提示行（`↑↓ 选择 · Enter 确认 · Esc 关闭`）。
- **变体**：`task`（默认，输入即发起任务）、`navigate`（输入以 `/` 开头只做页面跳转）。
- **状态**：`default` / `typing`（「解析中…」）/ `confirm`（3 行参数摘要 + `发起任务`）/ `empty`（「没有匹配的页面或任务」）/ `error`（「需求解析失败，可先手动填写」+ 展开表单）/ `disabled`（无可用员工：「还没有可用员工，先去员工页配置」）。
- **可访问名称**：输入框 `aria-label="命令条"`；结果项读作「任务：修复 MCP 筛选」。
- **出现页面**：6 页全部（`Ctrl K`；侧栏底部有入口）。

## 4.11 空态 EmptyState

- **现状**：`empty` 类名在 TS 中出现 32 次，但文案与结构各不相同（有的只有一行文字，有的带按钮）。
- **结构**：`<div class="apix-empty">` → 图标（24px 线性，1.5px 描边）→ `<p class="apix-empty__title">`（16/24）→ `<p class="apix-empty__desc">`（13/20，≤2 行）→ 一个主操作。
- **变体**：`first-use`（引导配置，带「查看文档」次按钮指向站内知识库）、`no-result`（筛选无结果，主操作 `清除筛选`）、`cleared`（完成态，如「没有待审阅任务」）。
- **状态**：静态；`loading` 不属于空态，用骨架替代。
- **可访问名称**：标题即名称；按钮用动词。
- **出现页面**：6 页全部。

## 4.12 内联错误 InlineError

- **现状**：各页直接写 `<p role="status">` 或红色文字，无重试入口。
- **结构**：`<div class="apix-inline-error" role="status">` → 图标 `!`（`--danger`）→ `<span>` 文案 → `<button class="apix-text-action">重试</button>`。
- **变体**：`row`（表格/列表单行，单行不换行，超长截断 + `title`）、`block`（卡片内，≤2 行）、`form`（输入下方，13/20，`aria-describedby` 关联）。
- **状态**：`default` / `retrying`（`重试中…` + 禁用）/ `resolved`（消失，不留占位）。
- **可访问名称**：`role="status"` 触发朗读；文案写清"什么失败 + 怎么办"。
- **出现页面**：6 页全部。

## 4.13 危险操作确认 DangerConfirm

- **现状**：`dialog` 在 TS 中出现 95 次（含 `assistant-dialog`），但停止运行/删除项目/覆盖 worktree 三处的后果说明不统一。
- **结构**：复用 `Dialog` 的 `danger` 变体 → 标题（`{动词}？`）→ 后果 `<ul>`（每条一句，≤3 条）→ 可选校验输入（项目名末 4 位）→ `取消`（左，默认焦点）/ `{危险动词}`（右，`--danger` 填充）。
- **变体**：`two-step`（需输入校验）、`simple`（可恢复操作用）。
- **状态**：`default` / `verify`（校验未过：边框转 `--danger` + `form` 内联错误）/ `submitting`（`停止中…`）/ `error`（保留对话框，正文上方报错）。
- **可访问名称**：主按钮必须是具体动词（`停止运行`、`删除项目`、`覆盖并重开`），永不用"确定"。
- **文案规则**：必须回答"会发生什么 / 什么不可恢复 / 能否撤销"。
- **出现页面**：任务（停止/重开）、项目（删除）、知识（删除条目）、设置（重置配置）。

## 4.14 状态胶囊 StatusPill（补充）

- **现状**：`pill` / `badge` 各出现 5 次，色值散落在 `desktop.css`（17 处硬编码之一）。
- **结构**：`<span class="apix-pill"><span class="apix-pill__dot" aria-hidden="true"></span>文本</span>`，圆点 6px，不用图标。
- **变体**：`info`（运行中，teal）、`success`（已交付）、`warning`（等待输入）、`danger`（失败）、`neutral`（已停止/草稿）、`accent`（待审阅）。
- **状态**：静态；`pulse` 仅运行中，`prefers-reduced-motion` 下取消。
- **可访问名称**：文本即名称，圆点装饰。
- **出现页面**：6 页全部。

## 4.15 用量条 UsageBar（补充）

- **现状**：`token-usage-view.ts` 有实现，但只挂在主对话；任务页与员工页需要同一组件。
- **结构**：`<div class="apix-usage" role="progressbar" aria-valuenow aria-valuemax aria-label>` → 轨道（4px，`--surface-inset`）→ 填充（`--accent`；>80% 转 `--warning`；>100% 转 `--danger`）→ 右侧 `1.2M / 2M`（12/18，`nowrap`）。
- **状态**：`normal` / `near-limit` / `over-limit` / `loading`（灰 30%）/ `stale`（>60s 未更新，数值前加 `~`）。
- **可访问名称**：「本次任务已用 1.2M Token，上限 2M，60%」。
- **出现页面**：总览、任务、员工、设置。

---

## 4.16 组件 × 页面覆盖矩阵

| 组件 | 总览 | 任务 | 员工 | 项目 | 知识 | 设置 |
|---|---|---|---|---|---|---|
| 页面头 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 统计卡 | ✓ | — | ✓ | ✓ | — | — |
| 任务卡 | ✓ | ✓ | ✓ | ✓ | — | — |
| 事件组 | — | ✓ | ✓ | — | — | — |
| 交互待办条 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 表格 | — | — | ✓ | ✓ | ✓ | ✓ |
| 时间线 | — | ✓ | ✓ | ✓ | — | — |
| 抽屉 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 对话框 | — | ✓ | — | ✓ | ✓ | ✓ |
| 命令条 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 空态 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 内联错误 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 危险确认 | — | ✓ | — | ✓ | ✓ | ✓ |
| 状态胶囊 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 用量条 | ✓ | ✓ | ✓ | — | — | ✓ |
