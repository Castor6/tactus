/**
 * Anthropic (Claude) API implementation
 * Handles native Anthropic Messages API with SSE streaming
 */

import type { ApiMessage, ApiMessageContent, StreamEvent, RetryConfig, ApiError as ApiErrorType } from './api';
import { ApiError } from './api';
import type { AIProvider } from './storage';
import type { FunctionTool, ToolCall, ToolResult, SkillInfo, Language } from './tools';
import type { McpTool } from './mcp';
import {
  isVisionSupportedForModel,
} from './storage';
import {
  getFilteredTools,
  generateContextPrompt,
  getToolStatusText,
} from './tools';
import type { ChatMessage } from './db';

// ============ Anthropic Types ============

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  stream: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: string };
}

// ============ SSE Parser ============

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop()!;

    for (const eventStr of events) {
      if (!eventStr.trim()) continue;

      let eventType = '';
      let eventData = '';

      for (const line of eventStr.split('\n')) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          eventData += line.slice(6);
        } else if (line.startsWith('data:')) {
          eventData += line.slice(5);
        }
      }

      if (eventType && eventData) {
        yield { event: eventType, data: eventData };
      }
    }
  }
}

// ============ Message Conversion ============

function convertUserContent(content: ApiMessageContent): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  if (!content || !Array.isArray(content)) return '';

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const dataUrl = part.image_url.url;
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: match[1],
            data: match[2],
          },
        });
      }
    }
  }

  return blocks.length > 0 ? blocks : '';
}

function convertToAnthropicMessages(
  messages: ApiMessage[],
): { system: string; messages: AnthropicMessage[] } {
  let systemMessage = '';
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessage = typeof msg.content === 'string' ? msg.content : '';
      continue;
    }

    if (msg.role === 'user') {
      const content = convertUserContent(msg.content);
      if (content) {
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) && Array.isArray(content)) {
          (lastMsg.content as AnthropicContentBlock[]).push(...content);
        } else {
          anthropicMessages.push({ role: 'user', content });
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];

      if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        content.push({ type: 'text', text: msg.content });
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      if (content.length > 0) {
        anthropicMessages.push({ role: 'assistant', content });
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolResult: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id!,
        content: typeof msg.content === 'string' ? msg.content : '',
      };

      // Group consecutive tool results into a single user message
      const lastMsg = anthropicMessages[anthropicMessages.length - 1];
      if (
        lastMsg &&
        lastMsg.role === 'user' &&
        Array.isArray(lastMsg.content) &&
        lastMsg.content.length > 0 &&
        (lastMsg.content[0] as AnthropicContentBlock).type === 'tool_result'
      ) {
        (lastMsg.content as AnthropicContentBlock[]).push(toolResult);
      } else {
        anthropicMessages.push({
          role: 'user',
          content: [toolResult],
        });
      }
      continue;
    }
  }

  return { system: systemMessage, messages: anthropicMessages };
}

