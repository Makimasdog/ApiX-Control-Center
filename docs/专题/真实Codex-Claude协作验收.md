# 真实 Codex / Claude 工具协作验收

日期：2026-11-03。状态：原生验收入口已开发，免费预检与协议回归通过；完整真实模型工具链 **未运行**，等待员工通道增量费用信息。不能用前轮的有界 DeepSeek 测试员工替代本轮真实 CLI 验收。

当前结果见[本轮自审](../../协作/审查/2026-11/2026-11-03-真实原生协作预检与验收入口自审.md)。

## 入口与费用前提

```powershell
npm run test:native:inspect
```

上述命令只发现真实可执行文件、读取公开配置和版本、累计既有费用预留；不启动推理回合、不修改用户默认 CLI/项目设置。

完整入口仍为 `npm run test:real`，现在转交 `scripts/evaluation/evaluate-native-collaboration.mjs`，替换旧的硬编码模型/过期断言脚本。仅当操作者已核实员工通道不产生增量费用、并已有真实测试授权时，使用：

```powershell
npm run test:real -- --approve-cost --workers-included
```

`--workers-included` 声明的事实必须来自实际计费信息，不能仅因进程在本机或 CLI 已登录就填写。按量收费的员工通道当前不支持此声明，需要先提供实际价目或硬限额并适配；本轮还没有获得这一事实，因此没有运行上述命令。既有授权无需再次申请；缺少的是能把员工调用计入人民币上限的计费依据。

ApiX 管理者固定 `deepseek-v4.1-flash-1017`，使用既有网关的输入/输出/请求数上限。预算从前轮已留存的 `budget-history.json` 开始，累计 `.tmp/evaluation/native-*/budget.json` 的历次预留；本轮总额仍为 CNY 50，已知前轮预留 1.972464 元不重置。入口按剩余额度创建管理者批次，最多 6 次分派。未知实际账单不补零；同一套累计目录只顺序运行，未实现跨进程并发预算协调。

## 待执行场景

由真实产品 API 在隔离数据目录注册两个临时员工：Codex App Server 与 Claude Agent SDK，不注册测试替代员工。Codex 沿用自身认证/默认模型；Claude 从本机设置读取明确供应商到临时数据目录，通过既有供应商 API 绑定，不复制订阅认证文件、不修改用户默认配置。

1. Codex 读取 README、搜索 BUG、编辑加法函数、执行 Node 验证；在实际工具运行时接收 steer，结果文件须包含随机标识。
2. 在验收前拒收一次交付，通过原生恢复入口创建新 Run 延续原历史；复验后冻结，Claude 才能启动。
3. Claude 调用 Read、Glob/Grep、Edit、Write、Bash；提出原生问题并接收宿主答案，在该回合期间接受 queue 指导，后续结果须体现随机标识。
4. Claude 同样通过新 Run 验证原生续聊；冻结其脚本/报告后，Codex 集成员工读取前置产物并实跑验证。
5. 宿主执行额外输入断言、核对用户文件、检查所有任务 accepted，重启服务验证状态保留。
6. 两个运行时各执行一次真正的长工具命令，出现开始标识后停止；要求 quiescent 及无延迟文件写入。未知停止不得记成功。

以上为脚本中的验收步骤，不是已完成结果。模型未执行前无法判断 CLI/SDK 的完整工具行为、供应商可用性或这些断言是否全部通过。

## 证据与归因

结果写 `.tmp/evaluation/native-*/`：result、公开运行事件、会话/交付检查、累计预算、findings、OpenJudge cases.jsonl/scores.json。失败时尝试停止所属 Run 并等待关闭，保存已失败 Run 的公开事件；不记录私有思考、原生会话标识或凭据。单次操作完成不等于交付已验收，指导 accepted/queued 不等于 processed，必须同时检查状态和最终文件。

免费预检发现旧兼容性脚本采用目录优先的可执行文件查找，选中 npm Codex 0.145，而产品采用后缀优先、实际选中原生 Codex 0.166。现已复用 `executableOnPath`，避免探针与真实产品验证不同版本。

第一次 Claude 无推理握手探测的停止证据为 unknown；第二次为 quiescent。两次原始报告均保留；尚不能确认首次原因，未放宽生产停止判定。完整长命令停止场景尚未运行，不据此宣称稳定性已通过。

官方协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude CLI](https://code.claude.com/docs/en/cli-reference)；具体兼容性同时以本机生成的协议 schema 和真实握手为准。
