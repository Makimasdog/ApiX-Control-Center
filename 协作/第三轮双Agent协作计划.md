# 第三轮双 Agent 协作计划

日期：2026-10-12。用户已确认恢复 Codex + Claude Code CLI 协作；不另开 Codex 子 Agent。

最新范围更新：用户要求能力匹配、规划会议和额度/费用调度，并选择“均衡”模式。当前执行顺序以 [ApiX 能力、会议与预算调度方案](./ApiX能力会议预算调度方案.md) 的 S1 → S2 → S3 为准；下文 C7/L7 改派作为 S3 子任务保留，暂不单独优先开发。Claude 尚未确认领取，若已在其他终端领取旧任务，应先在交接记录说明现状，再按新优先级推进，不覆盖其工作。

基线：`codex/agent-provider-adapters`，`bdf7dad`。P0–P2 已完成，66/66 回归与隔离页面验收通过；这些是基线证据，不冒用为本轮验证。

## 本轮目标

补齐排队任务的重新分配：运行时额度暂停后，目前失败任务可换员工，尚未启动的 queued 任务仍需等待原运行时恢复。让用户检查当前任务/工作区后，把满足依赖验收的排队任务交给另一位可用员工，保持当前需求、权限、并发和审查门槛。

此次只恢复协作、确定分工与接口，不把计划记为功能已实现。真实模型、全局账户余额管理、OS 沙箱和大历史分页不纳入本轮。

## 并行任务与归属

| ID | 执行者 | 工作与验收 | 状态 |
| --- | --- | --- | --- |
| C7 | Codex | 后端允许当前计划内 queued 任务在检查后换员工；拒绝未验收依赖、失效计划/权限、过期指纹、不可用员工；暂停原运行时继续生效，新员工仍受并发限制 | PLANNED，并入 S3 |
| L7 | Claude | queued 任务的检查/换员工入口；展示未建工作区和等待依赖的原因；提交期间禁用重复操作；切换目标/项目后不得提交或清除另一视图的数据 | PLANNED，并入 S3 |
| L8 | Claude | 审查 C7 后端 diff 与测试：授权、旧消息隔离、无重复 Run、源仓库不被修改；记录具体结论与被审查指纹 | WAITING C7 READY |
| C8 | Codex | 审查 L7 的实际实现与测试；集中构建、完整回归及隔离浏览器验收，修复交接问题后核对暂存、提交 | WAITING L7 READY |

| 归属 | 可修改文件 |
| --- | --- |
| Codex | `src/coordinator.ts`、`control-plane.mjs`、`src/task-scheduler.mjs`、`src/execution-control.mjs`、`test/coordinator.test.mjs`、`test/execution-control.test.mjs`；确需变更 `server.mjs` 或 `package.json` 时由 Codex 维护；README、产品文档、共享计划和 Codex 工作记录 |
| Claude | `web/coordinator.ts`、确有必要的 `web/execution-view.ts`、`coordinator.css`；新增 `test/execution-ui.test.mjs`；`协作/第三轮Claude交接.md`、Claude 工作记录 |
| 保留 | `.gitignore`、`.claude/skills/`、已有未跟踪说明/测试页面、其他模块；不清理、不覆盖、不混入提交 |

共享工作区不切分支、不 reset/clean/stash。任何归属外修改先写交接并由 Codex 协调。双方只修改自己的文件；共享 `dist/` 构建与完整测试由 Codex 集中执行。Claude 可检查源码和编写直接调用实际模块的测试，不复制一套实现当作验证。

## 已约定的接口

沿用 `GET /api/tasks/:id/delivery` 和 `POST /api/tasks/:id/recovery`，不另建同功能 API。

GET 保持当前字段：`taskId/status/workspacePath/inputCommit/deliveryCommit/inspection/error/latestRun/processMayExist/managedActive/recoveryFingerprint/sourceHead/handoff`。C7 将补齐 queued 已建工作区的检查；未建工作区返回空 workspacePath，以 sourceHead 表示检查的源基线。

