# 独立 ApiX 推理后端：契约与验收

日期：2026-10-16；基线：2035de1。Codex 实现前后端并自审，不启动子 Agent。

## 边界

- ApiX 自有主循环负责模型决策、上下文、工具权限、Skills、委派、预算、监督与实际验收。模型 HTTP 适配器只返回文本，不直接运行代码或启动 CLI。
- 管理者统一直接请求配置的 API；支持原有 Chat Completions、Responses、Anthropic Messages。既有 URL/model/apiType/apiKeyEnv 配置保留；缺少配置须提示补齐，不回退到 Pi、其他 CLI 或收费模型。
- Pi、Codex、Claude 等均为可选员工；Pi 的 RPC、独立认证与咨询适配器仅用于用户选中的员工任务。历史事件保留，历史 pi 模式可识别；新推理标记为 api。
- 就绪条件检查模型配置、密钥与预算，不检查 Pi 安装；员工缺失不能阻止普通对话。配置校验不代表模型已认证，连接测试保留明确费用批准。
- 默认对话工具仍由已有 assistant-loop 执行；旧需求工作台只做结构化对话与规划，不将模型文本隐式变成项目工具操作。

## HTTP 适配契约

复用模型配置；只发送当前任务所需 prompt 与固定 system 指令，密钥来自环境变量。URL 禁止凭据、查询和片段；禁止重定向，限定请求/响应大小、时间与输出文本，流式错误、截断、未完成不能变为成功。提供商错误必须脱敏，不泄露密钥或任意响应正文。支持流式公开答复，不展示 reasoning/thinking 通道。不自动重试可能收费的请求。

实现采用最长 90 秒、输入 512 KiB、HTTP 响应 2 MiB、公开文本 100000 字符的限制；Anthropic 请求输出上限为 8192 tokens。底层统一请求 SSE，以兼容部分 Qwen 思考模型只接受流式调用的情况；调用方可只收集完整文本。协议参考 [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses)、[Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) 与 [Qwen deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)。模型级推理/采样参数不臆测、不自动修改。

## 验收

1. 清空所有员工 CLI 入口、PATH 不含 Pi，使用隔离本地模型 HTTP 夹具，完成多轮对话、真实工具失败修复、选择与记忆、规划及验收。
2. 三种协议的 URL、认证、请求体、文本提取、SSE、错误/超时/大小限制与凭据脱敏有实际 HTTP 测试。
3. 缺配置只提示配置；连接测试批准、项目预算和未知费用不被绕过；恢复与停止沿用宿主状态机。
4. Pi 员工仍可单独注册执行，管理者不使用其入口或模型配置；Codex/Claude 继续原路径执行。
5. 界面和快速开始不再把 Pi 写成管理者必需依赖；已有记录和其他用户改动保留。最终 diff 自审后明确暂存并提交，不推送或合并。
