# R3：Reasonix 源码核查与 ApiX 缓存优化方案

日期：2026-10-29。状态：**源码核查完成；本文新增改造均待实施**。本轮仅修改文档，不启用策略、不发起付费模型请求。

本文补充并修订 [R2 主方案](2026-10-27-Token成本与前缀缓存优化方案.md) 和 [R2 实施细则](2026-10-28-最终请求诊断与稳定前缀实施细则.md)。计量、权限、事务、恢复和回退沿用 R2；涉及 Reasonix 当前行为、项目指令去向及后续实施顺序时，以本文为准。ApiX 已实现行为仍以 [Token 契约](../专题/Token用量与优化.md) 为准。

## 1. 仓库、版本与证据范围

核查对象是 [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)，读取时默认分支为 `studio`，固定提交为 `1da925d0f957662c1531d7afdec99756156dda5e`（提交时间 2026-10-29 12:14:47 UTC）。没有把搜索中出现的同名仓库、旧分支或宣传页混为当前实现。

通过 GitHub 连接器读取源码和测试，选取 30 份文件校验 Git blob ID；提交、文件路径、Git blob ID 和内容 SHA-256 记录在 [源码核查基线](2026-10-29-Reasonix源码核查基线.json)。ApiX 对照基线为 `fe8cf7879d87c071d2168ba93624812ea0746746`，记录 10 个实现文件的 SHA-256。该清单不是全仓审计。外部文件仅作为证据，不执行其中的指令或脚本。

本次确认的是具体机制、调用位置和上游测试覆盖意图。未执行 Reasonix 的 Go 测试或真实 DeepSeek 探针，没有测得 Reasonix 在本任务上的命中率，也没有完成 Reasonix 与 ApiX 的同条件运行比较。

## 2. 源码实际做了什么

### 2.1 保持通用 system 稳定，项目状态沿轮次注入