function convertToAnthropicTools(tools: FunctionTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ============ Error Handling ============

const ANTHROPIC_ERROR_MAP: Record<string, { code: string; retryable: boolean }> = {
  authentication_error: { code: 'AUTH_ERROR', retryable: false },
  permission_error: { code: 'AUTH_ERROR', retryable: false },
  invalid_request_error: { code: 'INVALID_REQUEST', retryable: false },
  not_found_error: { code: 'MODEL_NOT_FOUND', retryable: false },
  rate_limit_error: { code: 'RATE_LIMIT', retryable: true },
  api_error: { code: 'SERVER_ERROR', retryable: true },
  overloaded_error: { code: 'SERVER_ERROR', retryable: true },
};

const ERROR_MESSAGES: Record<string, string> = {
  TIMEOUT: '请求超时，服务器响应太慢，请稍后重试',
  NETWORK_ERROR: '网络连接失败，请检查网络后重试',
  AUTH_ERROR: 'API 密钥无效或已过期，请检查配置',
  RATE_LIMIT: '请求太频繁，已被限流，请稍后重试',
  QUOTA_EXCEEDED: 'API 配额已用完，请检查账户余额',
  MODEL_NOT_FOUND: '模型不存在或无权访问，请检查模型配置',
  INVALID_REQUEST: '请求参数错误，请检查输入内容',
  SERVER_ERROR: '服务器内部错误，请稍后重试',
  TOOL_PARSE_ERROR: '工具调用参数解析失败，已达最大重试次数',
  TOOL_EXECUTION_ERROR: '工具执行失败，已达最大重试次数',
  TOOL_CALL_LIMIT_EXCEEDED: '工具调用次数已达上限，请调整设置后重试',
  USER_ABORTED: '已终止本次生成',
  UNKNOWN: '发生未知错误，请稍后重试',
};

function parseAnthropicError(status: number, body: any): ApiError {
  if (body?.error) {
    const errorType = body.error.type || '';
    const mapped = ANTHROPIC_ERROR_MAP[errorType];
    if (mapped) {
      return new ApiError(
        ERROR_MESSAGES[mapped.code] || body.error.message,
        mapped.code,
        mapped.retryable,
      );
    }
    // Check for quota errors in the message
    const msg = (body.error.message || '').toLowerCase();
    if (msg.includes('quota') || msg.includes('billing') || msg.includes('credit')) {
      return new ApiError(ERROR_MESSAGES['QUOTA_EXCEEDED'], 'QUOTA_EXCEEDED', false);
    }
  }

  // Fall back to HTTP status code
  if (status === 401 || status === 403) {
    return new ApiError(ERROR_MESSAGES['AUTH_ERROR'], 'AUTH_ERROR', false);
  }
  if (status === 429) {
    return new ApiError(ERROR_MESSAGES['RATE_LIMIT'], 'RATE_LIMIT', true);
  }
  if (status === 404) {
    return new ApiError(ERROR_MESSAGES['MODEL_NOT_FOUND'], 'MODEL_NOT_FOUND', false);
  }
  if (status >= 500) {
    return new ApiError(ERROR_MESSAGES['SERVER_ERROR'], 'SERVER_ERROR', true);
  }

  return new ApiError(
    body?.error?.message || ERROR_MESSAGES['UNKNOWN'],
    'UNKNOWN',
    false,
  );
}

// ============ Helpers ============

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}

function createUserAbortError(originalError?: unknown): ApiError {
  return new ApiError(ERROR_MESSAGES['USER_ABORTED'], 'USER_ABORTED', false, originalError);
}

function resolveAnthropicBaseUrl(baseUrl: string): string {
  const url = baseUrl.trim();
  if (!url) return 'https://api.anthropic.com/v1';
  // Trailing slash = skip version prefix
  if (url.endsWith('/')) {
    return url.replace(/\/+$/, '');
  }
  return url + '/v1';
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

  const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
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
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
  return text;
}

function sanitizeMessagesForVision(messages: ApiMessage[], allowImages: boolean): ApiMessage[] {
  if (allowImages) return messages.map((message) => ({ ...message }));
  return messages.map((message) => {
    if (message.role !== 'user') return { ...message };
    return {
      ...message,
      content: stripImageParts(message.content),
    };
  });
}

// ============ Model Fetching ============

export async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<{ id: string; name?: string }[]> {
  const base = resolveAnthropicBaseUrl(baseUrl);
  try {
    const response = await fetch(`${base}/models?limit=100`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const models: { id: string; name?: string }[] = [];

    if (data.data && Array.isArray(data.data)) {
      for (const model of data.data) {
        models.push({
          id: model.id,
          name: model.display_name || model.id,
        });
      }
    }

    return models;
  } catch (error) {
    console.error('Error fetching Anthropic models:', error);
    throw error;
  }
}

// ============ Main Streaming Function ============

import { appendToolResultMessages, setLastApiMessages, type ChatContextConfig, type FunctionCallingConfig, type ToolExecutor } from './api';

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  timeout: 60000,
};

