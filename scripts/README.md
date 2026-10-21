# 开发脚本

| 目录 | 用途 |
| --- | --- |
| `evaluation/` | 编码任务目录与离线/真实模型评测入口 |
| `verification/` | 交付、npm 浏览器流程及真实协作/自主执行验证 |
| `diagnostics/` | 独立架构能力诊断 |

在仓库根目录运行，优先使用 package.json 提供的入口：`npm run eval:coding:real`、`npm run test:delivery:browser`、`npm run test:npm:browser`、`npm run test:real`。目录迁移不改变这些命令名、批准参数或费用语义。

真实模型和真实员工验证可能收费，仍须显式批准；移动脚本不代表已运行。浏览器脚本启动服务后必须完成界面流程并写入结果，不能把启动当作验证成功。具体操作和授权边界见 [开发约定](../docs/开发约定.md)。
