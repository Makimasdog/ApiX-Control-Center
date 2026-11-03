# 真实原生 CLI 免费预检

本目录仅保存无推理预检；不证明完整真实工具任务通过。对应[自审记录](../../审查/2026-11/2026-11-03-真实原生协作预检与验收入口自审.md)。

- `compatibility-before.json`：旧探针选中 npm Codex 0.145；Claude 停止证据 unknown。
- `compatibility-after.json`：修复查找逻辑后选中与产品一致的 Codex 0.166；Codex/Claude 本次握手与停止已确认。不能据复跑删除首次未知记录。
- `preflight.json`：真实命令/版本、Claude 公开路由与凭据存在性（不含值）、累计费用预留与任务未运行状态。Codex custom 段被声明不代表实际选中；另以只读 config/read 核对。

本轮新增模型请求为 0，前轮累计预留仍为 CNY 1.972464。员工增量计价未确认，因此完整原生验收入口没有执行。
