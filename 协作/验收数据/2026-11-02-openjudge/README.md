# OpenJudge 离线探测证据

日期：2026-11-02。基线 ApiX HEAD：`58ff1710e8aa2713078b13ad8080561e9b4e38bd`。

- `runtime-summary.json`：既有 deterministic 真实执行链报告的精简字段；五类任务全部完成，模型请求 0。不含完整事件和工作区。
- `openjudge-proof.json`：OpenJudge 两项 FunctionGrader 经 GradingRunner 读取完整报告的 10 个结果；另有 1 个合成负例。评分读取现有判定，不重新执行任务代码。
- `probe.py`：本轮临时探测源码的留存副本，不是正式评测入口。断言固定五个任务，便于复核本轮结果。

上游提交 `070f7b8f2a3144f50788a9161c509c24130fb502`；源码版本 0.2.0。Python 3.11.9，pydantic 2.12.5；缺少的 loguru 0.7.3、colorama 0.4.6、win32-setctime 1.2.1 安装到系统临时目录，不改全局安装。未完成全量依赖安装；numpy 缺失导致 DistributionAnalyzer 导入失败，未在探测中使用。

复现（PowerShell；先使用仓库支持的 Node，本轮为 22.23.3）：

```powershell
npm run build
node scripts/evaluation/evaluate-coding-real.mjs --mode deterministic --tasks all
```

把输出中的 `report` 路径作为 probe 的第一个参数。以下路径为新建系统临时目录，若已有目录则先核对其来源与上游提交，不覆盖原目录：

```powershell
$researchRoot = Join-Path $env:TEMP ('apix-openjudge-' + [guid]::NewGuid().ToString('N'))
git clone https://github.com/agentscope-ai/OpenJudge.git $researchRoot
git -C $researchRoot checkout --detach 070f7b8f2a3144f50788a9161c509c24130fb502
$researchDeps = Join-Path $env:TEMP ('apix-openjudge-deps-' + [guid]::NewGuid().ToString('N'))
python -m pip install --target $researchDeps 'loguru==0.7.3' 'pydantic==2.12.5' tqdm
$env:PYTHONPATH = $researchRoot + ';' + $researchDeps
python '协作/验收数据/2026-11-02-openjudge/probe.py' '<上一步输出的report路径>' (Join-Path $env:TEMP 'openjudge-proof.json')
```

这是最小模块探测，不能代替正式发行包安装/锁定环境验收；新运行的报告 hash 和耗时通常不同。原始完整报告本机位置：`C:\Users\1\AppData\Local\Temp\apix-coding-evaluation-8NcbKR\report.json`，SHA-256 记录在 proof 中，可能被系统清理。需要完整轨迹时重新运行上述入口；这些精简证据不声称能还原全部历史事件。
