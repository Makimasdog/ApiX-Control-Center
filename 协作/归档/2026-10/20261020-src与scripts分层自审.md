# src / scripts 领域分层（Codex 自审）

日期：2026-10-20。续接同日根目录整理；起始及当前 HEAD 为 `d2d42d1520fc119eb3aa2e1fa1b0f6c36b0c0be1`，没有提交、推送、切换分支或启动其他 Agent。本报告是实现者自审，不是独立审查或人工批准。

## 实际结构

src 的 57 个实现/平台文件和 scripts 的 7 个脚本全部迁入子目录，两者根目录只保留 README 导航。不新增聚合导出、空壳兼容模块或业务抽象，也不借整理重写 Runtime。

| 目录 | 数量 | 责任 |
| --- | --- | --- |
| src/assistant | 14 | 主循环、工具/MCP、上下文、推理桥、编码与交付 |
| src/models | 5 | 供应商、模型协议、对话配置、本地模型及咨询 |
| src/execution | 6 | 命令托管、日志、能力、执行控制、Windows PS1/C# |
| src/agents | 5 | 员工设置、适配器、上下文、事件及信息 |
| src/coordination | 14 | 需求、规划、架构契约、权限、调度、任务与自主监督 |
| src/messaging | 2 | 信箱与员工消息 |
| src/projects | 7 | 项目身份、基线、交接、就绪与交付检查 Worker |
| src/validation | 2 | Node/npm 项目诊断与托管验证 |
| src/infrastructure | 2 | 环境加载和公开静态映射 |
| scripts/evaluation | 2 | 任务目录及评测入口 |
| scripts/verification | 4 | 浏览器、真实协作与自主执行验证 |
| scripts/diagnostics | 1 | 架构能力诊断 |

详细路径及迁移前后 SHA256 见 [迁移清单](../../验收数据/2026-10/20261020-src-scripts迁移清单.json)。使用入口见 [模块导航](../../../src/README.md)、[脚本导航](../../../scripts/README.md) 和 [目录说明](../../../docs/目录结构.md)。

## 引用、平台与访问边界

- 同步修改 src、web、根 control-plane/server、测试、package.json 和当前文档的源/编译路径。TS 配置仍使用递归 include，输出为 dist/src/<领域>；历史审查、原始指纹和归档记录不改写。
- Windows helper 从编译后的 dist/src/execution/command-lifecycle.js 正确定位到 src/execution/windows-command.ps1，PS1 与 C# 继续同目录。
- 项目检查 Worker 与其依赖继续在同组；环境加载仍指向仓库根 .env；真实验证脚本正确回到仓库根，评测源码哈希也从根定位。
- 所有 npm script 命令名及批准/费用语义保留。真实模型或真实员工运行没有因文件移动被自动执行。
- 前端共享 assistant-result 的编译路径随模块迁移更新，静态白名单只允许新的确切路径；额外保留旧 `/dist/src/assistant-result.js` URL 的同内容别名。没有放宽为整个 dist/src 可下载。
- 生产资源测试递归解析实际 JS 模块的静态 import/export，逐个检查浏览器能否取得对应资源，而非只检查 HTML 的第一层链接。

原有 `.gitignore`、`agent-discovery.mjs` 内容与开始前副本一致。server 工作文件是在原有用户注释上只更新本轮导入；其暂存内容从上一轮已审查 index 生成，不包含原有未暂存注释。其他已暂存目录整理继续保留；`.claude/skills/` 和 test/MCP_test.py 未纳入。

## 验证及中间发现

Windows / Node 22.19.0 / npm 10.9.2。原 dist 先检查路径位于当前仓库内，再用原生 Move-Item 保留在 `.tmp-modules-20261020/dist-before`，全新构建；MCP 完成归组后再次保留中间产物并重新生成最终 dist。没有删除用户数据，也不借旧编译文件让未迁移的导入通过。

