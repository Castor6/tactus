import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ChatMessage } from './db';
import { isVisionSupportedForModel, type AIProvider } from './storage';
import {
  getFilteredTools,
  generateContextPrompt,
  getToolStatusText,
  isMcpTool,
  parseMcpToolName,
  type FunctionTool,
  type ToolCall,
  type ToolResult,
  type SkillInfo,
  type Language,
} from './tools';
import type { McpTool } from './mcp';
import { streamChatAnthropic, streamChatAnthropicSimple, fetchAnthropicModels } from './anthropic';
import { streamChatGemini, streamChatGeminiSimple, fetchGeminiModels } from './gemini';

export interface ModelInfo {
  id: string;
  name?: string;
}

// ============ 容错机制配置 ============

export interface RetryConfig {
  maxRetries: number;      // 最大重试次数
  baseDelay: number;       // 基础延迟（毫秒）
  maxDelay: number;        // 最大延迟（毫秒）
  timeout: number;         // 请求超时（毫秒）
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  timeout: 60000,  // 60秒超时
};

// 错误类型分类
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// 友好的错误消息映射
const ERROR_MESSAGES: Record<string, string> = {
  'TIMEOUT': '请求超时，服务器响应太慢，请稍后重试',
  'NETWORK_ERROR': '网络连接失败，请检查网络后重试',
  'AUTH_ERROR': 'API 密钥无效或已过期，请检查配置',
  'RATE_LIMIT': '请求太频繁，已被限流，请稍后重试',
  'QUOTA_EXCEEDED': 'API 配额已用完，请检查账户余额',
  'MODEL_NOT_FOUND': '模型不存在或无权访问，请检查模型配置',
  'INVALID_REQUEST': '请求参数错误，请检查输入内容',
  'SERVER_ERROR': '服务器内部错误，请稍后重试',
  'TOOL_PARSE_ERROR': '工具调用参数解析失败，已达最大重试次数',
  'TOOL_EXECUTION_ERROR': '工具执行失败，已达最大重试次数',
  'TOOL_CALL_LIMIT_EXCEEDED': '工具调用次数已达上限，请调整设置后重试',
  'USER_ABORTED': '已终止本次生成',
  'UNKNOWN': '发生未知错误，请稍后重试',
};

// 解析错误并分类
function parseError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  // 超时错误
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError(ERROR_MESSAGES['TIMEOUT'], 'TIMEOUT', true, error);
  }

  // OpenAI SDK 错误
  if (error instanceof OpenAI.APIError) {
    const status = error.status;

    if (status === 401 || status === 403) {
      return new ApiError(ERROR_MESSAGES['AUTH_ERROR'], 'AUTH_ERROR', false, error);
    }
    if (status === 429) {
      // 检查是否是配额问题
      const message = error.message?.toLowerCase() || '';
      if (message.includes('quota') || message.includes('billing') || message.includes('insufficient')) {
        return new ApiError(ERROR_MESSAGES['QUOTA_EXCEEDED'], 'QUOTA_EXCEEDED', false, error);
      }
      return new ApiError(ERROR_MESSAGES['RATE_LIMIT'], 'RATE_LIMIT', true, error);
    }
    if (status === 404) {
      return new ApiError(ERROR_MESSAGES['MODEL_NOT_FOUND'], 'MODEL_NOT_FOUND', false, error);
    }
    if (status === 400) {
      return new ApiError(ERROR_MESSAGES['INVALID_REQUEST'], 'INVALID_REQUEST', false, error);
    }
    if (status && status >= 500) {
      return new ApiError(ERROR_MESSAGES['SERVER_ERROR'], 'SERVER_ERROR', true, error);
    }
  }

  // 网络错误
  if (error instanceof TypeError && (error.message.includes('fetch') || error.message.includes('network'))) {
    return new ApiError(ERROR_MESSAGES['NETWORK_ERROR'], 'NETWORK_ERROR', true, error);
  }

  // 通用错误处理
  const message = error instanceof Error ? error.message : String(error);

  // 尝试从错误消息中识别类型
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('timeout')) {
    return new ApiError(ERROR_MESSAGES['TIMEOUT'], 'TIMEOUT', true, error);
  }
  if (lowerMessage.includes('network') || lowerMessage.includes('econnrefused') || lowerMessage.includes('enotfound')) {
    return new ApiError(ERROR_MESSAGES['NETWORK_ERROR'], 'NETWORK_ERROR', true, error);
  }

  return new ApiError(ERROR_MESSAGES['UNKNOWN'], 'UNKNOWN', false, error);
}

