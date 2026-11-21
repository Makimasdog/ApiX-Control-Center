# 对标 agent-autoloop 的四项加固

> 参照对象：[KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)（6.1k star，零运行时依赖的无界面自动化中台）。
> 起因：2026-11-21 对照阅读后确认，ApiX 与其并非同类产品（我们做带界面的协作工作台，它做无界面的事件驱动调度内核），但在**内核工程纪律**上有四处值得吸收。
> 本文只列可落地的改动，按「收益 / 成本」排序，不含 UI 方向调整。

## 现状校准（先说结论，避免重复建设）

已具备、不需要重做：

| 能力 | 现状位置 | 说明 |
|---|---|---|
| append-only 事件账本 | `src/coordination/memory.ts` → `apix_ledger` | 已有 `append()/events()/stateAt()`，文件头即标注事件溯源 |
| 快照回放 | `memory.stateAt()` + `coordination.snapshot` | UI 时光机已在用 |
| 会话级事件流 | `assistant_events`（append-only，`eventId` 游标） | 50+ 处写入点，含 `verification_evidence` 证据链 |
| 副作用幂等 | `assistant_effects`（input/output fingerprint） | 重放时防重复执行 |
| 故障分类与恢复 | `src/recovery/fault-policy.ts` | 14 类故障 → retry/repair/stop/review |
| 自治边界 | `src/coordination/autonomy.ts` | `maxRepairs` / `maxMinutes` / `maxRunMinutes`，超限 `halt()` |

真正的缺口只有四条，下面逐条给文件级方案。

---

## P0 · Agent 消息链跳数熔断（真缺口，风险最高）

**问题**：`apix_ledger` 记了 `guidance.sent` 等事件，但 `agent_messages` 表没有 `hop` / `root_task_id` / `parent_message_id` 任何链路字段（`grep -c "depth|chain|rootTask|ancestor"` 在 `src/messaging/*` 结果为 0）。当前只有 `autonomy.maxRepairs`（同一任务的修复次数）和 `maxMinutes` 兜底，**无法阻止 A 让 B 派活、B 再让 C 派活形成的环形/无限链**，只能等超时。

**改动**：

1. `control-plane.mjs`：新增 schema 迁移版本（现有最高为 12，见 `schema_migrations` 表，迁移块写法照抄现有第 12 版），为 `agent_messages` 加三列：
   - `root_task_id TEXT`、`parent_message_id TEXT`、`hop INTEGER NOT NULL DEFAULT 0`
   - 加索引 `agent_messages_chain(root_task_id, hop)`
2. `src/messaging/mailbox.mjs` / `src/messaging/agent-mailbox.ts`：`send()` 接受可选 `parentMessageId`；落库时 `hop = parent.hop + 1`，`root_task_id` 沿父继承；无父则 `hop = 0`、`root_task_id = taskId`。
3. `src/coordination/coordinator.ts`：`instructEmployee`、`superviseWorkerMessage`、`guidance.*` 分支在投递前检查 `hop > MAX_HOP`（常量建议 8，与参照实现一致，放 `contracts.ts` 旁）；超限时：
   - **不投递**（不是投递后记录）
   - 写 `apix_ledger` 事件 `chain.capped`（含 root、hop、末端 agent、原始 messageId）
   - 生成一条待处理事项（沿用现有 attention 通道），人在界面上能看到
4. **关键约束**：`hop` 必须存库、不可由内存变量推导；人工指导（`guidance.sent`）与定时复查都不清零。这一点是参照实现刻意设计的，别做「人工介入后重置」。

**验收**：

- 新测试 `test/message-chain-budget.test.mjs`（**记得同时加进 `package.json` 的 `test` 与 `test:coverage` 两个显式文件列表，否则不会被执行**）：
  1. 构造 a→b→c 共 9 跳，断言第 9 跳未落库投递、`chain.capped` 事件存在、attention 项生成
  2. 每个中间跳的 `hop` 严格 +1，`root_task_id` 全程不变
  3. 用同一 DB 重建服务实例后，链路计数不回退（存库而非内存）
