# Token 用量与优化（第一版）

## 使用方式

进入「与 ApiX 对话 → 交付与详情 → Token 用量与优化」，点击「刷新任务用量」。面板显示当前任务的输入、输出、缓存读写、推理输出及各字段的观测覆盖次数；展开可看本对话、本项目累计及当前任务最近 30 次请求尝试。刷新同时更新已有上下文占用视图，不调用模型。

上下文模式默认「标准」。空闲且安全状态已确认时，可选择「节省」并应用；设置按对话持久化，开始下一任务继续沿用。运行、待审批、委派中或项目有未核对操作时拒绝修改。设置不改变项目权限、工具治理、预算、验收契约或模型配置。

节省模式保留常用文件、命令、检查和引用工具的完整参数；其余工具仅发送名称与简短用途，模型通过 `search_tools` 发现完整参数后使用。既有已发现工具继续保留完整参数。较旧的工具结果在 1200 字符以上时更早折叠为预览、宿主状态和不可变引用；最近两条事件保留原有规则，更旧历史仍保留原有 800 字符折叠规则。`read_context` / `read_output` 结果不再次折叠，避免无法读回正文。失败、退出码、未知状态及完整性信息沿用统一宿主投影，原始事件和正文不删除。

标准模式也支持按名称或用途检索内置工具；空查询保持既有外部工具发现列表行为。

面板的「工具目录估算减少」仅比较当前目录完整 Schema 与所选 Schema 加发现索引的 UTF-8 字节÷3，不代表任务总 token 或费用节省。发现工具、补读、压缩和返工仍会消耗 token。实际任务收益需用相同任务和模型比较成功率、总用量、耗时及补读次数。

## 计量契约

- `model_token_usage` 是附加 SQLite 账本，逐次请求尝试登记，包含 invocation、attempt、项目、会话、冻结任务 ID、用途、供应商、模型、协议、时间、状态及用量，不保存提示词、输出正文、地址或密钥。
- 开始网络调用前登记 `pending`；调用及传输清理完成后仅允许结算一次为 `completed` / `failed`。重试独立记录，共享 invocation；模型返回文本后发生 JSON 动作纠正，另记 `format_repair`。压缩记 `compaction`，普通主循环记 `assistant_loop`。用途由宿主调用参数指定。
- 遗留 Director 仅补计量归属，记 `legacy_director`，纳入项目累计；该冻结入口的模型选择、权限观察和执行流程不变。
- `completed` 表示模型传输完成，不表示 JSON 动作有效、代码验证通过或用户验收。异常、停止、流中断保留已观测的部分计数，缺失值为 `null`。进程意外退出时未结算条目继续保持 `pending`，不补造结果、不自动重放。
- Chat Completions 请求 `stream_options.include_usage=true`，读取终端 usage 块；Responses 读取响应 usage；Anthropic 合并 `message_start` 与 `message_delta` 的累计快照，禁止逐事件相加。兼容非流式 JSON 响应。
- 输入归一化：OpenAI 的输入含缓存；Anthropic 输入是 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。Anthropic 缓存字段缺失时总输入未知，已知输出及缓存子项仍单独保留。负数、字符串及非安全整数不视为实际计数。
- `usageComplete` 仅表示成功终端处观测到有效输入、输出，缓存和推理细分是否完整需看各字段 coverage。缓存属于输入、推理属于输出，不能再次加到输入输出总和上。
- 汇总为已知小计，不把未知当零；无观测或合计超过安全整数范围返回 `null`，另返回每个字段 coverage、缺少完整用量的请求数、失败、重试、待确认和耗时。请求正文估算单独记录，不含适配器固定系统提示，不用作实际用量。
- 主循环用量登记/最终保存失败沿用 `INFERENCE_ACCOUNTING_UNKNOWN`：记录账本故障，阻止后续同项目或共享账户推理，要求检查恢复。原有费用预留/人工结算逻辑不变，不根据 token 自行释放预留。

## API 与访问范围

- `GET /api/assistant/sessions/:id/context`：原有上下文响应新增 `usage` 与 `optimization`。`usage` 包含当前任务、会话、项目汇总和当前任务最近 30 次请求；`optimization` 包含模式、待发现工具索引和目录估算减少量。
- `POST /api/assistant/sessions/:id/optimization`：配置类限额，输入 `{version, mode: "standard" | "saving"}`；检查有效会话、版本及既有项目执行/安全门禁，原子保存模式、版本与变更事件。配置事件不会阻止首条消息创建任务，也不进入模型历史。
- 使用原有 owner 访问认证；失效、归档、删除会话无法读取或修改。任务/会话汇总绑定当前项目和会话，项目汇总包含该项目全部 ApiX 模型 API 尝试；结果引用仍受原有会话归属限制。

## 限制

仅采集 ApiX 宿主通过 `inferManager` 发起的 API 请求。外部 Codex / Claude 等 CLI 内部用量未知；升级前调用不回填。费用保持未知，未接入供应商账单、费率或硬封顶。支持兼容协议的供应商可能省略 usage，或不接受 `include_usage`；不为兼容失败自动重复请求。第一版不新增供应商缓存控制、自动换便宜模型、向量检索、语义答案缓存或额外 LLM 压缩策略。账本暂不自动清理；UI 明细最多 30 条，汇总覆盖全部已记录条目。

## 验收

Node 22.19–22.x 或 24.22–24.x。`npm test` 包含 `token-usage`、`token-usage-http`；`npm run check` 检查编译、孤儿 dist 产物及 lint。浏览器使用 `npm run test:ui:tokens`，可用 `APIX_PLAYWRIGHT_MODULE` 指向本机 Playwright；无需付费模型。另回归 `test:ui:html`、`test:ui:memory`。本轮记录见 [2026-10-27 自审](../协作/2026-10-27-Token用量与上下文优化自审.md)。

## 源码阅读入口

关键口径与边界已补充中文注释：`src/models/model-usage.ts` 解释各协议的累计快照和未知值；`src/assistant/token-usage.ts` 解释请求登记、一次性结算、覆盖率和任务隔离；`context-optimizer.ts` 与 `assistant-context.ts` 解释目录精简和完整结果回读。调用入口、主循环及前端注释分别说明计量归属与执行权限的区别、设置事务，以及异步视图防过期覆盖。注释维护不改变功能契约，验证见 [中文注释自审](../协作/2026-10-27-Token功能中文注释自审.md)。

协议参考：[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[Anthropic 流式消息](https://platform.claude.com/docs/en/build-with-claude/streaming)。
