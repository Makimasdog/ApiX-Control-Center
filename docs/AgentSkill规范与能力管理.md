# AgentSkill 规范与能力管理

## 清单与热加载

AgentSkill v1 使用 JSON 对象。必填字段为 schema（固定为 1）、id、version、name、description、operation、permissions。标识由小写字母、数字和连字符组成，以字母开头，长度 2–48。版本为三段数字。每份清单选择一个宿主操作，声明且仅声明该操作的权限。文件技能可设置项目相对 directory，默认是项目根目录。代码技能可通过 script 固定函数体，或在调用时接收 code。

```json
{
  "schema": 1,
  "id": "double",
  "version": "1.0.0",
  "name": "数值翻倍",
  "description": "返回输入 value 的两倍",
  "operation": "code.run",
  "permissions": ["sandbox.javascript"],
  "script": "return input.value * 2;"
}
```

项目清单保存在 APIX_DATA_DIR 的 agent-skills/<项目 ID 的 SHA-256>/<技能 ID>.json。列出技能、生成工具目录和执行前会读取当前清单。修改后的内容版本即时可见，无需重启。SQLite 授权绑定规范化清单的 SHA-256。变更权限、代码、目录或其他清单字段变化会产生新的内容版本，该版本须由所有者启用。格式错误或缺失的清单退出执行目录。能力中心的原有 Skill 参考资料机制仍走原入口。

## 操作与权限

| 操作 | 权限 | 参数与边界 |
| --- | --- | --- |
| file.read | workspace.read | path 指定项目相对文件路径。目标的实际路径须在授予的目录中，授权目录须为项目内的实际目录。沿用项目文件路径检查和读取上限。 |
| file.write | workspace.write | path、content。模型通过现有助手的写入证据、权限及交付检查执行。 |
| web.search | network.brave-search | query，最多 5 条公开网页结果。独立密钥为 APIX_SKILL_BRAVE_KEY，结果属于参考数据。请求会把查询发给 Brave Search。 |
| code.run | sandbox.javascript | code 为同步 JS 函数体，input 为 JSON 输入。有固定 script 时仅接收 input。QuickJS/WASM 每次使用独立上下文，限制 8 MiB、256 KiB 栈和约 150 ms 的解释执行时间。没有 Node、文件、网络、进程或模块加载接口。 |
| calendar.list | calendar.read | 可选 from、to，查询项目内起止时间重叠的前 100 条日程。 |
| calendar.add | calendar.write | title、startsAt、endsAt，时间使用含时区的 ISO 8601。 |
| calendar.remove | calendar.write | eventId，仅删除当前项目日程。 |

启用的技能以 skill_ 前缀加入助手目录，实际调用继承项目审批、允许名单及验证流程。外部消息渠道的纯对话窗口与技能目录隔离。项目日程存在本机 SQLite。第三方清单只能使用宿主声明的操作，加载清单时只读取 JSON。[QuickJS/WASM](https://github.com/justjake/quickjs-emscripten) · [Brave Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get)

## 所有者接口与界面

在「能力中心 → 管理 AgentSkill」选择项目，可按版本安装内置技能，导入 JSON，启用、禁用及卸载。首次安装须另行启用。更新已有清单时需要 expectedRevision，启用需提交当前 revision。

| 接口 | 请求 |
| --- | --- |
| GET /api/agent-skills/market?q= | 搜索内置市场清单 |
| GET /api/agent-skills/market/{id}/{version} | 读取指定版本 |
| GET /api/projects/{projectId}/agent-skills | 列出已安装清单、版本与启用状态 |
| POST /api/projects/{projectId}/agent-skills/install | {manifest, expectedRevision?} 或 {market:{id,version}, expectedRevision?} |
| POST /api/projects/{projectId}/agent-skills/{id}/enabled | {enabled, revision?}，启用时 revision 必填 |
| POST /api/projects/{projectId}/agent-skills/{id}/remove | 空 JSON 对象 |
| POST /api/projects/{projectId}/agent-skills/{id}/run | {revision,args}，所有者显式运行 |

市场提供版本化发现和安装接口，当前目录来自仓库内置清单。预留 SkillMarket 接口供未来来源替换。远端市场发布、第三方运行时和外部日历同步留待后续。已提交的网页查询受外部服务处理，撤回技能权限会阻止后续调用。

## 验收

执行 npm run build、npm run check 和 node --test --test-concurrency=1 test/personal-skill-core.test.mjs test/personal-skills-http.test.mjs。在能力中心安装目录版本，核对版本权限后启用，验证禁用、卸载和修改清单后重新授权。
