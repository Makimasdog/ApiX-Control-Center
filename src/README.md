# 后端模块

按业务责任找目录，不再在 src 根目录新增实现文件。

| 目录 | 职责与主要入口 |
| --- | --- |
| `assistant/` | 主 Agent 循环、工具、上下文、推理桥、编码与交付证据；`assistant-loop.ts` |
| `models/` | 供应商、模型协议、每对话模型、本地模型与咨询；`model-backend.ts` |
| `execution/` | 受管命令、日志、能力、暂停/恢复与 Windows Job 辅助文件；`command-lifecycle.ts` |
| `agents/` | 员工设置、CLI 适配、上下文、事件与可观测信息；`runtime-adapters.ts` |
| `coordination/` | 需求、规划、架构契约、权限、调度、协作任务和自主监督；`coordinator.ts` |
| `messaging/` | 信箱及员工消息通道；`mailbox.mjs` |
| `projects/` | 项目身份、基线、工作区交接、交付检查 Worker 与就绪诊断；`project-folders.mjs` |
| `validation/` | Node/npm 项目诊断及托管副本验证；`node-project.ts`、`npm-validation.ts` |
| `infrastructure/` | 本机环境加载与 HTTP 静态文件映射 |

HTTP 路由和依赖装配仍在根 `server.mjs`、`control-plane.mjs`。使用直接相对导入，不增加聚合导出或兼容空壳；类型和模块契约随所属领域放置，跨领域引用保持显式。

TS 由根 `tsconfig.json` 编译到 `dist/src/<领域>/`；mjs 和平台支持文件直接从 src 执行。不要编辑生成物。Windows `.ps1`/`.cs` 与执行模块同目录，交付检查 Worker 与项目模块同目录。模块索引见 [代码索引](../docs/参考/代码索引.md)。
