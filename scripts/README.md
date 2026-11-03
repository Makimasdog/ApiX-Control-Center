# 开发脚本

| 目录 | 用途 |
| --- | --- |
| `evaluation/` | 编码任务目录与离线/真实模型评测入口 |
| `verification/` | 交付、npm 浏览器流程及真实协作/自主执行验证 |
| `diagnostics/` | 独立架构能力诊断 |
| `maintenance/` | 本地临时产物归档（支持 `-WhatIf`，不删除） |

Agent 系统评测入口：`npm run eval:agents -- --suite all`、`npm run test:evaluation`，先安装独立 OpenJudge 环境；真实模型须显式指定模型与单批费用上限。环境、协作场景、证据/归因和费用语义见 [OpenJudge 评测契约](../docs/专题/OpenJudge-Agent评测.md)。

真实 Codex/Claude 工具验收预检为 `npm run test:native:inspect`（不推理）；`test:real` 已完成真实协作与停止分段覆盖，支持 `--stop-only` 单独补测。当前累计预留超过最新 20 元门禁，拒绝继续付费调用；员工声明额度不等于已计量费用，见[原生验收说明](../docs/专题/真实Codex-Claude协作验收.md)。

在仓库根目录运行，优先使用 package.json 提供的入口：`npm run eval:coding:real`、`npm run test:delivery:browser`、`npm run test:npm:browser`、`npm run test:real`。目录迁移不改变这些命令名、批准参数或费用语义。

真实模型和真实员工验证可能收费，仍须显式批准；移动脚本不代表已运行。浏览器脚本启动服务后必须完成界面流程并写入结果，不能把启动当作验证成功。具体操作和授权边界见 [开发约定](../docs/开发约定.md)。

历史第二轮夹具保留在 `verification/legacy/verify-round2.mjs`，未适配当前 owner 鉴权与遗留 API 隔离；本轮实际自检在就绪探测超时，不能用于当前验收。当前验证请使用上方 package.json 入口。临时归档见 [目录规则](../docs/目录结构.md#临时产物)。

归档脚本回归：`powershell -NoProfile -File test/archive-local-artifacts.test.ps1`，覆盖占用失败不拆目录、预览、日志、重试及证据保留。
