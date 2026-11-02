# OpenJudge 协作评测实施与原因追踪自审

日期：2026-11-02。执行与审查：Codex 单 Agent、自审；不是独立审查或人工批准。基线 HEAD：`e9554327c3558d3b4f9cffea5ee469c0219ff793`，开始工作区干净，未切换分支。

## 授权与范围

用户要求按前轮方案实施，多 Agent 协作纳入本轮，跑通协作链路并追踪原因；随后明确允许真实调用、仅发送隔离项目内容，费用数值 50、ApiX 模型 `deepseek-v4.1-flash-1017`。已在对话告知费用按人民币 50 元处理。本轮不启动 Codex 子 Agent；被测员工由 ApiX 产品原调度链启动，不将测试员工等同于开发代理分工。

新增评测入口、证据归一化、OpenJudge 独立锁定环境、客观与语义判分、失败分类、预算网关、协议/真实模型员工夹具及 CI job；既有编码报告补充工具定义与任务目标。同步[功能索引](../../../docs/INDEX.md)、[运行契约](../../../docs/专题/OpenJudge-Agent评测.md)、原方案续记、设计与脚本导航。未修改生产调度/数据库/权限/验收行为，未更新 npm 依赖；新增 Python 仅用于离线评测。

## 完整链路及实际结果

最终批次 `.tmp/evaluation/batch-4lhoqA`：8/8 场景通过，44 条硬性断言通过。logic/multi/large/logs/conflict 5 类编码仍为 deterministic；菱形协作为真实 DeepSeek 管理者 + 4 个独立有界模型员工；恢复与停止为真实进程和产品服务上的协议夹具。

菱形链：ApiX 确认需求/真实模型规划 → 操作者通过 plan API 固定版本化测试任务 → 实现员工 → 冻结验收 → 测试与文档两个员工同时运行 → 指导消息领取/ack/complete → 两分支依次验收（只验一支不能启动集成）→ 集成员工接收两支代码 → 宿主额外输入验证与用户 README 字节核对 → 最终全部验收 → 服务重启后状态仍完成。

恢复链验证原实现保留部分产物、自动改派、失败/恢复恰好两个 Run、下游等待验收后才推进。停止链验证持有进程实际启动、停止证据已知、运行不是完成、下游从未创建 Run。协议注入的故意断言失败不记作产品缺陷。

OpenJudge 的 FunctionGrader、GradingRunner、DistributionAnalyzer 均在完整独立 Python 环境实跑。最终真实裁判：coding-logs 工具选择 5/5，协作与恢复证据支持性各 1/1。前一次重评 4/5 原值保留，评分波动及自我评审偏差不能隐藏；全部语义结果仍标未校准、仅诊断。该结果不证明生产完成率或真实 Codex/Claude 工具能力。

## 发现、原因与修复

追踪明细见 [findings-history.json](../../验收数据/2026-11-02-openjudge-implementation/findings-history.json)。

| 编号 | 实际偏离与原因 | 处理及复验 |
| --- | --- | --- |
| OJ-001 | LF 字节断言失败；临时 Git 仓库继承 Windows autocrlf，检出为 CRLF | 固定临时仓库换行配置后，协议/真实完整链路通过；保留首次失败 |
| OJ-002 | 正确的 api 管理者模式被旧 pi 预期拒绝 | 修正当前模式断言；两轮真实完整链通过 |
| OJ-003 | 裁判 API HTTP 400；SDK 默认 json_schema 与模型不兼容 | 网关转换为 JSON 模式并提供输出 schema，SDK 继续校验；真实结构化评分 HTTP 200 |
| OJ-004 | 裁判抛异常时硬性 scores 未落盘 | 逐项异常转 grader_error，保留硬性结果；真实连接失败回归通过 |
| OJ-005 | 自审发现导出时缺 DAG 边；读取了不存在的 task.depends_on | 按 session.dependencies 映射；新增真实结构回归和最终证据核对通过 |
| OJ-006 | 裁判理由误判 run_check 不等同实际执行；输入缺宿主契约 | 补入真实契约源事件/Node/参数，重评理由纠正且保留原分；人工校准仍未完成 |
| OJ-007 | 收尾自审发现 not_run 的底层 false/unknown 断言可能被错误列为缺陷 | finding 生成跳过未执行项；定向回归 2/2 通过，已执行的 8 个场景与结果不受影响 |
| OJ-008 | 标准 venv/pip 默认镜像缺锁定的 openai 3.42.1 | 文档与 CI 显式使用官方 PyPI，不放宽依赖版本；安装复验见 installation-check.json |

