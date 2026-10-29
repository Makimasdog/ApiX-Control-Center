# ApiX 模型配置验证说明

## 问题描述

用户在配置模型时遇到 "自定义模型配置无效" 错误信息，但不清楚具体是什么问题。

## 已修复

现在错误信息会提供具体的验证失败原因：

### 1. API Key 环境变量格式验证

**要求**: 环境变量名必须符合 Shell 变量命名规范
- ✅ 必须以大写字母或下划线开头 (`A-Z` 或 `_`)
- ✅ 只能包含大写字母、数字和下划线 (`A-Z0-9_`)

**正确示例**:
```
DEEPSEEK_API_KEY
OPENAI_API_KEY
_MY_API_KEY
BAILIAN_API_KEY_2024
```

**错误示例** (会显示具体错误信息):
```
deepseek_api_key     ❌ 小写字母开头
api-key              ❌ 包含连字符
123_KEY              ❌ 数字开头
my.api.key           ❌ 包含点号
```

### 2. API URL 验证

**要求**:
- ✅ 必须是 `http://` 或 `https://`
- ✅ 不能包含用户名密码
- ✅ 不能包含查询参数 (`?key=value`)
- ✅ 不能包含锚点 (`#section`)
- ✅ 长度不超过 1000 字符

**错误时显示**: "自定义 URL 或模型 ID 无效"

### 3. API Type 验证

**要求**: 必须是以下之一
- `openai-completions` - OpenAI 兼容接口
- `openai-responses` - OpenAI Responses 格式
- `anthropic-messages` - Anthropic Messages API

**错误时显示**: "API 类型无效"

### 4. 本地模型支持

Ollama 和 LM Studio 等本地模型**不需要** API Key：
- ✅ 环境变量字段可以留空
- ✅ 不会触发验证错误

## 使用示例

### DeepSeek 配置

```json
{
  "provider": "apix-custom",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiType": "openai-completions",
  "apiKeyEnv": "DEEPSEEK_API_KEY"
}
```

启动前设置环境变量:
```bash
export DEEPSEEK_API_KEY="sk-xxx"
npm start
```

### Ollama 本地配置

```json
{
  "provider": "apix-custom",
  "model": "qwen2.5:32b",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiType": "openai-completions",
  "apiKeyEnv": ""
}
```

无需设置环境变量，直接启动。

## 测试验证

运行测试页面:
```bash
# 确保服务运行
npm start

# 在浏览器中打开
open http://127.0.0.1:4173/test-error-messages.html
```

或使用 curl 测试:
```bash
# 测试错误格式
curl -X POST http://127.0.0.1:4173/api/manager/settings \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "apix-custom",
    "model": "test",
    "baseUrl": "https://api.test.com/v1",
    "apiType": "openai-completions",
    "apiKeyEnv": "invalid_lowercase"
  }'

# 预期输出:
# {"error":"API Key 环境变量名必须以大写字母或下划线开头，只能包含大写字母、数字和下划线。例如：DEEPSEEK_API_KEY"}
```

## 更新内容

**文件**: `src/coordinator.ts`
**行号**: 330-332

将原来的通用错误信息:
```typescript
throw new Error('自定义模型配置无效');
```

改为三个具体的验证错误:
```typescript
if (baseUrl.length > 1000)
  throw new Error('API URL 过长（最大 1000 字符）');
if (!['openai-completions','openai-responses','anthropic-messages'].includes(apiType))
  throw new Error('API 类型无效');
if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))
  throw new Error('API Key 环境变量名必须以大写字母或下划线开头，只能包含大写字母、数字和下划线。例如：DEEPSEEK_API_KEY');
```

## 提交说明

修复已编译并准备提交到分支 `codex/agent-provider-adapters`。