// 延迟函数
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 计算指数退避延迟
function getRetryDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; // 添加随机抖动
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}

function createUserAbortError(originalError?: unknown): ApiError {
  return new ApiError(ERROR_MESSAGES['USER_ABORTED'], 'USER_ABORTED', false, originalError);
}

// 创建带超时的 AbortController
function createTimeoutController(timeout: number, externalSignal?: AbortSignal): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const handleExternalAbort = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', handleExternalAbort, { once: true });
    }
  }

  return {
    controller,
    clear: () => {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', handleExternalAbort);
      }
    },
  };
}

// API 消息类型
export interface ApiMessageTextPart {
  type: 'text';
  text: string;
}

export interface ApiMessageImagePart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type ApiMessageContent =
  | string
  | Array<ApiMessageTextPart | ApiMessageImagePart>
  | null;

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ApiMessageContent;
  reasoning?: string | null;  // 思维链内容（如 DeepSeek reasoning_content）
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

// 存储最后一次发送给模型的完整上下文，用于调试
let lastApiMessages: ApiMessage[] = [];

export function getLastApiMessages(): ApiMessage[] {
  return lastApiMessages;
}

export function setLastApiMessages(messages: ApiMessage[]) {
  lastApiMessages = messages;
}


// 解析 Base URL：
// - 以 "/" 结尾：按原样使用（不自动拼接 /v1）
// - 不以 "/" 结尾：自动补充 /v1（若已是 /v1 则保持不变）
function resolveBaseUrl(baseUrl: string): string {
  const url = baseUrl.trim();
  if (!url) return url;
  if (url.endsWith('/')) return url;
  if (/\/v1$/i.test(url)) return url;
  return `${url}/v1`;
}

// 创建 OpenAI 客户端
function createClient(provider: AIProvider): OpenAI {
  return new OpenAI({
    apiKey: provider.apiKey,
    baseURL: resolveBaseUrl(provider.baseUrl),
    dangerouslyAllowBrowser: true, // 浏览器扩展环境需要
    maxRetries: 0, // 禁用 SDK 内置重试，由代码层统一控制
  });
}

export async function fetchModels(baseUrl: string, apiKey: string, providerType?: string): Promise<ModelInfo[]> {
  // Anthropic: use GET /v1/models endpoint
  if (providerType === 'anthropic') {
    return await fetchAnthropicModels(baseUrl, apiKey);
  }

  // Gemini uses native model listing API
  if (providerType === 'gemini') {
    return await fetchGeminiModels(baseUrl, apiKey);
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: resolveBaseUrl(baseUrl),
      dangerouslyAllowBrowser: true,
    });

    const response = await client.models.list();
    return response.data.map(m => ({
      id: m.id,
      name: m.id,
    }));
  } catch (error) {
    console.error('Error fetching models:', error);
    return [];
  }
}

// 工具执行器类型
export type ToolExecutor = (toolCall: ToolCall) => Promise<ToolResult>;

export interface ChatContextConfig {
  sharePageContent?: boolean;
  skills?: SkillInfo[];
  mcpTools?: McpTool[];
  browserAutomationAvailable?: boolean;
  browserVisionAvailable?: boolean;
  pageInfo?: { domain: string; title: string; url?: string };
  language?: Language;
}

// Function Calling 配置
export interface FunctionCallingConfig {
  enableTools: boolean;
  toolExecutor?: ToolExecutor;
  maxIterations?: number;
  maxToolCalls?: number;
  abortSignal?: AbortSignal;
}

// 流式聊天事件类型
export type StreamEvent =
  | { type: 'content'; content: string }
  | { type: 'reasoning'; content: string }  // 思维链内容（如 DeepSeek reasoning_content）
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'thinking'; message: string }
  | { type: 'error'; error: ApiError; retrying: boolean; attempt: number }
  | { type: 'done' };

