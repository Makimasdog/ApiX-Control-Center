# OpenJudge Agent 评测

更新：2026-11-02。状态：beta；离线确定性测试和真实 DeepSeek 小样本可运行，语义评分仅供诊断。原设计见[系统方案](../设计/2026-11-02-OpenJudge-Agent测试与归因系统方案.md)。

2026-11-03 续跑：[真实 Codex/Claude 原生工具验收](真实Codex-Claude协作验收.md)已分段完成，协作 20 项与停止专项 5 项由 OpenJudge 客观评分通过；修复 Codex 原生历史恢复超时。原整批脚本失败保留。最新 20 元曾误按员工额度执行，累计预留 22.462128 元，实际账单未知；已停止付费测试并将原生入口总预留门禁改为 20 元。下文 50 元为 11-02 历史批次配置，不能视作当前授权。

2026-11-04 免费续跑：`eval:agents -- --suite all` 的 8 个离线场景及评测回归通过，付费请求为 0；补齐停止原因日志、完整自动浏览器入口和桌面打包副本验收。Claude Code 经 CC Switch 路由 DeepSeek 为用户确认的预期配置，未重跑付费模型。标准后端清单及协调器文件级超时复验结果见[本轮自审](../../协作/审查/2026-11/2026-11-04-免费完整回归与Claude停止诊断自审.md)。

## 本轮接入范围

Node 继续负责真实 ApiX 执行，Python OpenJudge 读取证据评分，不新增生产数据库、服务端路由或前端页面。评测使用隔离数据目录、独立 Git 工作区和员工进程；结束后停止所属运行与服务，保留产物供追踪。

| 入口 | 行为 |
| --- | --- |
| `npm run eval:agents -- --suite all` | 构建后执行 5 类既有编码任务与 3 类协作场景，再用 OpenJudge 判分；默认不调用真实模型 |
| `npm run eval:agents -- --suite collaboration` | 仅执行协作菱形 DAG、自动改派、停止三项 |
| `npm run test:evaluation` | 构建并验证证据/脱敏、真实 OpenJudge 的状态判定、裁判故障、预算拒绝和完整协议协作链路 |
| `npm run eval:agents -- --suite all --real-provider --max-cny 50 --model deepseek-v4.1-flash-1017` | 显式付费批次：编码仍为 deterministic；菱形协作为真实管理者与 4 个独立 DeepSeek 员工进程；改派与停止仍为协议夹具；抽样运行真实语义裁判 |

真实入口仅读取默认本机 ApiX 管理者的公开供应商配置与对应环境变量凭据，不修改默认模型或生产数据。模型由命令显式指定，当前预算档案仅支持阿里云北京 `https://dashscope.aliyuncs.com/compatible-mode/v1` 的指定快照；不自动切换供应商/模型。其他配置会拒绝，不能绕开预算档案。

## 安装与环境

使用仓库支持的 Node 和 Python 3.11。以下是在项目内建立独立、Git 忽略的虚拟环境，未向 Electron/npm 增加运行依赖：

```powershell
python -m venv .tmp/evaluation/openjudge/venv
.tmp/evaluation/openjudge/venv/Scripts/python.exe -m pip install --index-url https://pypi.org/simple -r scripts/evaluation/openjudge/requirements.lock
npm run test:evaluation
```

也可使用本机 uv 的 `uv venv` 和 `uv pip sync` 安装同一锁文件；不依赖 uv 执行评测。`--python <路径>` 可指定评测解释器；测试使用 `APIX_EVALUATION_PYTHON` 覆盖默认 Windows 虚拟环境路径。缺 Python 环境时失败并提示安装，不将其视为通过。

`requirements.in` 固定 OpenJudge Git 提交 `070f7b8f2a3144f50788a9161c509c24130fb502`，锁文件固定本次解析的 91 项依赖。更新依赖时改输入并重新生成锁文件，再重跑导入/判分/错误路径；不手改生成的 lock，不手改上游源码。

安装显式使用官方 PyPI，避免本机镜像尚未同步某个锁定版本而误报无可安装版本。本轮默认镜像曾缺少 `openai==3.42.1`；不要通过静默放宽锁版本来掩盖此问题。

## 协作场景与真实程度

**collaboration-diamond**：实现员工写 `sum.mjs` → 先冻结验收 → 两名不同员工同时运行、各自读取和完成指导消息，一名产出并执行 `verify.mjs`，另一名产出 `review.md` → 两个分支均冻结验收后集成员工才启动 → 宿主独立测试隐藏输入、核对用户 README 和分支产物 → 最终验收 → 重启验证状态保留。

真实模式中 ApiX 管理者调用指定模型生成计划，然后测试操作者通过既有 plan API 显式固定四个步骤，以保证跨批次任务可比。四个员工经项目原有 custom adapter 入口运行，分别请求指定真实模型生成各自允许的文件；只接受场景允许的文件集合，不执行模型给出的任意命令。工作区创建、并发限制、mailbox 凭据与指导、DAG、Git 交接、冻结和重启均走产品原实现。它不是“纯自主规划质量”的验收，也不是 Codex/Claude 厂商 CLI 的真实工具能力验收。

**collaboration-recovery**：协议员工写入部分产物后带明确断言错误退出；原有自动恢复改派另一员工，保留部分产物，验证恰好两次运行且下游等待验收；冻结后下游继续，最终全部验收。注入失败是预期测试输入，不作为产品缺陷。