- 手工：`node --check` + `npm run check` 通过；老库迁移后现有消息 `hop=0` 可正常读取。

**成本**：1～1.5 天。**收益**：首个真实的失控场景护栏，面试可直接讲「用 TTL 思路解决 Agent 间递归派活」。

---

## P1 · `why` 单命令追溯（零风险，叙事收益最大）

**问题**：账本里已经有 `plan.created` / `plan.dispatched` / `guidance.*` / `task.*` / `coordination.snapshot`，但要回答「这一轮为什么跑、结果是什么」只能开 GUI 逐页翻。

**改动**：新增只读脚本 `scripts/inspect/why.mjs`。

- 用 `DatabaseSync(path, { readOnly: true })` 打开 `apix.sqlite`（与 `src/projects/delivery-inspection-worker.mjs` 同样的只读姿势），**不 import control-plane、不启服务、不写库**。
- 入参三选一：`--session <id>` / `--task <id>` / `--run <id>`。
- 输出一条时间线（stdout，可 `--json`）：
  ```
  #12  10-27 14:03  plan.created       修订 #3，5 个步骤
  #19  10-27 14:05  plan.dispatched    来源 user
  #24  10-27 14:06  guidance.sent      → employee/codex  「先改 A 模块」
  #31  10-27 14:22  task.completed     检查 unit 通过
  #33  10-27 14:25  coordination.snapshot  revision 7
  ```
  每行带 `apix_ledger.sequence`，用 `events()` 同款 SQL（按 `aggregate_id` 或 `project_id` 过滤），再按 sequence 与 `coordination_turns` 归并。
- npm 脚本：`"why": "node scripts/inspect/why.mjs"`。

**验收**：

- `test/why-trace.test.mjs`：内存库造一条「计划→派活→指导→完成」链，断言输出顺序、sequence 单调、字段齐全。
- 真实库手工跑一次 `npm run why -- --task <真实 id>`，与 GUI 时间线人工比对一致。

**成本**：0.5～1 天。**收益**：最低成本的可观测性能力，且完全不碰主路径。

---

## P2 · 账本从「旁路审计」变「可校验投影」（架构级，分三步走）

**问题（要害）**：现在 `apix_ledger` 是**旁路**——真状态在 `coordination_sessions` / `tasks` / `plans` 上就地 `UPDATE`，账本只负责追加。也就是说：

- `stateAt()` 依赖 `coordination.snapshot` 快照，**不能从零事件重建**
- 双写如果不在同一事务，会出现「日志说有、表里没有」（或反之）
- 数据格式变化时没有「从日志重建」这条路，只能写迁移脚本

**分三步，前两步都不改主路径：**

**Step 1（0.5 天）事务边界审计**
- `coordinator.ts` 已有 `transaction()` 包装，但需逐条确认所有「状态写入」都与其账本事件在同一事务内（目前 `transaction` 块内出现 `append/turn/checkpoint` 共 5 处，其余路径待审计）。
- 加防护测试 `test/ledger-atomicity.test.mjs`：对每个公开写操作（createSession / confirmSession / dispatchSession / instructEmployee / recordTask / authorizeRetry）注入一个「账本写入抛错」的 fake store，断言状态变更一并回滚。

**Step 2（2 天）只读重建校验器**
- `scripts/verify/rebuild-projection.mjs`：读 `apix_ledger` 全量重放，产出 `{session, plan, tasks}` 投影，与真实表逐字段 diff，输出差异率。只读、可反复跑。
- npm 脚本 `"verify:ledger": "node scripts/verify/rebuild-projection.mjs"`，进 CI。
- 允许白名单（时间戳、派生字段、`revision` 自增），目标：**差异率降到 0 并稳定在每次提交**。

**Step 3（不做，留作备选）** 读路径切投影。只有 Step 2 稳定运行数周后再考虑；**不建议**为了架构纯洁性重写主路径——现有双写 + 快照已能支撑产品，重写是净风险。

**验收**：`npm run verify:ledger` 在真实库上 diff=0；`test/ledger-atomicity.test.mjs` 全绿。

