# 本轮可用性、多 Agent 与上下文自审

日期：2026-10-16（Asia/Shanghai）
分支：`codex/apix-availability-review`
审查性质：Codex 自审，不是独立审查或人工批准。

## 审查范围

- Agent 可用性与无感操作：运行时启动、审批、停止、恢复、项目隔离、Windows 路径。
- 多 Agent 交互：mailbox 身份、幂等、重试、交付引用、员工进程环境。
- 记忆与上下文：协调历史、项目/任务记忆、模型提示上下文预算。
- ApiX 工具系统：项目权限、工具活动审计、非 Git 基线、交付冻结与集成。

## 发现与处理

1. `src/apix-agent.ts` 原先把历史、进度、架构和审查证据直接拼入模型提示，长对话可能耗尽供应商上下文，并且简单截断会优先保留旧内容。新增 `promptJson` 上限，保留开头摘要和结尾最新内容，并记录截断标记。
2. `control-plane.mjs` 启动员工时继承整个服务环境，可能把 ApiX 模型入口、数据目录或管理者密钥暴露给员工。新增员工环境过滤，只注入项目、运行和 mailbox 所需变量，并移除已配置管理者 Key 环境变量。
3. `src/mailbox.mjs` 的交互、幂等和项目边界已有完整校验；交付冻结引用使用任务/运行 UUID 组成的深层 Git ref，在 Windows 嵌套目录下可能无法创建 lock 文件。`src/code-handoffs.mjs` 改为稳定短摘要 ref。
4. `src/project-baseline.mjs` 对已有 Git 项目返回 `realpath`，Windows 8.3 短路径与用户输入路径可能不一致，导致调用方比较失败。现在同一仓库根目录返回用户传入的规范路径形式。
5. `control-plane.mjs` 记忆更新原先只在创建时检查同范围同名，编辑可以制造重复标题。现在更新也执行同范围唯一性检查。
6. ApiX 工具已有项目权限、审批、工具活动、邮箱、非 Git 隔离快照、交付冻结和集成前置校验；本轮没有扩大权限边界，只修复可用性和上下文/凭据泄露风险。

## 验证

- `npm run build`：通过。
- `npm test`：159 通过，0 失败。
- `git diff --check`：通过。
- 新增回归：上下文截断保留最新历史；记忆改名冲突返回 400；非 Git 交付在 Windows 长路径场景通过；已有 Git 路径比较稳定。

## 未验证项

- 未连接真实 Pi/Codex/Claude/Gemini/OpenCode/Kimi 账户进行外部服务调用；测试使用仓库内 fake runtime/provider。
- 未在 Linux/macOS 实机执行；Windows 路径场景已由当前环境和测试覆盖。
- 未推送、合并或创建远程 PR。
