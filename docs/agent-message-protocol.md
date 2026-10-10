# ApiX 统一 Agent 消息协议（v1）

ApiX Control Plane 是消息的唯一记录者。Director 和员工通过项目 mailbox 交换消息；消息状态、投递尝试、交付物引用和锁租约保存在本地 SQLite。Pi/Codex 的现有 CLI 运行仍由任务审批启动，消息协议不会绕过该审批。

## 消息信封

`POST /api/messages` 接受：

```json
{
  "projectId": "project-id",
  "from": "apix-director",
  "to": "employee-id",
  "type": "request",
  "idempotencyKey": "plan-step:123",
  "payload": { "instruction": "检查实现" },
  "taskId": "optional-task-id",
  "conversationId": "optional-conversation-id",
  "timeoutMs": 120000,
  "maxRetries": 3,
  "priority": "normal"
}
```

`type` 可为 `request`、`response`、`event`、`artifact_ref`、`cancel`。返回的 `id` 是消息 ID。请求默认以自身 ID 为 `correlation_id`；回复必须设置 `replyTo` 为原请求 ID，Control Plane 继承原请求的 `correlation_id`。`GET /api/messages/thread?projectId=...&correlationId=...&agentId=...` 查询交互链。同项目同 `idempotencyKey` 再次发送时返回原消息，不会重复入队。

## Mailbox 与状态

创建项目、注册员工时自动建立 mailbox。`apix-director` 和 `system` 是内置 mailbox；员工 mailbox 随员工启用状态生效。可使用 `GET /api/mailboxes?projectId=...` 查看。

| 操作 | HTTP | 状态变化 |
| --- | --- | --- |
| 发送 | `POST /api/messages` | `queued` 或 `rejected` |
| 领取 | `GET /api/messages?projectId=...&agentId=...` | `queued → delivered` |
| 确认处理 | `POST /api/messages/:id/ack` | `delivered → processing` |
| 完成 | `POST /api/messages/:id/complete` | `processing → completed` |
| 失败并重试 | `POST /api/messages/:id/nack` | `processing → queued` 或 `failed` |
| Director 拦截 | `POST /api/messages/:id/reject` | 活跃状态 → `rejected` |

状态变更写入 `agent_message_events`。`ack` 会记录一次处理尝试；`nack` 使用指数退避（最高 60 秒），超过 `maxRetries` 后失败。消息过期时变为 `expired`，不再投递。每次领取和读取事件前都会检查过期消息。服务重启后，队列和事件仍在 SQLite 中。

## 实时事件流

`GET /api/events/stream?projectId=...&agentId=...` 使用 SSE。事件含数据库自增 ID、事件类型、项目、消息 ID、行为者、时间和 payload。客户端可用 `Last-Event-ID` 请求头或 `after` 参数从上次位置继续读取；服务每 15 秒发送心跳。员工只接收其参与的消息事件，Director 能监督项目消息和锁事件。

任务运行状态变化会产生 `agent.status` 事件；消息和锁操作分别产生 `message.*`、`director.intercepted` 与 `lock.*` 事件。

## 权限与监督

消息只能在当前项目的 mailbox 之间发送，关联任务和对话也必须属于该项目。员工只可领取自己的 mailbox，并读取自己收发的消息；只有原请求的收件人能回复。Director 可查看、拦截项目消息，也可释放项目资源锁。确定性策略会拦截员工请求直接启动 Agent、执行高风险文件操作，以及向 Director 发送包含敏感执行意图的请求。拦截原因写入消息和事件日志。

新协调流程为每个托管 Run 发放短期凭据，员工使用 `Authorization: Bearer <APIX_AGENT_TOKEN>` 调用 `/api/agent/team`、`/api/agent/messages` 和 `/api/agent/messages/:id/ack|complete|nack`。项目、发送者和任务从凭据推导；确认消息时额外检查项目。数据库只存 token 哈希，Run 结束后凭据失效。旧管理 HTTP API 仍采用可信本机模式，不能把其中自报的 `agentId` 当作强身份验证；部署到多用户或非本机网络前还需要管理端认证。Director 的规则拦截也不是操作系统级隔离。

## 上下文预算与交付物

单条消息 payload 上限为 24,000 UTF-8 字节，可使用更小的 `maxContextChars`。任务启动时，当前任务指令优先；前置交付物、对话任务记忆、对话历史、项目记忆和项目档案依次填充 30,000 字符上下文预算。超出时记录 `context.truncated` 运行事件，包括省略条数和预算。

Agent 运行结束会保存 `agent-response` artifact，并自动向 Director 发送包含交付物引用的回复。引用记录 artifact ID、SHA-256 摘要、摘要片段和来源任务。`POST /api/messages/:id/attachments` 可附加同项目 artifact；Control Plane 校验项目和可选 digest。消息不会复制完整 artifact 内容。

经用户批准的任务启动时，Director 自动写入一条关联该任务的 `request`，交给执行员工的 mailbox 并记录确认处理。实际完整指令仍通过 Pi/Codex 运行适配器发送。运行结束时员工结果以 `response` 回复该请求；有输出时附加 artifact 引用，从而在同一 `correlation_id` 下查看派发与交付。

## 文件与资源锁

`POST /api/locks/acquire` 需要 `projectId`、`agentId`、`resourceType`、`resourceKey`，可设置 `taskId` 和 `ttlMs`。锁类型为 `file`、`directory`、`repository`、`worktree`、`resource`。同项目同资源只能有一个未过期租约。持有者可调用 `/api/locks/:id/renew` 与 `/api/locks/:id/release`；Director 可强制释放。`POST /api/locks` 可查询活跃锁。锁到期后可重新获取。

锁是 ApiX 内的协作租约。现有 Pi/Codex CLI 可直接访问工作目录，外部进程也不会自动遵守锁。需要强制文件隔离时，应继续使用独立 worktree 或操作系统权限，并让运行适配器在执行文件操作前检查租约。