| 检查 | 实际结果 |
| --- | --- |
| 初次及最终 `npm run build` | 通过；最终是无旧产物的构建，日志 final-build.log |
| 初次及最终 `npm run check` | 通过；动态导入修正后的最终日志 after-dynamic-check.log |
| critical：environment、command-lifecycle、static-files | 17/17 通过，49.10 秒；发生在 MCP 最终归组与资源递归断言增加前，因此不冒称替代最终回归 |
| 模块/路径完整性自检 | 64 项迁移、327 处相对引用；无缺失模块/Worker/helper；当前导航链接无缺失；原有用户代码保留 |
| 最终回归首次运行 | 运行输出至第 48 项时有 47 通过 / 1 失败；编码评测子进程因动态拼接 import 漏迁移而立即退出，导致测试读到空 JSON。确认原因后主动停止本次拥有的运行树，未计完整通过；日志 tests-before-dynamic-import-fix.log。停止工具曾报告两个正在退出的子进程无法终止，随后按确切 PID 复核，整个已知运行树均不存在，无残留被冒称成功 |
| 修复后 21 文件回归 | 外层 15 分钟 watchdog 触发，进程退出 1，明确记失败；中止前输出 109 通过 / 0 用例失败，但没有完整 TAP 终态，其余未完成，不算整组通过。原标准每文件超时保持 1200000ms。日志 `.tmp-modules-20261020/final-tests.log`，结果 test-result.json |
| 余下 13 文件分批补验 | **81/81 通过**，477.84 秒，0 失败/取消/跳过，退出 0，外层保护未触发；保留原断言/每文件时限和同样的 15 分钟外层保护，日志 remaining-tests.log，结果 remaining-test-result.json |

中间完整性检查发现 MCP 模块未在最初分组中，已补入 assistant 并重新全新构建；不会把根目录残留文件称为已完成分层。随后文件系统检查将 web/agent-os.js 的浏览器根 URL 误当成源码所在目录，已修正检查器的 URL 基准，并增加真实服务递归模块获取断言验证实际行为；没有改写浏览器现有 URL。

首次最终回归进一步发现评测脚本 `map(x => import('../dist/src/'+x+'.js'))` 无法由普通字面量迁移覆盖，直接复现同样退出 1。已替换为按新领域路径显式列举的八个 import，保留并发加载及解构顺序；不修改原错误脱敏/批准边界。再扫描全部动态 import，除现有动态类型表达式外无同类拼接入口遗漏，并重新核对确切路径和静态检查后冻结代码重跑。

最终回归清单覆盖架构、协调、员工设置、消息、环境、执行控制、命令生命周期/桥、MCP、模型协议/终止、项目就绪/基线、调度、编码 HTTP、交付 HTTP、独立评测/预算、真实 npm 准备及浏览器资源访问。它是相关回归，不称完整 npm test；固定 HTTP/CLI 与本地 npm 包验证工程路径，不证明真实模型能力。真实付费模型请求 0，真实下载及跨平台未运行。

修复后的组运行被 15 分钟保护中断后，不重跑已经完整结束的 architecture、coordinator（69 个用例）、environment、command-lifecycle、command-bridge、coding-http、delivery-http、coding-evaluation 八个文件；对正在运行和未开始的 13 个文件原样补验，包括重跑未完整结束的 evaluation-budget。此前的 109 项部分结果不与补验计数简单相加，不改写该整组超时失败。

同一冻结源码下，前八个完整文件共 107 个用例通过，另两个 budget 用例因所属文件未结束不计入该数；其余 13 文件补验 81 项通过，按文件去重共覆盖 21 文件 / 188 个用例。该分批覆盖结果不改称一次完整 npm test 或一次无失败的整组运行。分批补验开始前复核已知运行树均已退出，未改产品超时、断言或可信验收门槛。

## 审查结论

审查全部迁移文件及调用方：业务逻辑只做相对导入/根路径修正，评测的动态拼接导入改为同顺序显式导入；额外运行变化仅为保持旧共享模块 URL 的同内容兼容映射，测试增加递归资源断言。确定性对照原文转换，避免误改业务、批准、数据或执行边界。

最终 146 个代码/测试文件与冻结清单逐项 SHA256 一致；server 工作版与暂存版的语法树一致，只保留用户原有未暂存注释差异。使用明确清单暂存，核对工作区只剩原有 `.gitignore`、`agent-discovery.mjs`、`server.mjs` 修改及未跟踪工具/测试文件；最终暂存 diff 通过 whitespace 检查。限定于目录及引用迁移范围内 **Codex 自审通过**，上述实际失败与完整 npm test、真实模型、完整浏览器交互和跨平台未执行项继续保留，不宣称全量或独立验收。
