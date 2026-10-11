/**
 * 模型提供商配置
 * 支持主流国内外 AI 模型接入
 */

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiType: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  requiresApiKey: boolean;
  defaultApiKeyEnv?: string;
  models: ModelOption[];
  description?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  contextWindow?: number;
  description?: string;
}

/**
 * 预定义的模型提供商配置
 */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiType: 'openai-completions',
    requiresApiKey: true,
    defaultApiKeyEnv: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek 深度求索 - 高性价比推理模型',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        contextWindow: 64000,
        description: '通用对话模型，适合大多数场景'
      },
      {
        id: 'deepseek-coder',
        name: 'DeepSeek Coder',
        contextWindow: 64000,
        description: '代码专用模型，编程任务性能更优'
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner (R1)',
        contextWindow: 64000,
        description: '推理增强模型，复杂逻辑任务表现更好'
      }
    ]
  },
  {
    id: 'dashscope',
    name: '阿里云百炼 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiType: 'openai-completions',
    requiresApiKey: true,
    defaultApiKeyEnv: 'DASHSCOPE_API_KEY',
    description: '阿里云通义千问系列模型',
    models: [
      {
        id: 'qwen-max',
        name: 'Qwen Max',
        contextWindow: 32000,
        description: '通义千问最强模型'
      },
      {
        id: 'qwen-plus',
        name: 'Qwen Plus',
        contextWindow: 32000,
        description: '通义千问增强版'
      },
      {
        id: 'qwen-turbo',
        name: 'Qwen Turbo',
        contextWindow: 8000,
        description: '通义千问快速版'
      },
      {
        id: 'qwen-coder-plus',
        name: 'Qwen Coder Plus',
        contextWindow: 32000,
        description: '通义千问代码专用模型'
      }
    ]
  },
  {
    id: 'doubao',
    name: '火山引擎豆包 (Doubao)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiType: 'openai-completions',
    requiresApiKey: true,
    defaultApiKeyEnv: 'DOUBAO_API_KEY',
    description: '字节跳动豆包系列模型',
    models: [
      {
        id: 'doubao-pro-32k',
        name: 'Doubao Pro 32K',
        contextWindow: 32000,
        description: '豆包专业版 32K 上下文'
      },
      {
        id: 'doubao-pro-128k',
        name: 'Doubao Pro 128K',
        contextWindow: 128000,
        description: '豆包专业版 128K 上下文'
      },
      {
        id: 'doubao-lite-32k',
        name: 'Doubao Lite 32K',
        contextWindow: 32000,
        description: '豆包轻量版 32K 上下文'
      }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiType: 'openai-completions',
    requiresApiKey: true,
    defaultApiKeyEnv: 'OPENAI_API_KEY',
    description: 'OpenAI GPT 系列模型',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        description: 'GPT-4 Omni 多模态旗舰模型'
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        contextWindow: 128000,
        description: 'GPT-4o 轻量版，速度更快'
      },
      {
        id: 'o1',
        name: 'o1',
        contextWindow: 200000,
        description: '推理增强模型'
      },
      {
        id: 'o1-mini',
        name: 'o1 Mini',
        contextWindow: 128000,
        description: '推理增强轻量版'
      }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiType: 'anthropic-messages',
    requiresApiKey: true,
    defaultApiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Anthropic Claude 系列模型',
    models: [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        contextWindow: 200000,
        description: 'Claude 最强模型'
      },
      {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        contextWindow: 200000,
        description: 'Claude 平衡版'
      },
      {
        id: 'claude-haiku-5-5',
        name: 'Claude Haiku 5.5',
        contextWindow: 200000,
        description: 'Claude 快速版'
      }
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiType: 'openai-completions',
    requiresApiKey: true,
    defaultApiKeyEnv: 'ZHIPU_API_KEY',
    description: '智谱清言 GLM 系列模型',
    models: [
      {
        id: 'glm-4-plus',
        name: 'GLM-4 Plus',
        contextWindow: 128000,
        description: 'GLM-4 增强版'
      },
      {
        id: 'glm-4-air',
        name: 'GLM-4 Air',
        contextWindow: 128000,
        description: 'GLM-4 轻量版'
      },
      {
        id: 'glm-4-flash',
        name: 'GLM-4 Flash',
        contextWindow: 128000,
        description: 'GLM-4 极速版'
      }
    ]
  },
  {
    id: 'moonshot',
    name: '月之暗面 (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiType: 'openai-completions',
    requiresApiKey: true,
    defaultApiKeyEnv: 'MOONSHOT_API_KEY',
    description: 'Kimi 系列长文本模型',
    models: [
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot v1 8K',
        contextWindow: 8000,
        description: 'Kimi 基础版 8K'
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot v1 32K',
        contextWindow: 32000,
        description: 'Kimi 标准版 32K'
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Moonshot v1 128K',
        contextWindow: 128000,
        description: 'Kimi 长文本版 128K'
      }
    ]
  },
  {
    id: 'local-ollama',
    name: 'Ollama (本地)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiType: 'openai-completions',
    requiresApiKey: false,
    description: '本地 Ollama 模型服务',
    models: [
      {
        id: 'qwen2.5:32b',
        name: 'Qwen 2.5 32B',
        description: '通义千问 2.5 32B 参数'
      },
      {
        id: 'deepseek-r1:32b',
        name: 'DeepSeek R1 32B',
        description: 'DeepSeek R1 32B 参数'
      },
      {
        id: 'llama3.3:70b',
        name: 'Llama 3.3 70B',
        description: 'Meta Llama 3.3 70B 参数'
      }
    ]
  },
  {
    id: 'local-lm-studio',
    name: 'LM Studio (本地)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiType: 'openai-completions',
    requiresApiKey: false,
    description: '本地 LM Studio 模型服务',
    models: [
      {
        id: 'local-model',
        name: '当前加载的模型',
        description: 'LM Studio 当前运行的本地模型'
      }
    ]
  }
];

