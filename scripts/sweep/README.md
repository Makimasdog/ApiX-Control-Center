# Sweep — 只读巡检器（P0）

设计背景见 [自动巡检与修复工作流方案](../../docs/设计/2026-11-24-自动巡检与修复工作流方案.md)。

## 边界

**只读。** 不写仓库、不建分支、不派员工、不提交。产出结构化 finding，交给人或模型判断。

修复动作不在这个脚本里：脚本负责可判定的部分（扫描、指纹、门禁、提交），判断只发生在「改哪几行」这一步。

## 用法

```bash
node scripts/sweep/sweep.mjs scan --repo . --json
node scripts/sweep/sweep.mjs scan --repo . --only test.unregistered,doc.brokenlink
node scripts/sweep/sweep.mjs scan --repo . --skip-slow
```

| 参数 | 说明 |
| --- | --- |
| `--repo <路径>` | 目标仓库，默认当前目录；可指向别的项目 |
| `--json [路径]` | 输出结构化结果；省略路径时写 `.tmp/sweep/<时间>.json` |
| `--only a,b` | 只跑指定规则 |
| `--skip-slow` | 跳过 high 成本的检测器 |

## 规则

| 规则 | 车道 | 说明 | 有复现命令 |
| --- | --- | --- | --- |
| `test.unregistered` | structural | `test/**/*.test.mjs` 未出现在 `package.json` 的 `node --test` 清单里 | 是 |
| `script.missing-file` | structural | `scripts` 里引用了不存在的文件 | 是 |
| `dist.stale` | structural | `dist` 有源码已删除的孤儿产物 | 是 |
| `doc.brokenlink` | doc | `docs/**/*.md` 相对链接指向不存在的文件 | 否 |
| `doc.command-drift` | doc | 文档提到 `npm run x` 但 `x` 不存在（跳过归档/redesign/附录） | 是 |
| `tsc.error` | static | `tsc --noEmit` 诊断 | 是 |
| `lint.error` | static | `eslint --quiet` 的 error | 是 |
| `todo.stale` | static | 注释里的 TODO/FIXME/HACK（只报不修） | 否 |

## 指纹

`sha256(rule_id | 文件 | 语义锚点)`，取前 16 位。语义锚点按规则取：诊断码、eslint ruleId、命令名、注释正文。行号只用于展示，不参与指纹——否则改一行上面的代码，全文件的 finding 都会重新冒出来。

## 已知限制

- 慢车道（tsc ≈ 13s、eslint ≈ 25s）每轮都跑，合计约 40s；大仓库需要按需 `--skip-slow`。
- `todo.stale` 会把字符串模板里的 `// TODO` 也算进来，属于可接受的误报（severity 1、只报不修）。
- 尚未实现：失败测试、依赖检查、基线对比、指纹持久化。见方案文档的分期计划。