以上是评测/夹具/接入问题，未确认新的产品业务缺陷。自动 finding 确认“实际偏离”，不会凭分数直接把源码根因标 confirmed；本表根因由实际错误、源码与复验确认。最终硬性 finding 为 `[]`，不表示 OJ-006 的评分局限消失。

## 验证

本机 Node 22.23.3、Python 3.11.9；OpenJudge 固定提交 `070f7b8f2a3144f50788a9161c509c24130fb502`，锁定并安装 91 项依赖，未依赖全局 Python 包。未改系统 PATH，仅在验证进程内优先使用支持的 Node。

| 命令/范围 | 结果 |
| --- | --- |
| `npm run build`、`npm run check` | 通过，含 TypeScript、stale-dist、lint |
| 全新标准 `python -m venv` + 官方 PyPI `pip install -r` + `pip check` | 91 项锁定依赖安装完成，无依赖冲突；用该独立环境对留存证据重评 8/8 通过，无新增模型调用 |
| `npm run test:evaluation`（完整链路运行版本） | 6/6，无跳过；硬性失败/未知/未运行、脱敏、真实 OpenJudge、裁判连接失败、预算拒绝、3 个完整协议协作场景 |
| 收尾 OJ-007 的 hard evidence / exports redact 定向回归 | 2/2；只修正未执行项的 finding 生成，无需重复产生模型费用；执行版本与收尾版本指纹见 post-review.json |
| `node --test --test-concurrency=1 test/coding-evaluation.test.mjs test/evaluation-budget.test.mjs test/workflow-recovery-http.test.mjs test/native-runtime-http.test.mjs` | 10/10，无跳过；冻结判定、预算/授权/期限、Codex App Server/Claude SDK 协议与恢复 |
| coordinator 定向：autonomous contract / custom worker mailbox / acceptance dependency / credential isolation / paused concurrency | 5/5；真实宿主检查、修复、信箱隔离、依赖与并发 |
| `node scripts/evaluation/evaluate-agents.mjs --suite all --real-provider --max-cny 48 --model deepseek-v4.1-flash-1017 --python .tmp/evaluation/openjudge/venv/Scripts/python.exe` | 最终 8/8；语义抽样 3 项 scored；执行时源码/锁文件 8 份 hash 留存，收尾不改执行链或该批已执行项判定 |

最终复验使用 48 元单批上限，给先前失败与重评保留预算；所有批次累计 20 次真实分派，保守预留 1.972464 元，已返回用量按公开峰时单价估算 0.120898 元；1 次供应商 400 用量未知未补零，真实账单仍 null。见[完整累计账本](../../验收数据/2026-11-02-openjudge-implementation/budget-history.json)。不能把这组估算称真实扣费或平台余额。

## 最终 diff 自审

检查范围含所有新增文件、现有编码报告调用者、参数/缺环境/超时/供应商/裁判错误路径、预算并发预留、任务依赖/Run/指导引用、数据脱敏与访问边界。脚本仅新建临时评测数据，不写生产数据库；真实模型只接收隔离文件、公开工具契约和脱敏证据。API Key 只在宿主网关持有，不写员工参数或产物。未记录私有思考/原生会话 ID，缺证据保留 unknown，评审异常不落业务失败。

新 Python 锁文件由输入重新生成，未手改自动生成物。CI 为独立离线 job，未添加真实调用 secret 或自动付费触发；静态报告转义动态内容。采集、评分和运行分模块，未复制产品调度/恢复逻辑进测试。真实员工文件输出在入口校验允许路径/内容，执行验证走已有产品工作区，未新增 OS 沙箱保证。

提交前核对新文档链接、JSON/Python/YAML 语法、最终源码指纹、证据/累计预算、输出是否含环境凭据、`git diff --check` 及明确清单暂存一致性。自审结论：本轮实现与上述测试范围通过，可提交；无需改动生产业务代码来消除夹具/裁判问题。

## 未验证与限制

未跑全量 npm test、真实 Codex/Claude 全工具协作、真实模型注入失败后的自主修复质量、浏览器、桌面安装包、远程 CI、长期并发/性能与真实账单。计划里人工标注裁判校准、全 UI/桌面矩阵仍未完成；A1–A3 已落地，A4 仅有界真实评分与错误分类，A5 覆盖本轮协作核心与现有原生协议回归，A6 为离线 CI 配置，不能宣称原方案全部矩阵均已验收。