// 检查 JSON 对象字符串是否已经闭合（大括号匹配）
// 用于处理某些模型（如 GLM-4.7）对无参数工具重复返回 "{}" 的情况
function isJsonClosed(str: string): boolean {
  if (!str) return false;

  let braceCount = 0;
  let inString = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (char === '"' && str[i - 1] !== '\\') {
      inString = !inString;
    } else if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
    }
  }

  return braceCount === 0 && str.includes('{');
}

// 尝试修复不完整的 JSON（补全缺失的括号）
// 用于处理某些模型（如 GLM-4.7）在生成嵌套 JSON 时提前结束输出的情况
function tryFixIncompleteJson(str: string): string {
  if (!str) return str;

  // 先尝试直接解析，如果成功就不需要修复
  try {
    JSON.parse(str);
    return str;
  } catch {}

  // 计算缺失的括号
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '"' && str[i - 1] !== '\\') {
      inString = !inString;
    } else if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }
  }

  // 补全缺失的括号
  let fixed = str;
  while (bracketCount > 0) { fixed += ']'; bracketCount--; }
  while (braceCount > 0) { fixed += '}'; braceCount--; }

  // 验证补全后是否有效
  try {
    JSON.parse(fixed);
    console.log('[tryFixIncompleteJson] 成功修复不完整的 JSON:', str, '->', fixed);
    return fixed;
  } catch {
    // 补全后仍然无效，返回原字符串（让后续逻辑处理错误）
    return str;
  }
}

// 转换工具格式
function convertTools(tools: FunctionTool[]): ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

// 转换消息格式为 OpenAI SDK 格式
function convertToOpenAIMessages(messages: ApiMessage[]): ChatCompletionMessageParam[] {
  return messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: typeof m.content === 'string' ? m.content : '',
        tool_call_id: m.tool_call_id!,
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant' as const,
        content: typeof m.content === 'string' ? m.content : '',
        tool_calls: m.tool_calls,
      };
    }
    if (m.role === 'user') {
      return {
        role: 'user' as const,
        content: Array.isArray(m.content) ? m.content : (m.content || ''),
      };
    }
    if (m.role === 'system') {
      return {
        role: 'system' as const,
        content: typeof m.content === 'string' ? m.content : '',
      };
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: typeof m.content === 'string' ? m.content : '',
      };
    }
    return {
      role: 'user' as const,
      content: '',
    };
  });
}

function getQuotedText(message: Pick<ChatMessage, 'content' | 'quote'>): string {
  return message.quote ? `[Quote: "${message.quote}"]\n\n${message.content}` : message.content;
}

function buildUserMessageContent(
  message: Pick<ChatMessage, 'content' | 'quote' | 'images'>,
  allowImages: boolean,
): ApiMessageContent {
  const text = getQuotedText(message);
  if (!allowImages || !message.images?.length) {
    return text;
  }

  const parts: Array<ApiMessageTextPart | ApiMessageImagePart> = [];
  if (text.trim().length > 0) {
    parts.push({ type: 'text', text });
  }
  for (const image of message.images) {
    if (image.dataUrl) {
      parts.push({
        type: 'image_url',
        image_url: { url: image.dataUrl },
      });
    }
  }
  return parts;
}

function stripImageParts(content: ApiMessageContent): ApiMessageContent {
  if (!Array.isArray(content)) return content;
  const text = content
    .filter((part): part is ApiMessageTextPart => part.type === 'text')
    .map(part => part.text)
    .join('\n\n')
    .trim();
  return text;
}

function sanitizeMessagesForVision(messages: ApiMessage[], allowImages: boolean): ApiMessage[] {
  if (allowImages) return messages.map(message => ({ ...message }));
  return messages.map(message => {
    if (message.role !== 'user') return { ...message };
    return {
      ...message,
      content: stripImageParts(message.content),
    };
  });
}

