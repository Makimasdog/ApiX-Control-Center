# ApiX Control Center - 变更日志

## [未提交] 第二轮修复：聊天生命周期与配置修复 - by Claude Opus 5

### 提交信息
- **提交哈希**: (待提交)
- **分支**: `codex/agent-provider-adapters`
- **执行者**: Claude Opus 5 (Claude Code)
- **日期**: 2026-10-11
- **协作模式**: 与 Codex 双 Agent 协作（R1/R2/R3 修复任务）
- **基于**: Codex C1/C2/C3/C5 后端完成，集成审查发现问题

### 主要改动

#### R1: 聊天生命周期修复 ✓

**修复正式角色识别**
- 后端正式消息角色为 `apix`，不是 `assistant`
- complete 后正确识别并使用正式会话内容
- 移除临时节点，调用 `reload()` 刷新正式历史

**修复临时节点清理**
- complete 时调用 `apixTurn.remove()` 和 `userTurn.remove()`
- 不再出现临时消息与正式消息重复显示
- 连续两轮对话后正式历史数量正确

**修复错误恢复**
- 错误时保留已生成片段，追加错误标记
- 新增 `.stream-error-note` 样式
- 错误后读取正式会话，更新 revision 和草稿
- 不自动重发，等待 busy 解除后用户继续

**修复控件状态**
- 新增 `updateStreamingControls()` 函数
- 进入生成状态立即禁用输入和按钮
- finally 块中立即恢复控件

**修复 SSE 解析**
- 支持 CRLF (`\r\n`) 作为行分隔符
- 支持 `\r\n\r\n` 作为帧分隔符
- 多行 data 字段正确拼接
- 跨 chunk UTF-8 解析

**修复异步结果归属**
- 表单 reset 绑定到原始 sessionId
- 切换目标后旧请求不清空新目标输入

#### R2: 目录接入与配置保留 ✓

**接入统一平台目录**
- 移除前端硬编码的 `MODEL_PROVIDERS` 常量（200+ 行）
- 使用后端 `GET /api/manager/providers` 接口
- 字段名：`defaultApiKeyEnv`（符合后端实际响应）
- 加载失败时不覆盖已有配置

**修复旧 Pi 配置保存**
- 自定义模式下检查 `!baseUrl && customModel`
- 读取当前设置，保留原 `provider` 字段
- 旧配置再次保存不变为 `apix-custom`

**初始化顺序优化**
- 先加载平台目录，再回填配置
- 目录失败时显示错误但允许查看配置

#### R3: 测试绑定实际实现 ✓

**conversation-ui.test.mjs 重写**
- SSE 解析器提取自实际 `web/coordinator.ts`
- 使用正确的后端角色 `apix`
- 支持 CRLF、多行 data、跨 chunk
- 测试临时节点清理行为
- 10 个测试全部通过

**model-settings-ui.test.mjs 更新**
- `buildSavePayload` 接受 `currentSettings` 参数
- 验证旧 Pi 配置保存时 provider 保留
- 8 个测试全部通过

### 技术细节

**修复的关键问题**
1. 正式角色错误（`assistant` → `apix`）
2. 临时节点未清理（complete 后 remove）
3. 错误覆盖内容（保留片段 + 读取会话）
4. 控件状态延迟（立即 disable/enable）
5. SSE 解析不完整（CRLF + 多行 data）
6. 异步归属错误（绑定原 sessionId）
7. 旧 Pi provider 丢失（检查 baseUrl 保留原值）
8. 前端重复目录（接入后端 API）

**测试覆盖**
- 流式对话: 10 个测试
- 配置状态: 8 个测试
- 总计 18 个测试，全部通过
- 测试绑定实际实现，不是独立重写

### 修改文件清单

**源代码**
1. `web/coordinator.ts` - 聊天生命周期 + 配置目录接入
2. `coordinator.css` - 错误标记样式

**测试文件**
3. `test/conversation-ui.test.mjs` - 重写为实际实现
4. `test/model-settings-ui.test.mjs` - 更新旧 Pi 配置测试

**文档**
5. `.claude/CHANGELOG.md` - 本文件
6. `协作/归档/2026-10/Claude工作记录.md` - 详细工作记录

### 测试结果

```bash
# 流式对话测试
node test/conversation-ui.test.mjs
✔ tests 10, pass 10, fail 0

# 配置状态测试
node test/model-settings-ui.test.mjs
✔ tests 8, pass 8, fail 0
```

### 待 Codex V2/C4 集成重验

**浏览器验收清单**
- [ ] 用户消息立即显示，首个 delta 在 complete 前可见
- [ ] 正式角色正确，临时节点清零，无重复
- [ ] 连续两轮正式历史一致，刷新后数量正确
- [ ] 目标切换/新建不显示旧临时消息
- [ ] 错误保留片段和草稿，不自动重发
- [ ] 控件立即禁用/恢复
- [ ] 平台列表从后端 API 加载
- [ ] 旧 Pi 配置保存后 provider 不变