**成本**：2.5～3 天。**收益**：这才是「事件溯源」的真正含义，也是能讲清楚「为什么不是把日志当审计」的那一段。

---

## P3 · 性能基准 + 崩溃模拟（证据层）

**问题**：`find test -name '*.test.mjs'` 有 60+ 个文件，但 `grep -ril benchmark` 结果为 0、无 crash-sim。参照项目敢公开「冷启动 88ms / 派活 p99 1.82ms / 强杀 1000 次不丢」，这类数字是最硬的对外证据。

**改动**：

1. `scripts/benchmark/run.mjs`：测四件事并输出 markdown 表（写到 `协作/验收数据/benchmark/YYYY-MM-DD.md`，沿用现有验收数据目录）
   - 冷启动到 `/ready`（HTTP 200）
   - 空闲 RSS
   - 派活延迟 p50/p99（复用 `scheduling.ts` 的 `taskProfile` 造 fixture）
   - `apix_ledger` 纯写入 tps、10 万条事件后启动耗时
2. `scripts/verify/crash-sim.mjs`：临时目录起真实服务，随机 `SIGKILL` N 次（默认 200），每轮重启后校验
   - 已确认写入的 `apix_ledger.sequence` 无空洞
   - `assistant_effects` 里 `state='started'` 的残留项可被 recovery 识别
   - 跑完输出「N 次强杀，丢失 0 条已确认记录」
3. CI：`nightly.yml` 已有的定时任务里加 `npm run bench && npm run crash:sim`（Windows 与 Linux 各一，注意 `SIGKILL` 在 Windows 上要用 `taskkill /F`）。

**验收**：表格里有数字、能复现；崩溃模拟连续 3 次 CI 通过。

**成本**：1.5 天。**收益**：把「工程质量」从形容词变成数字。

---

## 明确不跟的部分

- **无界面**：它把「计划审查 / 验收问责 / 成本准入」全推给卡片和人，我们这三件事是产品核心，不砍。
- **Kernel/Host 目录切分**：参照实现 1948 行的单体（我们 `control-plane.mjs` 恰好也是 1948 行）拆成 `kernel/` `host/` `worker/` `protocol/` 是纯架构工程，收益在叙事不在当下，除非 P2 Step 3 决定切换读路径。
- **插件四向抽象**：我们有 MCP + `runtime-adapters` + `agent-providers`，方向已定，不需要改成 `source/agent/channel/delivery` 四接口。

## 建议顺序

1. **P0 跳数熔断**（唯一「不修就有失控风险」的项）
2. **P1 why 命令**（半天到一天，立刻能用在面试与日常排查）
3. **P2 Step 1 + Step 2**（把事件溯源补成真溯源）
4. **P3 基准与崩溃模拟**（收尾，把数字做出来）

每步都附了验收测试；新增测试文件必须同步加进 `package.json` 的 `test` / `test:coverage` 显式列表，否则 CI 不会跑到。

---

## 进度

- 2026-11-21 P0 完成：迁移 13（agent_messages 链路字段）+ mailbox 投递前熔断 + 全部调用点沿父续链（指导/复查/自治检查点），熔断转 `worker_attention`。验收 test/message-chain-budget.test.mjs 3/3；受影响套件 messaging/coordinator 81 用例、autonomy/apix-agent/five-fixes 39 用例全绿。
- 2026-11-21 P1 完成：`scripts/inspect/why.mjs`（`npm run why -- --session|--task|--run [--json]`），只读打开 apix.sqlite 输出带账本序号的单条时间线。验收 test/why-trace.test.mjs 3/3。
- P2 已在分支实现。覆盖六个协调写入口的故障注入，新增 `npm run verify:ledger -- --db <路径> [--strict] [--json]`。隔离协作库的约定字段零差异，历史缺证据和注入差异分别得到 yellow、red。详见 [P2 自审](../../协作/审查/2026-11/2026-11-21-账本事务与投影自审.md)。
- P3 待办：性能基准与强杀模拟。