export function appendToolResultMessages(
  currentMessages: ApiMessage[],
  toolCall: { id: string; name: string },
  result: ToolResult,
  deferredImageMessages?: ApiMessage[],
): void {
  currentMessages.push({
    role: 'tool',
    content: result.result,
    tool_call_id: toolCall.id,
    name: toolCall.name,
  });

  if (!result.images?.length) return;

  const imageMessages = deferredImageMessages ?? currentMessages;
  for (const image of result.images) {
    imageMessages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: image.description
            ? `工具 ${toolCall.name} 返回了一张图片：${image.description}`
            : `工具 ${toolCall.name} 返回了一张图片。`,
        },
        {
          type: 'image_url',
          image_url: { url: image.dataUrl },
        },
      ],
    });
  }
}


export async function* streamChat(
  provider: AIProvider,
  messages: ChatMessage[],
  context?: ChatContextConfig,
  config?: FunctionCallingConfig,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  previousApiMessages?: ApiMessage[]  // 新增：传入之前保存的完整 API 上下文
): AsyncGenerator<StreamEvent, void, unknown> {
  // Route to Anthropic implementation if provider type is 'anthropic'
  if (provider.providerType === 'anthropic') {
    yield* streamChatAnthropic(provider, messages, context, config, retryConfig, previousApiMessages);
    return;
  }

  // Route to native Gemini implementation if provider type is 'gemini'
  if (provider.providerType === 'gemini') {
    yield* streamChatGemini(provider, messages, context, config, retryConfig, previousApiMessages);
    return;
  }

  const enableTools = config?.enableTools ?? true;
  const toolExecutor = config?.toolExecutor;
  const maxIterations = config?.maxIterations || 5;
  const maxToolCalls = Math.max(1, config?.maxToolCalls || 100);
  const allowImages = isVisionSupportedForModel(provider, provider.selectedModel);
  const abortSignal = config?.abortSignal;
  const ensureNotAborted = () => {
    if (abortSignal?.aborted) {
      throw createUserAbortError();
    }
  };

  const client = createClient(provider);

  const basePrompt = `You are a helpful AI assistant. Always respond using Markdown format for better readability. Use:
- Headers (##, ###) for sections
- **bold** and *italic* for emphasis
- \`code\` for inline code and \`\`\` for code blocks with language specification
- Lists (- or 1.) for enumerations
- > for quotes
- Tables when presenting structured data`;

  const contextPrompt = generateContextPrompt(context);
  const systemMessage = `${basePrompt}\n\n${contextPrompt}`;

  // 构建初始消息
  let apiMessages: ApiMessage[];

  if (previousApiMessages && previousApiMessages.length > 0) {
    // 如果有之前保存的 API 上下文，使用它并更新 system 消息
    apiMessages = sanitizeMessagesForVision(previousApiMessages, allowImages);
    // 更新 system 消息（可能上下文有变化）
    if (apiMessages[0]?.role === 'system') {
      apiMessages[0].content = systemMessage;
    }
    // 添加新的用户消息（最后一条）
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === 'user') {
      apiMessages.push({
        role: 'user',
        content: buildUserMessageContent(lastMessage, allowImages),
      });
    }
  } else {
    // 没有之前的上下文，从 ChatMessage 构建
    apiMessages = [
      { role: 'system', content: systemMessage },
      ...messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.role === 'user' ? buildUserMessageContent(m, allowImages) : m.content,
      })),
    ];
  }

  lastApiMessages = [...apiMessages];

  // 获取过滤后的工具列表
  const tools = enableTools ? getFilteredTools(context) : [];
  const openaiTools = tools.length > 0 ? convertTools(tools) : undefined;

  let iteration = 0;
  let currentMessages = [...apiMessages];
  let toolCallRetryCount = 0; // 工具调用重试计数（包括参数解析错误）
  const maxToolCallRetries = 3; // 工具调用最大重试次数
  let executedToolCallCount = 0;

  while (iteration < maxIterations) {
    ensureNotAborted();
    iteration++;

    // 带重试的 API 调用
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      ensureNotAborted();
      const { controller, clear } = createTimeoutController(retryConfig.timeout, abortSignal);

      try {
        stream = await client.chat.completions.create({
          model: provider.selectedModel,
          messages: convertToOpenAIMessages(currentMessages),
          tools: openaiTools,
          tool_choice: openaiTools ? 'auto' : undefined,
          stream: true,
        }, {
          signal: controller.signal,
        });

        clear();
        lastError = null;
        break; // 成功，跳出重试循环

      } catch (error) {
        clear();
        if (abortSignal?.aborted) {
          throw createUserAbortError(error);
        }
        lastError = parseError(error);

        // 不可重试的错误，直接抛出
        if (!lastError.retryable) {
          yield { type: 'error', error: lastError, retrying: false, attempt };
          throw lastError;
        }

        // 已达最大重试次数
        if (attempt >= retryConfig.maxRetries) {
          yield { type: 'error', error: lastError, retrying: false, attempt };
          throw lastError;
        }

        // 通知正在重试
        const retryDelay = getRetryDelay(attempt, retryConfig);
        yield {
          type: 'error',
          error: lastError,
          retrying: true,
          attempt
        };
        yield {
          type: 'thinking',
          message: `请求失败，${Math.round(retryDelay / 1000)} 秒后重试 (${attempt + 1}/${retryConfig.maxRetries})...`
        };

        await delay(retryDelay);
        ensureNotAborted();
      }
    }

    // 如果没有成功获取 stream，抛出最后的错误
    if (!stream!) {
      throw lastError || new ApiError('未知错误', 'UNKNOWN', false);
    }

    let fullContent = '';
    let fullReasoning = '';  // 思维链内容（如 DeepSeek reasoning_content）

    // 工具调用收集器
    // 使用 id 作为主键来存储工具调用，这样更健壮
    //
    // 背景说明：
    // OpenAI 流式响应中，tool_calls 有两个标识字段：
    // - index: 流式传输时的"槽位编号"，用于拼接同一个工具调用的多个 chunks
    // - id: 工具调用的唯一标识符，用于后续提交工具执行结果时匹配
    //
    // 正常情况下，一个 index 只对应一个 id。但某些兼容层（如 newapi）
    // 可能在同一个 index 下返回多个不同 id 的工具调用，导致 arguments 被错误拼接。
    //
    // 解决方案：
    // 使用 Map<index, Map<id, toolCall>> 的双层结构，
    // 当同一个 index 出现新的 id 时，创建新的工具调用条目而不是累加 arguments。
    const toolCallsByIndex: Map<number, Map<string, { id: string; name: string; arguments: string }>> = new Map();

    // 流式读取响应（带错误处理）
    try {
      for await (const chunk of stream) {
        ensureNotAborted();
        const delta = chunk.choices[0]?.delta;

        // 处理思维链内容（DeepSeek reasoning_content）
        // 某些模型（如 DeepSeek-R1）会在 delta 中返回 reasoning_content 字段
        const reasoningContent = (delta as any)?.reasoning_content;
        if (reasoningContent) {
          fullReasoning += reasoningContent;
          yield { type: 'reasoning', content: reasoningContent };
        }

        // 处理文本内容
        if (delta?.content) {
          fullContent += delta.content;
          yield { type: 'content', content: delta.content };
        }

        // 处理工具调用增量
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;

            // 确保该 index 的 Map 存在
            if (!toolCallsByIndex.has(index)) {
              toolCallsByIndex.set(index, new Map());
            }
            const indexMap = toolCallsByIndex.get(index)!;

            // 如果有新的 id，说明是新的工具调用（即使 index 相同）
            // 这处理了某些 API 兼容层在同一 index 下返回多个工具调用的情况
            if (tc.id) {
              if (!indexMap.has(tc.id)) {
                // 新的工具调用
                indexMap.set(tc.id, {
                  id: tc.id,
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                });
              } else {
                // 已存在的工具调用，更新信息
                const existing = indexMap.get(tc.id)!;
                if (tc.function?.name) {
                  existing.name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  // 检查现有 arguments 是否已经是闭合的 JSON
                  // 这处理了 GLM-4.7 等模型对无参数工具返回多次 "{}" 的情况
                  if (!isJsonClosed(existing.arguments)) {
                    existing.arguments += tc.function.arguments;
                  }
                }
              }
            } else {
              // 没有 id 的 chunk，找到该 index 下最后一个工具调用并累加
              // （正常流式传输时，后续 chunks 不会重复发送 id）
              const entries = Array.from(indexMap.values());
              if (entries.length > 0) {
                const lastEntry = entries[entries.length - 1];
                if (tc.function?.name) {
                  lastEntry.name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  // 同样检查是否已闭合
                  if (!isJsonClosed(lastEntry.arguments)) {
                    lastEntry.arguments += tc.function.arguments;
                  }
                }
              }
            }
          }
        }
      }
    } catch (streamError) {
      if (abortSignal?.aborted) {
        throw createUserAbortError(streamError);
      }
      const apiError = parseError(streamError);
      yield { type: 'error', error: apiError, retrying: false, attempt: retryConfig.maxRetries };
      throw apiError;
    }

    // 将双层 Map 扁平化为工具调用数组
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    for (const indexMap of toolCallsByIndex.values()) {
      for (const tc of indexMap.values()) {
        if (tc.id && tc.name) {
          toolCalls.push(tc);
        }
      }
    }

    // 检查是否有工具调用
    if (toolCalls.length > 0 && toolExecutor) {
      ensureNotAborted();
      // 尝试修复不完整的 JSON 参数（处理某些模型截断输出的情况）
      for (const tc of toolCalls) {
        if (tc.arguments) {
          tc.arguments = tryFixIncompleteJson(tc.arguments);
        }
      }

      // 检查是否有参数解析错误
      // 如果有解析错误，剔除本次模型回复，直接重试
      let hasParseError = false;
      for (const tc of toolCalls) {
        try {
          if (tc.arguments) JSON.parse(tc.arguments);
        } catch (e) {
          hasParseError = true;
          console.error('[Tool Args Parse Error] 工具参数解析失败，将剔除本次模型回复并重试');
          console.error('  工具名:', tc.name);
          console.error('  原始参数:', tc.arguments);
          console.error('  错误:', e);
          break;
        }
      }

      // 如果有解析错误，剔除本次模型回复，直接重试
      if (hasParseError) {
        toolCallRetryCount++;
        console.warn(`[Retry] 检测到工具参数解析错误，剔除模型回复后重试 (${toolCallRetryCount}/${maxToolCallRetries})`);

        // 检查是否超过最大重试次数
        if (toolCallRetryCount >= maxToolCallRetries) {
          const error = new ApiError(
            `工具调用失败：参数解析错误，已重试 ${maxToolCallRetries} 次`,
            'TOOL_PARSE_ERROR',
            false
          );
          yield { type: 'error', error, retrying: false, attempt: toolCallRetryCount };
          throw error;
        }

        yield {
          type: 'thinking',
          message: `工具参数解析错误，正在重试 (${toolCallRetryCount}/${maxToolCallRetries})...`
        };

        // 不添加本次 assistant 消息到 currentMessages，直接重试
        continue;
      }

      // 构建 assistant 消息（包含 tool_calls 和 reasoning）
      const assistantToolCalls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

      const assistantMessageIndex = currentMessages.length;
      currentMessages.push({
        role: 'assistant',
        content: fullContent || null,
        reasoning: fullReasoning || null,
        tool_calls: assistantToolCalls,
      });

      // 实时更新 API 上下文（记录 assistant 的 tool_calls）
      lastApiMessages = [...currentMessages];

      // 执行每个工具调用
      let hasExecutionError = false;
      const deferredImageMessages: ApiMessage[] = [];
      for (const tc of toolCalls) {
        ensureNotAborted();
        if (executedToolCallCount >= maxToolCalls) {
          const error = new ApiError(
            `工具调用次数已达上限（${maxToolCalls}）`,
            'TOOL_CALL_LIMIT_EXCEEDED',
            false
          );
          yield { type: 'error', error, retrying: false, attempt: executedToolCallCount };
          throw error;
        }

        const parsedArgs = JSON.parse(tc.arguments || '{}');

        const toolCall: ToolCall = {
          id: tc.id,
          name: tc.name,
          arguments: parsedArgs,
        };

        yield { type: 'tool_call', toolCall };
        yield { type: 'thinking', message: getToolStatusText(tc.name, parsedArgs) };

        // 执行工具
        executedToolCallCount++;
        const result = await toolExecutor(toolCall);
        yield { type: 'tool_result', result };

        // 检查工具执行是否失败
        if (!result.success) {
          hasExecutionError = true;
          toolCallRetryCount++;
          console.warn(`[Tool Execution Error] 工具执行失败 (${toolCallRetryCount}/${maxToolCallRetries})`);
          console.error('  工具名:', tc.name);
          console.error('  错误:', result.result);

          // 检查是否超过最大重试次数
          if (toolCallRetryCount >= maxToolCallRetries) {
            const error = new ApiError(
              `工具执行失败：${result.result}，已重试 ${maxToolCallRetries} 次`,
              'TOOL_EXECUTION_ERROR',
              false
            );
            yield { type: 'error', error, retrying: false, attempt: toolCallRetryCount };
            throw error;
          }

          yield {
            type: 'thinking',
            message: `工具执行失败，正在重试 (${toolCallRetryCount}/${maxToolCallRetries})...`
          };

          // 跳出工具执行循环，准备重试
          break;
        }

        appendToolResultMessages(currentMessages, { id: tc.id, name: tc.name }, result, deferredImageMessages);

        // 实时更新 API 上下文（记录 tool result）
        lastApiMessages = [...currentMessages];
      }

      // 如果有执行错误，剔除本次 assistant 消息，重试
      if (hasExecutionError) {
        // 移除刚才添加的 assistant 消息和已执行工具结果
        currentMessages.splice(assistantMessageIndex);
        continue;
      }

      if (deferredImageMessages.length > 0) {
        currentMessages.push(...deferredImageMessages);
        lastApiMessages = [...currentMessages];
      }

      // 继续下一轮迭代
      continue;
    }

    // 没有工具调用，结束循环
    lastApiMessages = [...currentMessages];
    if (fullContent || fullReasoning) {
      lastApiMessages.push({
        role: 'assistant',
        content: fullContent || null,
        reasoning: fullReasoning || null,
      });
    }
    break;
  }

  yield { type: 'done' };
}

