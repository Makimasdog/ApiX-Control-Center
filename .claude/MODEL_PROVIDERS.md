# ApiX 模型提供商配置指南

## 概述

ApiX 管理者 Agent 现已支持多种主流 AI 模型平台，包括国内外主流提供商。本文档说明如何配置和使用不同的模型。

## 支持的模型平台

### 🇨🇳 国内平台

#### 1. DeepSeek 深度求索
- **API 端点**: `https://api.deepseek.com/v1`
- **环境变量**: `DEEPSEEK_API_KEY`
- **支持模型**:
  - `deepseek-chat` - 通用对话模型，64K 上下文
  - `deepseek-coder` - 代码专用模型，64K 上下文
  - `deepseek-reasoner` (R1) - 推理增强模型，64K 上下文
- **获取 API Key**: https://platform.deepseek.com/

#### 2. 阿里云百炼 (通义千问)
- **API 端点**: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **环境变量**: `DASHSCOPE_API_KEY`
- **支持模型**:
  - `qwen-max` - 最强模型，32K 上下文
  - `qwen-plus` - 增强版，32K 上下文
  - `qwen-turbo` - 快速版，8K 上下文
  - `qwen-coder-plus` - 代码专用，32K 上下文
- **获取 API Key**: https://dashscope.console.aliyun.com/

#### 3. 火山引擎豆包 (字节跳动)
- **API 端点**: `https://ark.cn-beijing.volces.com/api/v3`
- **环境变量**: `DOUBAO_API_KEY`
- **支持模型**:
  - `doubao-pro-32k` - 专业版 32K
  - `doubao-pro-128k` - 专业版 128K
  - `doubao-lite-32k` - 轻量版 32K
- **获取 API Key**: https://console.volcengine.com/ark

#### 4. 智谱 AI (GLM)
- **API 端点**: `https://open.bigmodel.cn/api/paas/v4`
- **环境变量**: `ZHIPU_API_KEY`
- **支持模型**:
  - `glm-4-plus` - GLM-4 增强版
  - `glm-4-air` - GLM-4 轻量版
  - `glm-4-flash` - GLM-4 极速版
- **获取 API Key**: https://open.bigmodel.cn/

#### 5. 月之暗面 (Kimi)
- **API 端点**: `https://api.moonshot.cn/v1`
- **环境变量**: `MOONSHOT_API_KEY`
- **支持模型**:
  - `moonshot-v1-8k` - 8K 上下文
  - `moonshot-v1-32k` - 32K 上下文
  - `moonshot-v1-128k` - 128K 长文本
- **获取 API Key**: https://platform.moonshot.cn/

### 🌍 国际平台

#### 6. OpenAI
- **API 端点**: `https://api.openai.com/v1`
- **环境变量**: `OPENAI_API_KEY`
- **支持模型**:
  - `gpt-4o` - GPT-4 Omni 多模态旗舰
  - `gpt-4o-mini` - GPT-4o 轻量版
  - `o1` - 推理增强模型
  - `o1-mini` - 推理增强轻量版
- **获取 API Key**: https://platform.openai.com/

#### 7. Anthropic Claude
- **API 端点**: `https://api.anthropic.com`
- **环境变量**: `ANTHROPIC_API_KEY`
- **支持模型**:
  - `claude-opus-5-5` - 最强模型
  - `claude-sonnet-5-5` - 平衡版
  - `claude-haiku-5-5` - 快速版
- **获取 API Key**: https://console.anthropic.com/

### 💻 本地模型

#### 8. Ollama (本地)
- **API 端点**: `http://127.0.0.1:11434/v1`
- **无需 API Key**
- **常用模型**:
  - `qwen2.5:32b` - 通义千问 2.5
  - `deepseek-r1:32b` - DeepSeek R1
  - `llama3.3:70b` - Meta Llama 3.3
- **安装**: https://ollama.com/

#### 9. LM Studio (本地)
- **API 端点**: `http://127.0.0.1:1234/v1`
- **无需 API Key**
- **使用当前加载的模型**
- **下载**: https://lmstudio.ai/

## 配置步骤

### 方法一：通过 Web 界面配置

1. 访问 `http://localhost:4173/`
2. 进入「协调器」页面
3. 找到「ApiX 的推理模型」配置区域
4. 选择模型平台（如 DeepSeek）
5. 选择具体模型（如 deepseek-chat）
6. 确认 API Key 环境变量名
7. 点击「保存模型配置」

### 方法二：设置环境变量

在启动 ApiX 之前设置对应的环境变量：

**Windows (PowerShell)**:
```powershell
$env:DEEPSEEK_API_KEY = "sk-xxxxx"
npm start
```

**Windows (cmd)**:
```cmd
set DEEPSEEK_API_KEY=sk-xxxxx
npm start
```

**Linux/Mac**:
```bash
export DEEPSEEK_API_KEY="sk-xxxxx"
npm start
```

