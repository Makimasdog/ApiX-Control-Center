# OpenJudge 协作评测实施证据

日期：2026-11-02。对应[实施自审](../../审查/2026-11/2026-11-02-OpenJudge协作评测实施与原因追踪自审.md)。

| 文件 | 含义 |
| --- | --- |
| `manifest.json` | 最终批次开始时的 HEAD、8 份执行/采集/锁定文件指纹；包含本轮未提交源码的指纹，不把基线 HEAD 误称为已含本轮实现 |
| `batch.json`、`scores.json`、`findings.json` | 最终实跑批次的结果副本，8/8 硬性场景通过，3 项真实语义评分成功；本批无未解决硬性 finding |
| `case-summary.json` | 精简场景断言、源引用、任务依赖和 Run 事实；不含完整事件/日志/代码快照，不声称独立重建全部历史 |
| `budget-history.json` | 所有真实批次（含首次失败、诊断重评和最终复验）的费用预留与用量记录；总授权 CNY 50，20 次请求，预留 1.972464 元，已知用量估算 0.120898 元，1 次错误请求用量未知，真实账单 null |
| `first-failure.json` | 最初 CRLF 误报的实际/预期与先前通过的检查，未覆盖成成功记录 |
| `semantic-recheck.json` | 仅对留存证据补入执行契约后的工具选择重评，不代表重跑了任务；保留 4 分及其理由 |
| `findings-history.json` | 已确认的测试/集成问题、修复位置、复验、剩余限制；不冒充自动定位源码根因 |
| `post-review.json` | OJ-007 收尾修正前后指纹与定向验证；保留原批次 manifest，不伪造旧运行使用了新源码 |
| `installation-check.json` | 全新标准 venv + 官方 PyPI pip 安装成功、依赖检查通过；同一留存证据 8/8 重评通过，无新增模型请求 |

最终完整原始证据目录：`.tmp/evaluation/batch-4lhoqA/`。其他真实批次为 `batch-Na4Mi3`（首次失败）与 `batch-1H9MRJ`（首次完整通过）；重评为 `.tmp/evaluation/semantic-recheck/`。当前离线完整协议回归为 `.tmp/evaluation/batch-h7tCik/`。这些目录不提交 Git，可能在后续清理；重跑方法见[评测契约](../../../docs/专题/OpenJudge-Agent评测.md)。

最终 5 类编码任务与恢复/停止使用确定性或协议员工；菱形 DAG 使用真实 DeepSeek 管理者和 4 个独立、有界的 DeepSeek 模型员工进程。测试通过既有 API 脚本验收，不能称人工批准。真实 Codex/Claude CLI 全工具能力、浏览器、安装包和远程 CI 不在这些证据内。