// 简化版本的流式聊天（向后兼容，不使用工具）
export async function* streamChatSimple(
  provider: AIProvider,
  messages: ChatMessage[],
  pageContent?: string,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): AsyncGenerator<string, void, unknown> {
  // Route to Anthropic implementation if provider type is 'anthropic'
  if (provider.providerType === 'anthropic') {
    yield* streamChatAnthropicSimple(provider, messages, pageContent, retryConfig);
    return;
  }

  // Route to native Gemini implementation if provider type is 'gemini'
  if (provider.providerType === 'gemini') {
    yield* streamChatGeminiSimple(provider, messages, pageContent, retryConfig);
    return;
  }

  const client = createClient(provider);
  const allowImages = isVisionSupportedForModel(provider, provider.selectedModel);

  const basePrompt = `You are a helpful AI assistant. Always respond using Markdown format for better readability. Use:
- Headers (##, ###) for sections
- **bold** and *italic* for emphasis
- \`code\` for inline code and \`\`\` for code blocks with language specification
- Lists (- or 1.) for enumerations
- > for quotes
- Tables when presenting structured data`;

  const systemMessage = pageContent
    ? `${basePrompt}\n\nThe user is viewing a webpage with the following content:\n\n${pageContent}\n\nAnswer questions based on this context when relevant.`
    : basePrompt;

  const apiMessages: ApiMessage[] = [
    { role: 'system', content: systemMessage },
    ...messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'user' ? buildUserMessageContent(m, allowImages) : m.content,
    })),
  ];

  lastApiMessages = apiMessages;

  // 带重试的 API 调用
  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    const { controller, clear } = createTimeoutController(retryConfig.timeout);

    try {
      stream = await client.chat.completions.create({
        model: provider.selectedModel,
        messages: convertToOpenAIMessages(apiMessages),
        stream: true,
      }, {
        signal: controller.signal,
      });

      clear();
      break;

    } catch (error) {
      clear();
      const apiError = parseError(error);

      if (!apiError.retryable || attempt >= retryConfig.maxRetries) {
        throw apiError;
      }

      const retryDelay = getRetryDelay(attempt, retryConfig);
      await delay(retryDelay);
    }
  }

  if (!stream!) {
    throw new ApiError('未知错误', 'UNKNOWN', false);
  }

  try {
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } catch (streamError) {
    throw parseError(streamError);
  }
}