**collaboration-stop**：协议员工实际启动并保持运行；停止后校验停止证据和运行终态，下游没有 Run。当前简单 CLI 员工的 `root_exited` 只证明根进程退出，不推广为任意厂商后代进程树的停止保证。

既有 Codex App Server/Claude SDK 的 HTTP、问题/指导、用量、恢复和配置隔离继续由 `test/native-runtime-http.test.mjs` 验证，使用本地协议对端，不能与上述真实 DeepSeek 员工混称真实厂商验收。

## 证据与判分契约

批次输出在 `.tmp/evaluation/batch-*/`：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 基线 Git HEAD、评测源码/锁文件指纹、上游提交、模式、模型、时间 |
| `raw-reports.json` | 脱敏后的编码报告和协作会话、任务/运行、交付、时间线；供逐步回看 |
| `cases.jsonl` | schemaVersion=1；case/attempt/scenario 版本、运行模式、断言与实际值/预期值、事件与源 ID、任务依赖、Run、证据目录及报告摘要 |
| `scores.json` | OpenJudge 客观结果、已知结果分布；真实模式另含抽样语义结果与裁判状态 |
| `findings.json` | 硬性失败、未知证据、评测流水线失败、裁判异常或需复核的语义反证；无问题为 `[]` |
| `budget.json` | 仅真实模式：每次分派、预留、返回的 usage、按公开峰时单价估算；真实账单为 null |
| `index.html` / `batch.json` | 静态结果入口与批次总体状态；不是新产品页面 |

编码轨迹保存原始 assistant_events ID；验证契约保留源事件、实际 Node 和 check 参数，告诉裁判 `run_check(unit)` 对应实际执行什么。协作依赖从会话 `dependencies` 读取，不假定 tasks 有 `depends_on` 字段。旧 CLI 不存在的工具粒度、原生标识和私有思考不补造。

硬性判定由 `FunctionGrader` + `GradingRunner` 执行，`DistributionAnalyzer` 只统计已知 pass/fail；unknown 和 not_run 的外部数值为 null，不补零。未知、失败和裁判错误会使批次非零退出。每项断言在 Python 入口核对状态与实际/预期是否一致，拒绝伪造 passed 字段。

硬性验收和语义评分分开。真实批次抽样评价 `coding-logs` 的工具选择（1–5）和协作/恢复的证据支持性（0/1）；后者只评价公开宿主证据，不假扮原生工具轨迹。两种量表不加权。相同 DeepSeek 参与生成和裁判，未进行人工标注校准，存在偏差，不能代替用户验收。语义低分保留原值，不为获得高分而改任务。

语义单项异常单列 `grader_error`，保留已完成的硬性结果，不把供应商错误算成 Agent 业务失败。当前 DeepSeek 预算网关将 SDK 的 `json_schema` 请求适配为 `json_object` 并提供等价输出 schema，最终仍由 SDK/Pydantic 解析；不是声称供应商原生支持严格 JSON Schema。

## 失败归因

finding 包含 case/attempt、断言、实际/预期、任务/事件引用、分类、置信度和重跑 case。确认的是可观察偏离；没有轨迹证据时 `firstDeviationEventId` 为 null，根因保留待查。人工/本轮自审确认的原因及修复另记入 `协作/` 的追踪表，不让裁判猜测成为 confirmed 源码根因。

定位顺序：评测器与证据完整性 → 环境/供应商 → 调度、通信、执行 → 产物/交付。保留第一次失败和修复后批次，执行代码变化必须实跑原场景；仅补充裁判上下文时可以重评原始留存报告，并明确它不是新的执行。

本轮历史问题与复验见[实施与原因追踪自审](../../协作/审查/2026-11/2026-11-02-OpenJudge协作评测实施与原因追踪自审.md)。

## 费用与数据范围

11-02 历史批次允许仅外发新建隔离项目内容，ApiX 使用 `deepseek-v4.1-flash-1017`，当时总上限为人民币 50 元；11-03 最新要求为 20 元，当前已停止进一步付费调用，预算口径错误见上述续跑记录。真实请求仅含测试目标、隔离文件、公开工具契约和脱敏评价事实，不上传真实业务项目或生产数据库。模型凭据只由宿主网关持有，不写入员工参数或报告；员工仅获得临时回环地址。

依据 [阿里云模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)（2026-11-02 核查），北京该模型峰时输入/输出为每百万 Token 2/8 元。网关预留按双倍 4/16 元、UTF-8 输入字节数加开销和最大输出估算，不按缓存折扣退款；缺失 usage、超时或请求结果未知仍占用预留。单批最多 24 次请求、单请求 120KB 输入和最多 4096 输出 Token、90 秒供应商期限；重试请求同样计数。网关不查真实余额，估算不等于最终账单。

`--max-cny` 是单批限额，重复批次的总预算由操作者累计核对。本轮失败、重评和最终复验均纳入追踪账本；不能每次重跑都把用户总预算重新归零。网关只在本批运行期间监听回环随机路径，结束后关闭。

## CI 与边界

Windows CI 新增独立 agent-evaluation job，安装锁定 Python 环境并运行 `test:evaluation`，失败也上传批次文件。它不读取模型 secret、不启动真实供应商请求。真实批次仍通过显式本机命令运行；远程 CI 是否通过以实际 Actions 结果为准。

11-02 未覆盖的真实 Codex/Claude 工具协作已在 11-03 分段补测，边界以原生验收说明为准。仍未覆盖真实模型失败后的自动修复质量、浏览器/桌面安装包、持续压测、多轮裁判校准、供应商实际账单。小任务通过不推导普遍完成率或生产上线结论。