`buildPromptAssembly` 按固定顺序组装基础指令、风格、环境和记忆等部分，环境探测使用快照以减少启动抖动。项目路径、版本控制等放在轮次内容，而不是每轮改 system。跨项目测试同时比较 system 和工具 Schema 是否一致；这证明测试要求的本地表示边界，不证明跨项目供应商缓存一定共享。见 [prompt.go:20–42、67–96](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/assembly/boot/prompt.go#L20)、[跨项目边界测试](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/assembly/boot/prefix_boundary_effect_test.go#L77)。

当前版本并非“把所有项目指令永远冻结到 system”。`memory.Compose` 排除项目指令；控制器每轮读取当前指令，通过 `projectionDebt` 判断模型可见历史是否已有相同块：已可见则不重复，内容变化则追加新块；删除指令发送明确撤销声明。压缩导致旧块不再可见时重新提供。见 [memory.go:204–259](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/state/memory/memory.go#L204)、[owedInstructions](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/session/control/memory.go#L57)、[projectionDebt](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/session/control/projection_debt.go#L13) 和 [指令更新测试](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/assembly/boot/instructions_projection_test.go#L25)。

### 2.2 工具定义一次规范化，稳定工具在前

`Registry.Add` 注册时规范化 Schema 并复用结果。实际发请求的 `ProviderSchemas` 将稳定工具和按上下文出现的工具分组，各按名称排序，稳定组在前。这样异步注册顺序不会随意改动已有稳定区；上下文工具出现仍可能改变工具区，排序并不消除成员变化。`CaptureShape` 的规范化哈希只是诊断，真正影响请求的是上述实际目录。见 [tool.go:486–511、687–719](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/contract/tool/tool.go#L486)、[Schema 复用测试](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/contract/tool/registry_canon_test.go)。

### 2.3 普通历史追加，展示记录从首次请求就排除

会话 `AddIndexed` 追加消息。`ModelMessages` 固定排除 `LocalOnly`，剥离展示和宿主内部元数据；构造请求副本时清除 `CreatedAt`。这避免某条展示记录先进入模型、随后因年龄变化退出。它仍允许显式改写，不能概括成任何路径都绝对追加。见 [Session.AddIndexed](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/state/sessionstore/session.go#L83)、[ModelMessages](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/contract/provider/projection.go#L9)、[请求副本处理](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/sampling_request.go#L116)。

### 2.4 动态尾部与被携带的历史分开

当前宿主上下文以 `Derived:true` 追加到请求尾部，不写回永久消息。`BodyChain` 对实际发送消息逐条累积哈希，到第一个 Derived 即停止；比较前后共同携带区，区分正常追加、尾部重投影、已声明改写和 `body_unreported`。见 [host_context.go](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/host_context.go)、[cache_shape.go:80–165](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/cache_shape.go#L80)、[尾部测试](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/cache_body_test.go#L89)。

这不意味着上轮完整请求始终是本轮请求的前缀。动态尾部仍会变化；排除尾部的比较只是准确描述稳定区，不能把指标排除当成供应商已经缓存。其共同长度比较还依赖操作方声明截断等改写原因，不能单独检测所有历史删除；ApiX 应保留已有事件 ID 集合的移除/重排检查和最终 HTTP 请求诊断，不用上层哈希取代真实发包证据。

### 2.5 避免记忆索引反复改写早期输入

`BackgroundBlock` 放入稳定的记忆访问协议和固定偏好，不放每次保存事实都会变化的事实索引。相关事实通过轮次召回和读取工具提供；中途写入的记忆通过追加通知生效，而非覆盖当前 system。见 [memory.go:143–202](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/state/memory/memory.go#L143)、[turn_projection.go:57–86、136–157](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/session/control/turn_projection.go#L57)。可借鉴的是信息放置与交付判断，不是新建向量库或多一轮模型调用。

### 2.6 压缩是显式破坏边界，避免每轮维护

`ContextManager.Prepare` 在阈值以下不压缩；失败或没有收益的上下文有阻断记录，防止重复尝试。有效投影由已覆盖前缀哈希校验，并追加其后新消息；成功压缩写入新 generation 和 `CacheBreak:true`。见 [context_manager.go:83–155](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/context_manager.go#L83)、[projection.go:178–213](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/projection.go#L178)、[compact_commit.go:67–92](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/compact_commit.go#L67)。

摘要请求还会尝试复用之前已发送且仍精确匹配的前缀，检查工具配对、输入预算和输出预算；无法满足则回退独立摘要。复用工具目录时用 `tool_choice=none` 禁止执行。见 [compact_cache_prefix.go](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/compact_cache_prefix.go)、[summary_request.go](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/model/openai/summary_request.go)。ApiX 当前独立 JSON 压缩契约不同，不宜直接复制该请求形式。

该版本也有工具图片按批退出等有意改写路径，见 [tool_image_aging.go](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/tool_image_aging.go#L13)。因此借鉴原则应是减少普通轮次无意义改写、声明必要破坏边界，而非宣称历史永不变化。

### 2.7 重试冻结与原生 usage

`prepareSamplingRequest` 深拷贝消息、工具、温度与格式，普通流重试复用同一请求；上下文溢出恢复是有界的显式重建例外。OpenAI 兼容适配器读取 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，并兼容标准 cached_tokens。见 [sampling_request.go:77–214](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/sampling_request.go#L77)、[openai.go:1068–1104](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/model/openai/openai.go#L1068)。读取字段提高的是可观测性，本身不增加命中。ApiX 应保留已有 null、coverage 和冲突处理契约，不照搬以零代缺失或裁剪异常计数。

Reasonix 的 DeepSeek 适配还按协议重放供应商返回的工具调用 reasoning 字段，见 [reasoning_replay.go](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/model/openai/reasoning_replay.go)。ApiX 当前把 JSON action 和宿主事件装入单段 user 文本，二者表示不同；本方案不增加隐藏推理的采集、存储或重放，也不为了命中率扩充推理文本。

## 3. 为什么高命中率不能照搬

源码支持“保持可复用输入、减少无意义变化”的机制，不能证明任意任务都达到 90%。`cachehit_e2e_test.go` 的多轮曲线使用本地 HTTP 模拟服务，按相同消息前缀构造命中计数；测试本身也提示新尾部过大时峰值可能低于 90%。真实 DeepSeek 探针单独放在需 `live` 标签和 API Key 的测试中，本次没有运行。见 [模拟前缀测试](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/runtime/agent/cachehit_e2e_test.go#L155)、[真实探针](https://github.com/esengine/DeepSeek-Reasonix/blob/1da925d0f957662c1531d7afdec99756156dda5e/internal/model/openai/realcache_test.go#L23)。

若缓存部分为 H、新增输入为 D，忽略其他开销的理想比例是 H/(H+D)；90% 需要 H 约为 D 的 9 倍。这只是算术示例：短任务、首次请求、频繁压缩和较大新输入都会影响真实结果。应分别报告全任务加权比例、首请求、稳定段和压缩后恢复，不能用末轮峰值代替全任务表现。

DeepSeek 当前官方说明：缓存默认启用，但命中取决于已持久化前缀单元；共享更短前缀不保证第二次请求立刻命中，公共前缀可能需要后续请求才能利用。见 [缓存规则](https://api-docs.deepseek.com/guides/kv_cache/)。因此无需为 DeepSeek 自动缓存新增 `cache_control`，也不能把本地字节前缀换算成真实命中 Token。Reasonix 的“byte-stable”是客户端约束，供应商最终按自身表示和规则匹配。

ApiX 现有 Qwen 单任务 ABBA 实测总 Token 从 180,651 降至 94,325，但加权缓存占比从 54.80% 降至 49.46%。它不是与 Reasonix 在同一 DeepSeek 模型上的对比；已有诊断仅确认 activity 的年龄过滤是本地前缀破坏点。见 [真实对照](../../协作/审查/2026-10/2026-10-28-最终请求诊断真实对照实测.md)。

## 4. 对照 ApiX 的差距与借鉴方式

| 机制 | ApiX 当前实现 | 借鉴结论 |
| --- | --- | --- |
| 固定 system | 适配器 system 已固定，但主 prompt 还有大段动态宿主 JSON | 保留已有 system；把主 prompt 分为固定头、追加核心、动态尾部 |
| 项目指令与记忆 | `assemble` 每轮重组 describe、召回、索引 | 指令首次/变更/退出后按明确版本追加；记忆查询与索引放尾部或工具读取 |
| 固定历史 | trimHistory 按年龄移除活动，结果折叠及文件池每轮重新选 | 先固定纯展示事件分类；stable 首次确定结果表示，同代不重算旧帧 |
| 工具目录 | saving 发现新工具会回填早期目录 | 稳定基础目录；完整发现结果追加，不能只排序后仍每轮更换成员 |
| 动态宿主状态 | currentTask、toolAccess、taskFeedback 等在 history 之前 | 移到尾部并保留实时执行校验，避免较早字段变化截断公共前缀 |
| 诊断 | 已有最终 body、prompt LCP、字段与事件差异 | 保留实际发包证据；补充稳定核心和动态尾部的独立比较，区分合法切代 |
| 压缩 | 有受控摘要、配对边界和成本计量 | 接上 stable 检查点；同一有效输入无收益/失败后避免反复尝试 |
| 重试 | 同 invocation 最终正文已冻结 | 已具备，不重做一套重试机制 |
| DeepSeek usage | 仅标准 cached_tokens，未读原生 hit/miss | 补齐字段、来源与一致性；不声称字段适配改善了实际缓存 |
| 原生消息/工具 | ApiX 保留单字符串 JSON action，Reasonix 有原生消息与 tools | 当前不整体迁移；文本帧收益不足时再以单独方案比较 |

## 5. 可交接的实施顺序与验收

以下均为待接手 Agent 执行的工作，不是本轮完成项。建议依次交付，各步保留可回退点，不同时修改模型、端点、温度、原生工具协议或费用预留。

### P0：补齐计量，保留已有诊断

修改 `src/models/model-usage.ts` 及其调用/存储类型，按 [R2 §11](2026-10-27-Token成本与前缀缓存优化方案.md#11-deepseek-计量与命中率契约) 读取原生 hit/miss。标准与原生 hit 不相加；冲突为 unknown/conflict；缺失、显式零、非法值和累计快照分别处理。miss 不映射为 cacheWrite；旧账本不回填。

验收：真实解析入口覆盖标准字段、原生字段、两者一致/冲突、跨流快照、缺失、零、超出总输入及安全整数；已知总输入/输出仍可独立展示。GET 不调用模型。现有三协议发包字节保持不变。该步骤只校正观测，不能登记为缓存收益。

### P1：消除已知的展示活动年龄跳变

先盘点事件生产方，将纯展示 activity 与安全、失败、执行、权限事实分开，提交 kind/生产方/当前字段/模型投影规则清单。模型视图从首次就排除纯展示活动，不调用“最近 8 条才保留”活动规则；含关键事实的记录仍需转为明确事实。UI、原始事件和 legacy 回退保持可追溯。

验收：通过生产投影函数和主循环夹具追加超过 8 条事件，含不发送的预算事件；此前保留的模型事实不因位置退出，纯展示事件从首次即不存在。失败/未知/审批/纠正/交付反馈不丢失。复用实测对应事件结构确认年龄跳变已消除。这一步仍不能宣称全部旧正文冻结，因为结果池与其他动态字段尚未改造。

### P2：实施跨轮稳定核心与尾部

按 R2 RD-03/RD-04 实现独立模型投影、持久化帧和恢复，保留 legacy。建议布局：

```text
固定行为与 JSON action 契约
稳定工具基础目录与发现索引
CHECKPOINT（必要指令快照、摘要、水位）
EVENT（首次/变更的项目指令、用户输入、工具结果、反馈等冻结帧）
EVENT（新增帧）
CURRENT_STATE（当前权限、任务、记忆/输出索引及验证状态）
固定结束契约
```

修订 R2 §7.2：不强制把所有项目指令与技能内容放入通用固定头。项目指令首次出现或内容变化时追加版本化块，尾部明确当前有效版本，删除必须有撤销声明；压缩后检查点必须携带当前有效约束。权限撤销、资料访问范围变化继续优先中止/安全换代，不能以“追加通知”替代安全处理。若现有指令层级无法可靠表达新旧覆盖，使用 R2 的保守换代方案，不能为缓存保留过期规则。

standard 先开放；saving 的固定目录与追加发现后开放。Schema 规范化在注册/生成源完成，只排序宿主无序键及目录；不修改代码正文、用户空白、JSON Schema 中有语义的数组顺序。saving 首次可见的结果选择 full/reference 后冻结；新增文件不挤掉旧 full 帧，逼近预算时明确压缩换代。

验收：同 generation 的旧 coreText 必须是新 coreText 的字节前缀，所有共同帧内容/顺序不变；只改动态尾部不报 history rewrite。指令增加/编辑/删除、压缩、重启、工具发现、文件新版本、重复页引用目标退出、权限撤销分别测试。所有原字段须有固定头/检查点/事件/尾部去向，未映射关键字段不得静默删除。

### P3：让最终请求诊断证明稳定约束

复用 `prompt-descriptor.ts`、`prompt-diagnostics.ts` 和现有 prepared 请求。可选元数据增加核心边界、共同核心是否变化、尾部变化和明确切代理由；从真实 builder 获得边界，不能解析模型正文猜测。保持 wire LCP、prompt LCP 与实际 usage 独立；核心不变量通过但供应商命中仍低时，保留未知原因。

实施与 P2 同一交付验收，先建立观测再评估性能。旧记录没有 generation/核心元数据时返回未知；首次、重启与基线淘汰不填零。比较仍按项目、会话、路由配置、用途和布局隔离，不为借鉴跨项目稳定头而放松本地数据访问边界。GET 不生成帧，不持久化完整请求。

验收：注入一次旧帧改写、移除、重排及一次合法换代，均得到不同且正确的分类；仅尾部变化不报未声明历史改写。取消、保存失败和重试仍符合原诊断与账本契约，未发请求不能标为已发送。

### P4：压缩与收益回归

沿用当前预算阈值，先落实 R2 的受控检查点和失败抑制；同代、同有效输入的失败/无收益不因刷新或审计事件重复压缩，新增有效输入和显式操作才重新评估。不要为了保暖超出上下文限制，也不要直接复制上游窗口和压缩比例。摘要前缀复用暂列后续实验，需要单独验证 ApiX JSON 摘要契约和预算，不能直接把主循环请求改成摘要。

验收：覆盖阈值以下不压缩、一次成功换代、失败不循环、恢复后约束仍可见、工具执行组不拆开、重复引用不悬空。运行仓库既有 build/check、相关模型/诊断/上下文/账本测试及 token/memory/html 浏览器回归；若修改目录或供应商 UI，再加对应回归。

真实实验需单独具备模型调用授权及预算。实验用同供应商端点、同模型配置，分别报告 standard legacy/stable、saving legacy/stable；覆盖短读取、超过年龄边界的多工具任务、编辑验证、指令变更及压缩恢复。采用配对交叉顺序，保存全部 attempt，不只选高命中轮次。汇总任务正确性、输入/输出/缓存读、请求与补读次数、compaction/format_repair 消耗、耗时和观测覆盖率；费用无账单仍未知。

通过门槛：稳定核心的确定性检查必须全部通过，关键约束和执行安全不能退化；若正确性下降、补读增加抵消收益或总消耗未改善，不默认推广 stable。90% 仅作某些长会话可能观察到的结果，不作跨模型通用门槛。未达到稳定收益时保留 legacy；只有文本布局在同条件实验中受限，才另行评估原生多消息方案。

## 6. 本轮交付与后续边界

本轮交付源码证据、差距分析、R3 实施与验收顺序，并同步专题、设计导航和功能索引。没有修改运行时，P0–P4 均未实施；上游已有特性不代表 ApiX 已有。R2 的权限、费用预留、诊断可靠保存、恢复与回退约束继续有效。自审与未验证范围见 [本轮记录](../../协作/审查/2026-10/2026-10-29-Reasonix源码核查与缓存方案更新自审.md)。