POST 保持 `{revision,runId,fingerprint,reviewed,confirmedStopped?,employeeId?}`。runId 在没有历史 Run 时为 null；fingerprint 使用最新 recoveryFingerprint；reviewed 必须为 true。unknown 的原进程确认继续保留，不把 queued 当作 unknown。响应保持 `{session,failure}`。

queued 的重新分配必须由用户显式批准，前置任务全部 accepted、当前需求与计划仍有效、原任务未运行才允许。重新绑定员工授权、撤销旧启动审批，不复用旧运行凭据/指导；检查后代码或源 HEAD 变化拒绝启动。指定员工若不可用或只读则返回错误。原运行时暂停不因换员工解除；新运行时也暂停或并发已满时继续排队，不宣称启动成功。

L7 可立即按照此契约实现 UI 与实际模块测试；后端未 READY 时不得把接口拒绝当作 UI 通过，也不得在前端假造成功。若需调整接口，Codex 先更新本节，再通知 Claude。

## 交接与提交

领取时写 RUNNING、任务 ID、基线和文件清单；交付时写 READY、最终 diff、实际测试命令/结果、未验证项、需对方审查的点。不擅自修改他人的文件。

双方独立审查对方最终 diff；审查未实际发生不能标“互审通过”。修复后重新审查新指纹。集成 DONE 要求：静态检查、适当回归、隔离浏览器流程通过；提交前暂存区与已审查内容一致。Codex 统一使用明确清单提交，不推送或合并。若 Claude 额度仍不可用，记录 BLOCKED 并由用户决定是否恢复单 Agent；不暗中用子 Agent 冒充 Claude。

本轮需覆盖：额度暂停任务换员工；缺失依赖拒绝；旧指纹拒绝；并发满时保持 queued；连续点击不生成重复 Run；目标切换保护；历史部分成果保留；全部任务验收后目标完成。

## 历史 L7 领取指令（暂缓）

此处旧 L7 指令暂缓执行。应先阅读本文件顶部的新范围与能力会议预算方案；S1 前端等待 Codex 交付接口 schema，可先整理相应界面与验收清单，不猜造接口或声称余额已接入。

```text
请领取 E:/Projects/wyy/ApiX-Control-Center/协作/第三轮双Agent协作计划.md 中的 L7，先阅读 AGENTS.md、协作/当前工作模式.md 和该计划。当前基线 bdf7dad，P0–P2 已完成，不重复历史任务。你只修改计划列出的 Claude 文件，后端、package.json、共享计划和 Git 提交由 Codex 负责。
先新建协作/第三轮Claude交接.md，写 L7 RUNNING、基线和文件清单；按约定 recovery/delivery 接口完成 queued 任务检查与换员工 UI、重复提交和目标切换保护，编写调用实际模块的必要测试。不要并行编译 dist，不启动真实员工或模型，不修改用户已有文件，不提交或推送。完成后写 L7 READY，列出改动、验证结果、未验证项和需要 Codex 审查的地方。随后等 C7 READY，执行 L8 后端审查。若额度不足，写 BLOCKED；不要把未执行的工作记为通过。
```

领取情况：本聊天没有连接右侧终端，也未发现运行中的 Claude CLI；尚未发送或确认领取。上述指令供用户粘贴到 Claude CLI，不等于 Claude 已启动。

## 本次协作配置提交前审查

审查类型：Codex 自审。范围：AGENTS.md、当前工作模式、任务书导航、协作 README、第三轮计划、共享进度、Codex 工作记录，共 7 个文档。核对用户恢复协作的授权、基线提交、后端现有状态限制、前后端接口、文件归属、领取/交付状态、历史保留与提交规则；文档链接检查及 git diff --check 通过。未修改产品代码，未新增运行结果，不为文档变更重复完整产品测试。Claude 尚未领取，此次不能称双方互审或已并行运行。

自审通过，仅允许上述明确文档清单本地提交；提交前核对工作区与暂存 blob 一致，不纳入用户原有修改，不推送。C7/L7 开发提交仍必须另行完成代码审查和验证。
