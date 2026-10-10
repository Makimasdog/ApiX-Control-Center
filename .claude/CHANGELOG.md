# ApiX Control Center - 变更日志

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