/**
 * 根据 provider ID 获取配置
 */
export function getProviderConfig(providerId: string): ProviderConfig | undefined {
  return BUILTIN_PROVIDERS.find(p => p.id === providerId);
}

export function isLoopbackModelUrl(baseUrl: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname.toLowerCase());
}

/**
 * 验证模型配置
 */
export function validateModelConfig(config: {
  provider: string;
  model: string;
  baseUrl?: string;
  apiType: string;
  apiKeyEnv?: string;
}): { valid: boolean; error?: string } {
  if (config.provider.length > 100 || config.model.length > 200 || config.provider.startsWith('-') || config.model.startsWith('-')) {
    return { valid: false, error: '模型配置无效' };
  }
  if (config.baseUrl && config.baseUrl.length > 1000) {
    return { valid: false, error: 'API URL 过长（最大 1000 字符）' };
  }
  // 自定义 URL 模式
  if (config.baseUrl) {
    try {
      const url = new URL(config.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { valid: false, error: '仅支持 HTTP/HTTPS 协议' };
      }
      if (url.username || url.password || url.search || url.hash) {
        return { valid: false, error: 'URL 不应包含认证信息、查询参数或锚点' };
      }
      if (!config.model) {
        return { valid: false, error: '自定义 URL 模式必须指定模型 ID' };
      }
    } catch {
      return { valid: false, error: 'URL 格式无效' };
    }
  }

  // 验证 API 类型
  const validApiTypes = ['openai-completions', 'openai-responses', 'anthropic-messages'];
  if (!validApiTypes.includes(config.apiType)) {
    return { valid: false, error: 'API 类型无效' };
  }

  // 验证 API Key 环境变量名
  if (config.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(config.apiKeyEnv)) {
    return { valid: false, error: 'API Key 环境变量名必须以大写字母或下划线开头，只能包含大写字母、数字和下划线。例如：DEEPSEEK_API_KEY' };
  }

  // 检查远程 URL 是否需要 API Key
  if (config.baseUrl && !isLoopbackModelUrl(config.baseUrl)) {
    if (!config.apiKeyEnv) {
      return { valid: false, error: '远程模型服务必须配置 API Key 环境变量' };
    }
  }

  return { valid: true };
}

/**
 * 生成模型配置的显示名称
 */
export function getModelDisplayName(providerId: string, modelId: string): string {
  const provider = getProviderConfig(providerId);
  if (!provider) return modelId;

  const model = provider.models.find(m => m.id === modelId);
  return model ? `${provider.name} · ${model.name}` : `${provider.name} · ${modelId}`;
}
