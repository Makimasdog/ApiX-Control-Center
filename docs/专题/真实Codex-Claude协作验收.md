# 真实 Codex / Claude 工具协作验收

日期：2026-11-03。状态：真实 Codex → Claude → Codex 协作、双方原生续聊、问题/指导、冻结交接、隐藏输入与重启恢复均已通过；两个真实长工具命令停止专项通过。OpenJudge 对分段覆盖的 25 项断言评分通过；包含停止脚本路径错误的原完整批次仍保留失败，不称整批一次通过。修复 Codex 历史恢复 15 秒超时。详见[实跑自审与原因追踪](../../协作/审查/2026-11/2026-11-03-真实原生协作实跑与恢复超时修复自审.md)。

此前未运行状态见[免费预检自审](../../协作/审查/2026-11/2026-11-03-真实原生协作预检与验收入口自审.md)，该文为历史阶段记录。

2026-11-04 只读核对：匹配并去重本轮 CC Switch 账本后，Codex 本地估算 USD 0.358444、Claude 通道 USD 0.088305752，另有三个 Run 缺匹配记录；这些均非平台扣费凭据，仍无法确认实际是否超过 20 元。Claude 通道响应 model 记录为 deepseek-v4-pro / deepseek-flash，故通过的是 Claude CLI/SDK 工具链，未证明 Anthropic Claude 模型本身。未发起新模型调用，见[扣费核对及问题汇总](../../协作/审查/2026-11/2026-11-04-本轮扣费只读核对与测试问题汇总.md)。

## 入口与费用前提

```powershell
npm run test:native:inspect
```

上述命令只发现真实可执行文件、读取公开配置和版本、累计既有费用预留；不启动推理回合、不修改用户默认 CLI/项目设置。

完整入口为 `npm run test:real`，转交 `scripts/evaluation/evaluate-native-collaboration.mjs`。仅当操作者已核实员工通道不产生增量费用、并已有真实测试授权且累计预算充足时，使用：

```powershell
npm run test:real -- --approve-cost --workers-included
```

`--workers-included` 不能仅因进程在本机或 CLI 已登录就填写。新增 `--workers-max-cny 金额` 接受操作者声明的员工总额度，跨重试只预留一次；它不是供应商计量或硬限额。`--stop-only` 仅补测两端长工具停止，结果使用单独 caseId，不能替代完整协作。

ApiX 管理者固定 `deepseek-v4.1-flash-1017`，使用既有网关的输入/输出/请求数上限，最多 6 次请求。累计前轮 1.972464 元及 `.tmp/evaluation/native-*/budget.json`，不重置重试费用。最终入口总预留上限已改为用户最新要求的 **20 元**，当前账本会在启动网关及推理前拒绝后续付费调用。

执行时曾错误地将最新 20 元理解为员工额度，继续采用原 50 元总额。五次实跑累计预留 22.462128 元（员工声明预留 20 元，管理者本次预留 0.489664 元，前轮 1.972464 元），超过最新总预留上限。管理者本次 usage 估算 0.033790 元；员工实际账单未知，不能声称实际扣费低于 20 元，也不能将未知计为零。已停止进一步付费调用；错误及原账本保留在[预算记录](../../协作/验收数据/2026-11-03-native-real/budget-history.json)。

## 已覆盖场景

由真实产品 API 在隔离数据目录注册两个临时员工：Codex App Server 与 Claude Agent SDK，不注册测试替代员工。Codex 沿用自身认证/默认模型；Claude 从本机设置读取明确供应商到临时数据目录，通过既有供应商 API 绑定，不复制订阅认证文件、不修改用户默认配置。

1. Codex 读取 README、搜索 BUG、编辑加法函数、执行 Node 验证；在实际工具运行时接收 steer，结果文件须包含随机标识。
2. 在验收前拒收一次交付，通过原生恢复入口创建新 Run 延续原历史；复验后冻结，Claude 才能启动。
3. Claude 调用 Read、Glob/Grep、Edit、Write、Bash；提出原生问题并接收宿主答案，在该回合期间接受 queue 指导，后续结果须体现随机标识。
4. Claude 同样通过新 Run 验证原生续聊；冻结其脚本/报告后，Codex 集成员工读取前置产物并实跑验证。
5. 宿主执行额外输入断言、核对用户文件、检查所有任务 accepted，重启服务验证状态保留。
6. 两个运行时各执行一次真正的长工具命令，出现开始标识后停止；要求 quiescent 及无延迟文件写入。未知停止不得记成功。

上述场景已分段实际执行。真实协作覆盖 20 项断言；停止专项覆盖两端 quiescent、无后续写入及无假模型请求共 5 项。没有再付费重跑整批，因此原整批失败不会被覆盖。客观评分使用真实 py-openjudge 0.2.0；本轮未调用付费语义裁判，不将有限场景通过推广为全项目无缺陷。

## 证据与归因

结果写 `.tmp/evaluation/native-*/`：result、公开运行事件、会话/交付检查、累计预算、findings、OpenJudge cases.jsonl/scores.json。失败时尝试停止所属 Run 并等待关闭，保存已失败 Run 的公开事件；不记录私有思考、原生会话标识或凭据。单次操作完成不等于交付已验收，指导 accepted/queued 不等于 processed，必须同时检查状态和最终文件。

免费预检发现旧兼容性脚本采用目录优先的可执行文件查找，选中 npm Codex 0.145，而产品采用后缀优先、实际选中原生 Codex 0.166。现已复用 `executableOnPath`，避免探针与真实产品验证不同版本。

第一次 Claude 无推理握手探测的停止证据为 unknown；第二次为 quiescent。原报告均保留，首次原因仍未确认；本次真实长命令两端停止为 quiescent，未放宽生产停止判定，也不据单次停止宣称长期稳定性。

官方协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude CLI](https://code.claude.com/docs/en/cli-reference)；具体兼容性同时以本机生成的协议 schema 和真实握手为准。