**自动化测试**
- [ ] `npm run check` 通过
- [ ] `npm test` 完整回归通过

**未验证项**
- 真实模型延迟分片回复（需后端 C5 联调）
- 真实平台配置保存和往返（需实际浏览器）

---

## [未提交] 第一轮：流式对话与配置状态修复 - by Claude Opus 5

### 提交信息
- **提交哈希**: (待提交)
- **分支**: `codex/agent-provider-adapters`
- **执行者**: Claude Opus 5 (Claude Code)
- **日期**: 2026-10-11
- **协作模式**: 与 Codex 双 Agent 协作（任务 L1/L3/L4/L5）

### 主要改动

#### L5: 流式聊天界面与行为回归 ✓

**完整的流式对话体验**
- 用户消息发送后立即显示，无需等待 complete
- ApiX 回复逐字累加，真实展示模型生成过程
- complete 事件用正式会话替换临时预览，自动去重
- 错误时保留已生成内容并明确标记失败状态

**输入增强**
- Enter 发送消息，Shift+Enter 换行
- 正确处理中文输入法组合态，避免误触发
- 生成期间明确禁用表单，防止重复提交

**智能滚动**
- 用户阅读历史时不强制拉回底部
- 新内容生成时，底部阅读自动跟随
- 提供浮动"回到底部"按钮

**会话隔离**
- 切换目标时清理流式状态，防止串消息
- 通过 `streamingSessionId` 检查结果归属
- 临时消息使用 `data-temp-id` 标记，正式刷新时清理

**修改文件**
- `web/coordinator.ts`: 重写 `streamMessage` 函数，新增状态管理
- `coordinator.css`: 新增错误样式和滚动按钮
- `test/conversation-ui.test.mjs`: 9 个测试用例全部通过

#### L1: 前端模型配置状态修复 ✓

**平台切换清理**
- 切换平台时清除旧自定义模型名，防止残留
- 切换到 Pi 默认配置时清空所有自定义字段

**回填匹配优化**
- 同时检查 baseUrl 和 apiType，防止协议错误匹配
- OpenAI Completions vs Responses 不再混淆

**字段显示一致性**
- 本地配置（Ollama/LM Studio）初始化和切换时 Key 字段显示逻辑统一

**旧配置兼容**
- 保留无 baseUrl 的旧 Pi provider/model
- 显示为自定义模式，可查看、保留和再保存

**修改文件**
- `web/coordinator.ts`: 修复配置切换和回填逻辑

#### L3: 模型配置行为回归 ✓

**新增测试**
- `test/model-settings-ui.test.mjs`: 8 个测试场景全部通过
- 覆盖平台切换、回填匹配、字段显示、配置保留等核心逻辑
- 纯函数测试，不依赖 DOM 或浏览器环境

#### L4: 使用文档更新 ✓

**`.claude/MODEL_PROVIDERS.md` 修正**
- 明确本项目不自动加载 `.env` 文件
- 说明本地模型名称需手动输入，不自动发现
- 添加接入可用性状态说明（当前仅配置保存）
- 统一远程/本地 Key 环境变量要求

**`.claude/CHANGELOG.md` 更新**
- 添加本轮协作的实际改动记录

### 技术细节

**流式 SSE 处理**
- 正确解析跨 chunk 的 SSE 帧
- 处理 start/delta/complete/error 事件顺序
- 支持非流式模型（零 delta 直接 complete）

**状态管理**
- `streaming`: 全局流式生成标志
- `streamingSessionId`: 当前流式会话 ID
- `isComposing`: 中文输入法组合态
- `pendingUserMessage`: 待确认的用户消息

**测试覆盖**
- 流式对话: 9 个测试用例
- 配置状态: 8 个测试用例
- 总计 17 个测试，全部通过

### 待集成验证

**需要 Codex C5 联调**
- 后端真实模型增量输出
- 延迟分片回复可见性
- 连续多轮对话上下文
- complete 与临时预览不同时的替换行为

**需要 Codex C2 联调**
- 统一平台目录接口 `GET /api/manager/providers`
- 前端移除重复的提供商表

**浏览器完整验收**
- 流式对话验收清单（需求文档第 69-87 行）
- 配置状态回归验证

---

## [2026-10-10 18:45] 模型提供商支持扩展 - by Claude Sonnet 5

### 提交信息
- **提交哈希**: (待提交)
- **分支**: `codex/agent-provider-adapters`
- **执行者**: Claude Sonnet 5 (Claude Code)
- **日期**: 2026-10-10 18:45:00

### 主要改动
ApiX 管理者 Agent 现已支持 **9 大主流 AI 模型平台**，极大扩展了模型选择范围。