export async function* streamChatAnthropic(
  provider: AIProvider,
  messages: ChatMessage[],
  context?: ChatContextConfig,
  config?: FunctionCallingConfig,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  previousApiMessages?: ApiMessage[],
): AsyncGenerator<StreamEvent, void, unknown> {
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

  const baseUrl = resolveAnthropicBaseUrl(provider.baseUrl);

  const basePrompt = `You are a helpful AI assistant. Always respond using Markdown format for better readability. Use:
- Headers (##, ###) for sections
- **bold** and *italic* for emphasis
- \`code\` for inline code and \`\`\` for code blocks with language specification
- Lists (- or 1.) for enumerations
- > for quotes
- Tables when presenting structured data`;

  const contextPrompt = generateContextPrompt(context);
  const systemMessage = `${basePrompt}\n\n${contextPrompt}`;

  // Build initial messages
  let apiMessages: ApiMessage[];

  if (previousApiMessages && previousApiMessages.length > 0) {
    apiMessages = sanitizeMessagesForVision(previousApiMessages, allowImages);
    if (apiMessages[0]?.role === 'system') {
      apiMessages[0].content = systemMessage;
    }
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === 'user') {
      apiMessages.push({
        role: 'user',
        content: buildUserMessageContent(lastMessage, allowImages),
      });
    }
  } else {
    apiMessages = [
      { role: 'system', content: systemMessage },
      ...messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content:
          m.role === 'user' ? buildUserMessageContent(m, allowImages) : m.content,
      })),
    ];
  }

  setLastApiMessages([...apiMessages]);

  // Get filtered tools
  const tools = enableTools ? getFilteredTools(context) : [];
  const anthropicTools = tools.length > 0 ? convertToAnthropicTools(tools) : undefined;

  let iteration = 0;
  let currentMessages = [...apiMessages];
  let toolCallRetryCount = 0;
  const maxToolCallRetries = 3;
  let executedToolCallCount = 0;

  while (iteration < maxIterations) {
    ensureNotAborted();
    iteration++;

    // Convert messages to Anthropic format
    const { system, messages: anthropicMsgs } = convertToAnthropicMessages(currentMessages);

    const requestBody: AnthropicRequest = {
      model: provider.selectedModel,
      max_tokens: 8192,
      system: system || undefined,
      messages: anthropicMsgs,
      stream: true,
    };

    if (anthropicTools && anthropicTools.length > 0) {
      requestBody.tools = anthropicTools;
      requestBody.tool_choice = { type: 'auto' };
    }

    // API call with retry
    let response: Response | null = null;
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      ensureNotAborted();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), retryConfig.timeout);

      if (abortSignal) {
        if (abortSignal.aborted) {
          clearTimeout(timeoutId);
          throw createUserAbortError();
        }
        abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      try {
        response = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          let errorBody: any = {};
          try {
            errorBody = await response.json();
          } catch {}
          lastError = parseAnthropicError(response.status, errorBody);

          if (!lastError.retryable) {
            yield { type: 'error', error: lastError, retrying: false, attempt };
            throw lastError;
          }

          if (attempt >= retryConfig.maxRetries) {
            yield { type: 'error', error: lastError, retrying: false, attempt };
            throw lastError;
          }

          const retryDelay = getRetryDelay(attempt, retryConfig);
          yield { type: 'error', error: lastError, retrying: true, attempt };
          yield {
            type: 'thinking',
            message: `请求失败，${Math.round(retryDelay / 1000)} 秒后重试 (${attempt + 1}/${retryConfig.maxRetries})...`,
          };
          await delay(retryDelay);
          ensureNotAborted();
          continue;
        }

        lastError = null;
        break;
      } catch (error) {
        clearTimeout(timeoutId);

        if (abortSignal?.aborted) {
          throw createUserAbortError(error);
        }

        if (error instanceof ApiError) {
          throw error;
        }

        if (error instanceof DOMException && error.name === 'AbortError') {
          lastError = new ApiError(ERROR_MESSAGES['TIMEOUT'], 'TIMEOUT', true, error);
        } else if (error instanceof TypeError) {
          lastError = new ApiError(ERROR_MESSAGES['NETWORK_ERROR'], 'NETWORK_ERROR', true, error);
        } else {
          lastError = new ApiError(ERROR_MESSAGES['UNKNOWN'], 'UNKNOWN', false, error);
        }

        if (!lastError.retryable || attempt >= retryConfig.maxRetries) {
          yield { type: 'error', error: lastError, retrying: false, attempt };
          throw lastError;
        }

        const retryDelay = getRetryDelay(attempt, retryConfig);
        yield { type: 'error', error: lastError, retrying: true, attempt };
        yield {
          type: 'thinking',
          message: `请求失败，${Math.round(retryDelay / 1000)} 秒后重试 (${attempt + 1}/${retryConfig.maxRetries})...`,
        };
        await delay(retryDelay);
        ensureNotAborted();
      }
    }

    if (!response) {
      throw lastError || new ApiError('未知错误', 'UNKNOWN', false);
    }

    // Parse SSE stream
    let fullContent = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentToolIndex = -1;
    let currentToolId = '';
    let currentToolName = '';
    let currentToolArgs = '';

    try {
      const reader = response.body!.getReader();

      for await (const sseEvent of parseSSEStream(reader)) {
        ensureNotAborted();

        if (sseEvent.event === 'error') {
          let errorData: any;
          try {
            errorData = JSON.parse(sseEvent.data);
          } catch {}
          const apiError = parseAnthropicError(500, errorData);
          yield { type: 'error', error: apiError, retrying: false, attempt: retryConfig.maxRetries };
          throw apiError;
        }

        if (sseEvent.event === 'content_block_start') {
          const data = JSON.parse(sseEvent.data);
          const block = data.content_block;
          if (block?.type === 'tool_use') {
            currentToolIndex = data.index;
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolArgs = '';
          }
        }

        if (sseEvent.event === 'content_block_delta') {
          const data = JSON.parse(sseEvent.data);
          const delta = data.delta;

          if (delta?.type === 'text_delta' && delta.text) {
            fullContent += delta.text;
            yield { type: 'content', content: delta.text };
          }

          if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
            currentToolArgs += delta.partial_json;
          }
        }

        if (sseEvent.event === 'content_block_stop') {
          const data = JSON.parse(sseEvent.data);
          if (data.index === currentToolIndex && currentToolId) {
            toolCalls.push({
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolArgs || '{}',
            });
            currentToolIndex = -1;
            currentToolId = '';
            currentToolName = '';
            currentToolArgs = '';
          }
        }

        // message_stop is handled implicitly when the stream ends
      }
    } catch (streamError) {
      if (abortSignal?.aborted) {
        throw createUserAbortError(streamError);
      }
      if (streamError instanceof ApiError) {
        throw streamError;
      }
      const apiError = new ApiError(ERROR_MESSAGES['UNKNOWN'], 'UNKNOWN', false, streamError);
      yield { type: 'error', error: apiError, retrying: false, attempt: retryConfig.maxRetries };
      throw apiError;
    }

    // Handle tool calls
    if (toolCalls.length > 0 && toolExecutor) {
      ensureNotAborted();

      // Check for parse errors
      let hasParseError = false;
      for (const tc of toolCalls) {
        try {
          if (tc.arguments) JSON.parse(tc.arguments);
        } catch {
          hasParseError = true;
          break;
        }
      }

      if (hasParseError) {
        toolCallRetryCount++;
        if (toolCallRetryCount >= maxToolCallRetries) {
          const error = new ApiError(
            `工具调用失败：参数解析错误，已重试 ${maxToolCallRetries} 次`,
            'TOOL_PARSE_ERROR',
            false,
          );
          yield { type: 'error', error, retrying: false, attempt: toolCallRetryCount };
          throw error;
        }
        yield {
          type: 'thinking',
          message: `工具参数解析错误，正在重试 (${toolCallRetryCount}/${maxToolCallRetries})...`,
        };
        continue;
      }

      // Build assistant message (internal format)
      const assistantToolCalls = toolCalls.map((tc) => ({
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
        tool_calls: assistantToolCalls,
      });

      setLastApiMessages([...currentMessages]);

      // Execute each tool call
      let hasExecutionError = false;
      const deferredImageMessages: ApiMessage[] = [];
      for (const tc of toolCalls) {
        ensureNotAborted();
        if (executedToolCallCount >= maxToolCalls) {
          const error = new ApiError(
            `工具调用次数已达上限（${maxToolCalls}）`,
            'TOOL_CALL_LIMIT_EXCEEDED',
            false,
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

        executedToolCallCount++;
        const result = await toolExecutor(toolCall);
        yield { type: 'tool_result', result };

        if (!result.success) {
          hasExecutionError = true;
          toolCallRetryCount++;

          if (toolCallRetryCount >= maxToolCallRetries) {
            const error = new ApiError(
              `工具执行失败：${result.result}，已重试 ${maxToolCallRetries} 次`,
              'TOOL_EXECUTION_ERROR',
              false,
            );
            yield { type: 'error', error, retrying: false, attempt: toolCallRetryCount };
            throw error;
          }
          yield {
            type: 'thinking',
            message: `工具执行失败，正在重试 (${toolCallRetryCount}/${maxToolCallRetries})...`,
          };
          break;
        }

        appendToolResultMessages(currentMessages, { id: tc.id, name: tc.name }, result, deferredImageMessages);

        setLastApiMessages([...currentMessages]);
      }

      if (hasExecutionError) {
        currentMessages.splice(assistantMessageIndex);
        continue;
      }

      if (deferredImageMessages.length > 0) {
        currentMessages.push(...deferredImageMessages);
        setLastApiMessages([...currentMessages]);
      }

      continue;
    }

    // No tool calls - done
    setLastApiMessages([...currentMessages]);
    if (fullContent) {
      const lastMessages = [...currentMessages];
      lastMessages.push({
        role: 'assistant',
        content: fullContent,
      });
      setLastApiMessages(lastMessages);
    }
    break;
  }

  yield { type: 'done' };
}

// ============ Simple Streaming (no tools) ============

export async function* streamChatAnthropicSimple(
  provider: AIProvider,
  messages: ChatMessage[],
  pageContent?: string,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
): AsyncGenerator<string, void, unknown> {
  const baseUrl = resolveAnthropicBaseUrl(provider.baseUrl);
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
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'user' ? buildUserMessageContent(m, allowImages) : m.content,
    })),
  ];

  setLastApiMessages(apiMessages);

  const { system, messages: anthropicMsgs } = convertToAnthropicMessages(apiMessages);

  const requestBody: AnthropicRequest = {
    model: provider.selectedModel,
    max_tokens: 8192,
    system: system || undefined,
    messages: anthropicMsgs,
    stream: true,
  };

  // API call with retry
  let response: Response | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), retryConfig.timeout);

    try {
      response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorBody: any = {};
        try {
          errorBody = await response.json();
        } catch {}
        const apiError = parseAnthropicError(response.status, errorBody);

        if (!apiError.retryable || attempt >= retryConfig.maxRetries) {
          throw apiError;
        }

        const retryDelay = getRetryDelay(attempt, retryConfig);
        await delay(retryDelay);
        continue;
      }

      break;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ApiError) throw error;

      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError(ERROR_MESSAGES['TIMEOUT'], 'TIMEOUT', true, error);
      }

      if (error instanceof TypeError) {
        if (attempt >= retryConfig.maxRetries) {
          throw new ApiError(ERROR_MESSAGES['NETWORK_ERROR'], 'NETWORK_ERROR', true, error);
        }
        const retryDelay = getRetryDelay(attempt, retryConfig);
        await delay(retryDelay);
        continue;
      }

      throw new ApiError(ERROR_MESSAGES['UNKNOWN'], 'UNKNOWN', false, error);
    }
  }

  if (!response) {
    throw new ApiError('未知错误', 'UNKNOWN', false);
  }

  try {
    const reader = response.body!.getReader();
    for await (const sseEvent of parseSSEStream(reader)) {
      if (sseEvent.event === 'content_block_delta') {
        const data = JSON.parse(sseEvent.data);
        if (data.delta?.type === 'text_delta' && data.delta.text) {
          yield data.delta.text;
        }
      }
    }
  } catch (streamError) {
    if (streamError instanceof ApiError) throw streamError;
    throw new ApiError(ERROR_MESSAGES['UNKNOWN'], 'UNKNOWN', false, streamError);
  }
}
