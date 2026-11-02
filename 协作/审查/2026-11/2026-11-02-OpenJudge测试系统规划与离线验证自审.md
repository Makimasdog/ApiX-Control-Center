# OpenJudge 测试系统规划与离线验证自审

日期：2026-11-02。审查者：Codex 自审；不是独立审查或人工批准。基线：`58ff1710e8aa2713078b13ad8080561e9b4e38bd`，开始时工作区干净。

## 范围

仅新增[系统方案](../../../docs/设计/2026-11-02-OpenJudge-Agent测试与归因系统方案.md)、[离线探测与精简证据](../../验收数据/2026-11-02-openjudge/README.md)，同步 docs/INDEX.md 和设计导航。未修改产品源码、数据库、CI、npm 依赖、用户配置；未启动子 Agent、真实供应商或员工进程。方案中的 A1–A6 均未实施，未登记为已领取任务。

## 核查与发现

- 阅读现有评测任务/执行入口、预算负路径、主助手事件、原生运行契约、运行/交付路由、CI 和功能索引；优先复用实际执行链，不复制业务逻辑进裁判。
- OpenJudge clone 在系统临时目录，固定提交 `070f7b8f2a3144f50788a9161c509c24130fb502`，未复制上游源码进产品。核查 FunctionGrader、Runner、评分 schema、工具选择/参数和轨迹恢复源码。
- 确认 README 的 `from openjudge.runner import GradingRunner` 在该提交导入失败，改为模块路径后可执行。记录工具评分器将异常折成 0 分的路径，方案要求评审异常单列，避免误报 Agent 失败。
- 默认 PATH Node 22.15.0 不满足仓库要求，本轮只在命令进程内优先使用已有 `C:\Users\1\AppData\Local\Programs\nodejs` 的 22.23.3，未更改系统 PATH。
- Python 缺 loguru，在系统临时 target 补入；完整发行包/依赖未安装。DistributionAnalyzer 因缺 numpy 导入失败，标 UNAVAILABLE，不声称完成统计分析。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| `npm run build` | VERIFIED，退出 0 |
| `npm run check` | VERIFIED，退出 0，含 stale-dist 与 lint |
| `node scripts/evaluation/evaluate-coding-real.mjs --mode deterministic --tasks all` | VERIFIED，退出 0，logic/multi/large/logs/conflict 5/5，56,011ms，模型请求 0 |
| OpenJudge FunctionGrader + GradingRunner 本地源码探测 | VERIFIED，退出 0，两维度各 5 项，共 10 项评分 1；合成失败记录评分 0。只验证报告评分接入，不是新的独立业务判定 |
| `node --test --test-concurrency=1 test/coding-evaluation.test.mjs test/evaluation-budget.test.mjs` | VERIFIED，退出 0，6/6，无跳过；含真实运行链、过拟合负例、预算/授权、超时中止 |

运行证据、完整报告 hash、复现入口和源码见[证据目录](../../验收数据/2026-11-02-openjudge/README.md)。验证失败项和范围限制如上，不能把默认 Node 或模块导入探测失败表述成产品缺陷。

## 最终 diff 自审

检查新增文件及导航、probe 的输入/输出和失败路径：probe 仅读取显式报告、写入显式输出，不读取凭据、不执行被测输出；合成负例单列，不污染 5 项真实运行计数。FunctionGrader 读取已有宿主判定，报告已明确其不能替代冻结快照独立断言。证据来自 deterministic，不包含真实供应商密钥；业务终态、验收权、权限和账本不变。

方案区分计划/已验证、夹具/真实供应商、任务失败/评审器失败、未知/零值；调用关联缺失时不编造；评分不能放行未知停止或写回 accepted。新增 INDEX 行标注“方案，未接入”，与产品能力分开。

提交前检查完整新增内容、Markdown 本地链接、Python 语法及 probe 留存副本复跑，执行 `git diff --check` 与暂存区一致性核验；仅明确文件清单暂存。自审结论：本轮规划与离线可行性范围通过，无产品实现已完成的承诺。

## 未验证

未跑全量 npm test、浏览器、桌面安装包、远程 CI、真实模型/裁判、Claude/Codex 员工能力或性能；未验证完整 OpenJudge Python 依赖组合。真实评分供应商、数据外发范围和费用上限仍未知。下一步推荐 A1–A3，后续真实批次遵守仓库既有批准/预算入口。
