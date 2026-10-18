# CI Windows 路径与测试清理修复自审

本轮沿用用户上一轮 git-sync 的同一分支同步范围，处理随后报告的 PR #7 CI 失败。Codex 完成修改及自审，未启动子 Agent；不是独立审查或人工批准。

## 原始失败证据

[CI 39025731158](https://github.com/Makimasdog/ApiX-Control-Center/actions/runs/39025731158)，提交 `1f4d2dd`，Windows + Node 22.19.0。安装、类型/语法检查通过，247 项测试中 244 通过、3 失败：

1. `Assistant can start a general conversation without selecting a project or registering employees`：再次创建通用对话返回 400，称目录已添加。项目创建使用 `realpathSync`，默认项目查找使用 `realpathSync.native`；CI 的 `RUNNER~1` 与 `runneradmin` 指向同一目录，字符串却不同。这是可影响实际用户的路径身份问题，不只是测试断言。
2. `conversation acceptance cannot bypass a bound autonomous quality contract`：验证断言已完成后清理临时工作区遇到 Windows `EBUSY`，测试启动的自主工作尚在结束，测试没有主动停止它。
3. `existing Git stays in its repository and managed baseline tampering is rejected`：基线正确返回 native 长路径，但测试把它与输入的短路径直接比较，误判不相等。

## 修改与自审

- `projectDirectory` 统一返回 native 真实路径。新增 `sameProjectDirectory`，对双方解析真实目录，Windows 按大小写不敏感身份比较；解析失败不冒充相同目录。
- 项目新增、修改和默认通用项目复用均使用同一身份判断。兼容数据库原有别名/短路径记录，不批量重写数据库、移动目录或新建重复项目。仍拒绝同一目录的重复注册；有活动任务时仍禁止切换到另一真实目录。
- 更新对应单元断言，比较 canonical 路径。对真实目录复用、找不到目录及目录浏览保留验证。
- 通用工作区 HTTP 测试新增真实 junction/symlink 别名，模拟旧数据库中已保存的目录别名；断言再次创建对话仍使用同一项目、按真实路径重复注册仍被拒绝、项目总数仍为一。
- 验收不可绕过的测试保留全部原断言，之后通过正式停止接口停止自己创建的协作，再等待运行/停止中的任务退出；没有放宽验收标准。
- 测试 harness 清理前验证绝对路径仍处于测试临时根目录，仅对自己创建的目录采用有限 `rm` 重试，最终清理失败仍会报错。保留重启测试的突然中止语义，没有把重启恢复测试改成正常停止。
- 检查全部调用方、错误路径、路径访问边界与最终 diff。没有修改 CI 工作流、跳过测试或提高运行时权限，没有更改用户 `.env`、账户、项目文件或其他原有改动。

## 提交前验证

从 Node 官方发布地址下载 Node 22.19.0 到忽略的 `.tmp-p0-p2/node22`，仅当前测试进程使用，不替换用户系统 Node；与 CI 版本一致。TypeScript 先完整编译，再运行测试，没有边编译边启动测试服务。

- 原失败相关的两项协调器测试、原基线路径测试、目录与项目/员工端到端：**5 passed / 0 failed**；日志 `.tmp-p0-p2/ci-targeted-node22.log`。
- 项目基线、项目/员工设置、五项反馈、主循环和就绪检查：**48 passed / 0 failed**；日志 `.tmp-p0-p2/ci-regression-node22.log`。这些套件与前一组有重叠，不累加为独立覆盖数。
- Node 22.19.0 下 `npm run check` 和 `git diff --check` 通过。
- 原 EBUSY 对应验收测试在 Node 22.19.0 下额外连续重跑三次，三次均通过；日志 `.tmp-p0-p2/ci-cleanup-repeat-1.log` 至 `ci-cleanup-repeat-3.log`。

自审结论：本轮改动通过，可以按明确文件清单提交并推送到原分支。提交前核对暂存区与自审内容一致；原有 `.gitignore` 和未跟踪文件保留，不纳入提交。

## 未验证与后续结果归属

提交前尚未在 GitHub 执行修复版本的全量 CI，不把本地验证称为 GitHub 已通过；推送后以该提交对应的新运行结果为准。原 Windows runner 的短用户目录环境由云端 CI 验证，本机以真实目录别名补充回归。

未调用真实付费模型或真实员工账户。此次修复不表示所有平台和所有工作流均无故障。
