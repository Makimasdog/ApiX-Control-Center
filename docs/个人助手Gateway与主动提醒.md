# 个人助手 Gateway 与主动提醒

## 运行方式

在仓库目录执行 `npm ci` 与 `npm run gateway`。Gateway 绑定 `127.0.0.1:4173`，使用现有所有者令牌与 SQLite 数据目录。关闭浏览器后，调度继续在 Gateway 进程中运行。部署为长驻进程时，可由操作系统的进程管理器从仓库目录运行已构建的 `node server.mjs --gateway` 并管理重启。沿用 `PORT`、`APIX_DATA_DIR` 和本地环境配置。

`npm start` 和桌面后端也加载调度器。桌面管理的后端跟随 Electron 生命周期。需要独立运行时使用常驻 Gateway 和浏览器界面。每个数据目录运行一个 ApiX 实例。

## 提醒规则

在「管理总览」选择项目并打开「主动提醒」。可创建、编辑、暂停和删除规则，查看运行记录并标为已读。规则和收件箱按项目隔离，删除规则保留已有运行记录。

| 类型 | 配置与行为 |
| --- | --- |
| Cron | 数字五字段表达式和 IANA 时区，例如 `0 8 * * *` 与 `Asia/Hong_Kong`。待办汇报汇总项目执行、审批、验收、回复等状态。Gateway 重启时合并停机期间错过的时点，补发一次当前状态并计算下次时间。暂停期间跳过计划执行。 |
| Heartbeat | 检查间隔 60–86400 秒，默认 300 秒。检查需要所有者处理的项目任务和会话，按条目身份与状态记录检查点。有新增或变化的待办才提醒，无待办及状态未变时静默。 |
| 项目文件 | 指定单个项目相对路径，按 2–86400 秒间隔检测文件元数据，默认 10 秒。初始值作为基线，创建、修改或删除时提醒。复用项目文件访问边界，允许预先配置尚未创建的文件。 |
| Git 推送 / 邮件到达 | 本地事件桥接器向 Gateway 提交归一化事件，精确匹配项目、类型与来源。推荐 Git 使用仓库标识，邮件使用邮箱或收件箱标识。 |

文件检查读取元数据，不打开文件正文。相邻检查之间的多次变化可合并为一次。通知与规则时间原子保存。写入失败保留到期记录供后续轮询重试，路径检查失败显示在规则和收件箱。此阶段的动作是生成本地待办汇报和提醒，独立于模型推理、邮件发送和员工运行。

## 所有者 API

以下路径相对于 `/api/projects/{projectId}/gateway`。请求沿用回环地址、Host/Origin 检查及所有者认证。

| 接口 | 用途 |
| --- | --- |
| GET / | 当前项目规则、最多 50 条运行记录和未读数，未读优先 |
| POST /rules | 创建规则，提交 `name`、`enabled` 和 `trigger` |
| POST /rules/{id} | 修改规则，附带当前 `revision` |
| POST /rules/{id}/delete | 删除规则，附带当前 `revision` |
| POST /runs/{id}/read | 标为已读，提交空 JSON 对象 |
| POST /events | 接收 Git 或邮件事件 |
| GET /api/gateway/status | 查询全局 Gateway 模式、运行状态、启动及最近成功调度时间 |

`trigger` 使用 `kind` 区分类型。Cron 提交 `expression`、`timeZone`。Heartbeat 提交 `intervalSeconds`。文件提交 `path` 和 `intervalSeconds`。Git 和邮件提交 `source`。过期的规则版本返回 409。创建时默认启用，修改省略 `enabled` 时保留原设置。Cron 按 [cron-parser](https://github.com/harrisiirak/cron-parser) 计算带时区的下一次执行时间。

事件桥接器向 `POST /events` 提交 JSON，例如：

```json
{"kind":"git.push","source":"team/repo","eventId":"stable-delivery-id","summary":"main 收到新提交"}
```

邮件使用 `kind: "mail.received"`。桥接器应从上游取稳定的投递 ID，并使用所有者 Bearer 令牌访问本机 Gateway。事件收据与对应提醒在同一事务写入，重启后仍可按项目、事件类型、来源和 ID 去重。Git 托管平台及邮箱连接由本地桥接器提供，Gateway 不对外开放 webhook，也不保存邮箱凭据或采集邮件正文。

## 验收

执行 `npm run build`、`npm run check`、`node --test --test-concurrency=1 test/personal-gateway-http.test.mjs test/personal-memory-http.test.mjs`、`npm run test:desktop`。浏览器在「管理总览 → 主动提醒」创建 Cron、文件或事件规则，检查启停、收件箱、已读及删除行为。