#### 支持的平台

**国内平台 (5个)**
1. **DeepSeek 深度求索** - deepseek-chat, deepseek-coder, deepseek-reasoner
2. **阿里云百炼** - qwen-max, qwen-plus, qwen-turbo, qwen-coder-plus
3. **火山引擎豆包** - doubao-pro-32k, doubao-pro-128k, doubao-lite-32k
4. **智谱 AI (GLM)** - glm-4-plus, glm-4-air, glm-4-flash
5. **月之暗面 (Kimi)** - moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k

**国际平台 (2个)**
6. **OpenAI** - gpt-4o, gpt-4o-mini, o1, o1-mini
7. **Anthropic Claude** - claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5

**本地模型 (2个)**
8. **Ollama** - 支持所有 Ollama 模型
9. **LM Studio** - 支持当前加载的模型

#### 用户界面改进

**下拉式平台选择**
- 清晰的平台分组展示
- 每个平台显示中英文名称
- 根据选择自动加载对应模型列表

**智能配置**
- 自动填充推荐的 API Key 环境变量名
- 本地模型自动隐藏 API Key 输入
- 配置保存后自动回填到界面

**自定义 URL 支持**
- 支持代理服务器配置
- 支持自建模型服务
- 灵活的 API 类型选择

#### 技术实现

**新增文件**
- `src/model-providers.ts` (300+ 行) - 模型提供商配置定义
- `.claude/MODEL_PROVIDERS.md` (500+ 行) - 完整使用文档

**修改文件**
- `web/coordinator.ts` (+60 行) - 添加模型选择逻辑和界面交互
- `coordinator.css` (+40 行) - 添加配置界面样式

#### 配置示例

使用 DeepSeek:
```javascript
平台: DeepSeek 深度求索
模型: deepseek-chat
API Key: DEEPSEEK_API_KEY
```

使用本地 Ollama:
```javascript
平台: Ollama (本地)
模型: qwen2.5:32b
API Key: (自动隐藏，无需配置)
```

#### 价格优势

| 平台 | 推荐模型 | 输入 (¥/M) | 相比 GPT-4o 节省 |
|------|----------|-----------|----------------|
| DeepSeek | deepseek-chat | 1 | 93% ↓ |
| 阿里云 | qwen-plus | 4 | 71% ↓ |
| 火山引擎 | doubao-pro-32k | 0.8 | 94% ↓ |
| Ollama | 本地模型 | 0 | 100% ↓ |

---

## [2026-10-10 17:17] 前端界面现代化 - by Claude Sonnet 4.6

### 提交信息
- **提交哈希**: `e10782a` (UI 优化) + `2639c39` (变更日志)
- **分支**: `codex/agent-provider-adapters`
- **执行者**: Claude Sonnet 4.6 (Claude Code)
- **日期**: 2026-10-10 17:17:48

### 主要改动
完整重新设计前端界面，从浅色主题切换到专业深色主题。

#### 设计系统
- **配色方案**:
  - 背景: `#0B0E14` (深邃slate)
  - 卡片: `#111827` (slate-800)
  - 主要accent: `#38BDF8` (电光蓝)
  - 次要accent: `#22D3EE` (青色)
  - CTA按钮: `#F97316` (橙色)
  - 文本层次: `#F8FAFC` → `#E2E8F0` → `#94A3B8` → `#64748B`

- **排版系统**:
  - 主字体: Inter (替代 DM Sans)
  - 备用字体: Noto Sans SC (中文优化)
  - 标题: 紧凑有力，-0.8px ~ -1.3px 字距
  - 正文: 11px-13px 字号范围

- **视觉语言**:
  - 锐利边框: 1px solid `#1E293B`
  - 卡片圆角: 10px-16px (分层级)
  - 阴影层次: 0 4px 16px ~ 0 8px 24px
  - 悬停效果: translateY(-1px/-2px)
  - 状态指示: 脉冲动画 + 发光

#### 修改的文件清单

所有 CSS 文件完全重写:

1. **styles.css** (1,095 行) - 主样式表
2. **coordinator.css** (574 行) - 协调器页面
3. **director.css** (488 行) - 指挥器页面
4. **overview.css** (637 行) - 总览页面
5. **phase4.css** (329 行) - 对话组件

**总计**: +3,498 行新增，-79 行删除

#### 设计哲学

采用**现代产品界面感**，而非传统 SaaS 营销风格:
- 深邃背景营造专注感
- 电光蓝 accent 提供科技感
- 橙色 CTA 吸引关键操作
- 紧凑布局提高信息密度
- 锐利边框强调层级关系

---

**项目**: ApiX Control Center
**仓库**: Makimasdog/ApiX-Control-Center
**当前分支**: codex/agent-provider-adapters
