# CI 长短路径与取消清理 watchdog 修复（Codex 自审）

日期：2026-10-29。用户明确要求继续修复 PR #8 的 CI、验证自审后提交推送并重新检查，不合并 main。本轮由 Codex 完成并自审，没有额外 Agent，不是独立审查或人工批准。基线为 `8a93978`，起始工作区干净。

## 失败与复现

原 [CI 40815570904](https://github.com/Makimasdog/ApiX-Control-Center/actions/runs/40815570904)：Node 22 为 542/544，Node 24 与 coverage 各为 543/544。共同失败是 Windows cwd 的 RUNNER~1 / runneradmin 路径字符串差异；Node 22 另有 running cleanup unknown 的 watchdog 断言失败。

1. 使用 Windows `GetShortPathNameW` 获取真实临时目录的 8.3 别名，仅给测试子进程设置 TEMP/TMP。原命令 UTF-8 用例稳定失败：参数和环境值一致，cwd 是同目录的长短路径表示差异；修复后相同复现方式通过。
2. 在真实 HTTP / inferModel 夹具中新增回归：等待真实缺少 close 确认产生 `MODEL_CLEANUP_UNKNOWN`，然后增加 3.2 秒后置工作。旧实现稳定在约 4.3 秒误触发 watchdog；此时推理清理已结算，证明夹具的计时覆盖了无关后置工作。修复后同一回归通过，没有靠加长 4 秒阈值解决。

## 修改与审查

- `test/command-lifecycle.test.mjs`：按仓库已有做法，用 `realpathSync.native` 规范化实际和预期 cwd，再对完整输出对象深比较。参数、环境变量、UTF-8 BOM、退出码、完成和进程结束断言保留；错误目录、缺失字段或额外字段仍会失败。
- `test/assistant-inference.test.mjs`：4 秒 watchdog 移入单次真实 inferModel 调用，在 finally 清除；它仍能强制结束未结算的传输并令用例失败。数据库重启、权限核验等后置工作由原有 7 秒用例总超时约束。新增后置工作回归，不复制业务实现。自审同时补齐首段响应前出错时向 observed 信号转发拒绝，避免清除 watchdog 后等待首段悬挂；既有两条真实协议错误用例增加 observed 拒绝断言。
- 未修改生产代码或放宽 1 秒传输清理期限；安全错误、账本、重启阻断、并发与访问边界逻辑保持原样。故障注入仍只屏蔽 socket close 确认，不代替真实 socket 销毁。
- 同步开发约定、docs/INDEX.md 对应验收记录及近期导航。审查全部差异和新增用例，未添加依赖或改变 CI 工作流。

## 验证与限制

- Node 24.22.1：`npm run build`、`npm run check` 通过。
- `command-lifecycle`、`model-lifecycle`、`assistant-inference` 三份真实实现相关测试共 40 项通过，0 失败、0 跳过；包含 running/stopped/revoked、安全错误保全、停止确认、未知清理阻断和进程终止。
- 最终推理夹具自审补充的首段错误转发断言，经整份 assistant-inference 11 项复测通过，最终静态检查再次通过。
- 真实 8.3 TEMP/TMP 下的 Windows UTF-8 用例：修复前失败、修复后通过。新增 watchdog 回归：旧夹具失败、修复后通过。
- 本地未运行全量或 coverage，也未用本机 Node 22.19 复测；提交推送后由 PR #8 的 Windows Node 22/24 和 coverage 作业验证。远程结果单独更新 PR 正文，不提前记为通过。
- 不运行付费模型或真实员工，不停止用户应用、不修改运行数据，不合并 main。

本轮自审结论：测试边界修复范围通过。提交前核对明确文件清单、最终暂存 diff 和 Git 对象指纹，确认与已审内容一致后提交并同步当前分支。
