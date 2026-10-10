# Phase 3：多 Agent 协作实现

本阶段在 Phase 2 的本地控制平面上增加可持久化的团队协作流程。入口是 Web 工作台的 **Director** 页面，数据仍保存在 `APIX_DATA_DIR/apix.sqlite`。

## 操作流程

1. 在“任务与员工”注册至少两名可用员工。部门经理也是一名员工，需先注册。
2. 在 Director 的“团队与仓库”登记部门及经理。项目如涉及其他 Git 仓库，登记其**仓库根目录**。项目本身仍是默认主仓库。
3. 选择一个版本化 Workflow Pack，为每个步骤指定员工、可选部门和仓库。步骤中的 `dependsOn` 使用从零开始的前序步骤索引；无依赖的步骤可并行运行。
4. 生成计划后逐项审批启动。Phase 3 的后续步骤要等所有前置任务**通过人工验收**才启动。前置任务失败、被拒绝或验收未通过时，依赖任务会阻塞。
5. 可为一个来源任务召开评审会议，指派至少两位员工独立评审；也可创建部门经理审查任务。评审任务同样需审批启动和人工验收，结果作为共享交付物保存。
6. 所有相关任务验收后，对每个仓库分别生成集成预检。ApiX 在独立的集成 worktree 应用各任务差异并列出变更文件与冲突。状态为 `ready` 时可在界面明确批准，将结果写入源仓库工作区。

## Pack 定义

Pack 以 `id` 和递增 `version` 唯一标识，已发布版本不可覆盖。内置 `development` v1 包含分析、并行实现与测试、联合审查四步。自定义步骤示例：

```json
[
  { "prompt": "实现功能：{goal}", "dependsOn": [] },
  { "prompt": "并行编写测试：{goal}", "dependsOn": [] },
  { "prompt": "审查代码与测试结果：{goal}", "dependsOn": [0, 1] }
]
```

`{goal}` 会替换为本次计划目标。生成计划时，用户为每步选择具体员工、部门和仓库；计划记录所用 Pack 版本。任务运行在独立 Git worktree，直接读取的前置任务共享交付物会附加到指令中，并标记为需要再次验证的上下文。

## 数据与接口

SQLite v5 增加 `departments`、`project_repositories`、`workflow_packs`、`meetings`、`meeting_items`、`shared_artifacts`、`integration_reviews`，以及任务的仓库、部门、类型和计划的 Pack 版本、模式字段。旧数据库启动时自动迁移。`/api/snapshot` 返回这些记录供界面展示，任务事件和 Run 历史仍通过现有接口读取。

| 接口 | 作用 |
| --- | --- |
| `POST /api/departments`、`POST /api/repositories` | 注册经理部门及项目关联仓库 |
| `POST /api/packs`、`GET /api/packs/:id` | 发布新版本、读取最新版本 |
| `POST /api/collaboration/plans` | 创建带并行依赖和人员分工的计划 |
| `POST /api/meetings`、`POST /api/manager-reviews` | 创建独立评审任务 |
| `POST /api/integrations` | 在独立 worktree 生成集成预检 |
| `POST /api/integrations/:id/apply` | 在源仓库 HEAD 未变化且工作区干净时应用已预检差异 |

## 集成边界

- 只集成 Git 跟踪文件的差异；任务工作区出现未跟踪文件时，预检会记录冲突，不会静默丢弃。
- 各任务必须基于相同提交；源仓库 HEAD 如有变化，需人工处理。不同仓库分别预检、批准。
- 集成预检发生在独立 worktree，不修改源仓库。最终批准仅写入源仓库工作区，**不会自动提交、推送或合并分支**。
- 相同文件若可依序应用补丁则会进入预检结果；补丁无法应用时记录冲突，阻止批准。复杂语义冲突仍需人工审查。
- 任务运行中的权限边界与 Phase 1/2 一致：ApiX 托管进程可观察和请求停止，但本机 Agent 并非系统级沙箱。服务重启后不自动接管旧进程。

## 验证

`npm run test --prefix web` 使用假 Pi/Codex 运行时验证：并行步骤、验收门槛、经理与双人评审、共享成果、集成批准、文件冲突、多仓库和重启后的历史。仓库根目录的 `npm run check` 覆盖格式、静态检查、类型检查和浏览器 smoke 检查。