**或创建 .env 文件**:
```env
DEEPSEEK_API_KEY=sk-xxxxx
DASHSCOPE_API_KEY=sk-xxxxx
DOUBAO_API_KEY=xxxxx
```

### 方法三：自定义 URL

如果需要使用代理或自建服务：

1. 在界面中选择「自定义 URL」
2. 输入自定义 API URL（如 `http://proxy.example.com/v1`）
3. 输入模型 ID
4. 选择 API 类型（通常为 OpenAI Chat Completions）
5. 输入 API Key 环境变量名（可选）

## 使用示例

### 示例 1：使用 DeepSeek 作为 ApiX 推理底座

```bash
# 1. 设置环境变量
export DEEPSEEK_API_KEY="sk-your-key-here"

# 2. 启动服务
npm start

# 3. 在界面配置
# - 选择平台: DeepSeek 深度求索
# - 选择模型: deepseek-chat
# - 保存配置
```

### 示例 2：使用阿里云通义千问

```bash
# 1. 设置环境变量
export DASHSCOPE_API_KEY="sk-your-key-here"

# 2. 启动服务
npm start

# 3. 在界面配置
# - 选择平台: 阿里云百炼 (通义千问)
# - 选择模型: qwen-max
# - 保存配置
```

### 示例 3：使用本地 Ollama

```bash
# 1. 启动 Ollama 服务
ollama serve

# 2. 拉取模型
ollama pull qwen2.5:32b

# 3. 在界面配置
# - 选择平台: Ollama (本地)
# - 选择模型: qwen2.5:32b
# - 保存配置（无需 API Key）
```

## 价格对比参考

| 平台 | 模型 | 输入价格 (¥/百万token) | 输出价格 (¥/百万token) |
|------|------|------------------------|------------------------|
| DeepSeek | deepseek-chat | 1 | 2 |
| DeepSeek | deepseek-coder | 1 | 2 |
| 阿里云 | qwen-max | 20 | 60 |
| 阿里云 | qwen-plus | 4 | 12 |
| 火山引擎 | doubao-pro-32k | 0.8 | 2 |
| 智谱 | glm-4-plus | 50 | 50 |
| 月之暗面 | moonshot-v1-32k | 12 | 12 |
| OpenAI | gpt-4o | 14 | 42 |
| OpenAI | gpt-4o-mini | 1 | 3 |
| Ollama | 本地模型 | 免费 | 免费 |

*价格仅供参考，请以各平台官方最新定价为准*

## 性能建议

### 适合 ApiX 管理者的模型选择

- **推荐**: DeepSeek Chat / Reasoner - 性价比高，推理能力强
- **备选**: 通义千问 qwen-plus - 稳定可靠，中等价格
- **高性能**: GPT-4o / Claude Opus - 最强能力，价格较高
- **本地**: Qwen 2.5 32B - 免费，适合开发测试

### 员工 Agent 建议

员工 Agent (Pi, Codex, Claude 等) 使用各自独立的配置，不受此处设置影响。

## 故障排查

### 问题 1: 保存配置后无效果

**解决方案**:
- 确认环境变量已正确设置
- 重启 ApiX 服务
- 检查环境变量名是否正确（大小写敏感）

### 问题 2: 连接本地模型失败

**解决方案**:
- 确认 Ollama/LM Studio 服务正在运行
- 检查端口是否正确（Ollama: 11434, LM Studio: 1234）
- 确认模型已下载并加载

### 问题 3: API Key 错误

**解决方案**:
- 检查 API Key 格式是否正确
- 确认 API Key 未过期且有足够额度
- 检查环境变量是否在服务启动前设置

### 问题 4: 网络连接失败

**解决方案**:
- 检查网络连接
- 如果在国内，某些国际平台可能需要代理
- 使用自定义 URL 配置代理服务器

## API 类型说明

- **OpenAI Chat Completions**: 适用于大多数兼容 OpenAI API 的服务
- **OpenAI Responses**: 适用于特定 OpenAI 响应格式
- **Anthropic Messages**: 仅用于 Anthropic Claude 官方 API

## 安全建议

1. **不要在代码中硬编码 API Key**
2. **使用环境变量或 .env 文件存储密钥**
3. **将 .env 文件添加到 .gitignore**
4. **定期轮换 API Key**
5. **监控 API 使用量和费用**

## 技术实现

新增文件：
- `src/model-providers.ts` - 模型提供商配置定义
- `.claude/MODEL_PROVIDERS.md` - 本文档

修改文件：
- `web/coordinator.ts` - 添加模型选择界面
- `coordinator.css` - 添加样式支持

## 更新日志

**2026-10-10**
- 初始版本
- 支持 9 大模型平台
- 支持自定义 URL 配置
- 添加本地模型支持

---

由 Claude Sonnet 5 开发和维护  
最后更新: 2026-10-10
