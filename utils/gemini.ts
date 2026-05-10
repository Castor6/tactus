/**
 * Google Gemini API native implementation
 * Uses the generativelanguage.googleapis.com REST API with SSE streaming
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

// ============ Gemini Types ============

interface GeminiTextPart {
  text: string;
}

interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
  thoughtSignature?: string;
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

type GeminiPart = GeminiTextPart | GeminiInlineDataPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

interface GeminiContent {
  role: 'user' | 'model' | 'tool';
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: GeminiTextPart[];
  };
  tools?: GeminiTool[];
  toolConfig?: {
    functionCallingConfig: {
      mode: string;
    };
  };
  generationConfig?: {
    maxOutputTokens?: number;
  };
}

interface GeminiSafetyRating {
  category: string;
  probability: string;
  blocked?: boolean;
}

interface GeminiCandidate {
  content?: {
    role: string;
    parts?: GeminiPart[];
  };
  finishReason?: string;
  safetyRatings?: GeminiSafetyRating[];
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: GeminiSafetyRating[];
  };
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

interface GeminiModelInfo {
  name: string;
  displayName: string;
  description?: string;
  supportedGenerationMethods?: string[];
}

// ============ SSE Parser ============

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Split by newlines and process data lines
    const lines = buffer.split('\n');
    buffer = lines.pop()!; // Keep incomplete last line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data && data !== '[DONE]') {
          yield data;
        }
      } else if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5);
        if (data && data !== '[DONE]') {
          yield data;
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6);
      if (data && data !== '[DONE]') {
        yield data;
      }
    } else if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5);
      if (data && data !== '[DONE]') {
        yield data;
      }
    }
  }
}

// ============ Message Conversion ============

function convertUserContent(content: ApiMessageContent): GeminiPart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!content || !Array.isArray(content)) return [];

  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
    } else if (part.type === 'image_url') {
      const dataUrl = part.image_url.url;
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    }
  }

  return parts;
}

function convertToGeminiContents(
  messages: ApiMessage[],
): { systemInstruction: string; contents: GeminiContent[] } {
  let systemInstruction = '';
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = typeof msg.content === 'string' ? msg.content : '';
      continue;
    }

    if (msg.role === 'user') {
      const parts = convertUserContent(msg.content);
      if (parts.length > 0) {
        contents.push({ role: 'user', parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];

      // Text content
      if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        parts.push({ text: msg.content });
      }

      // Function calls
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          const fcPart: GeminiFunctionCallPart = {
            functionCall: {
              name: sanitizeFunctionNameForGemini(tc.function.name),
              args,
            },
          };
          // Preserve thought signature for Gemini 2.5+/3.x thinking models
          const thoughtSig = geminiThoughtSignatureMap.get(tc.id);
          if (thoughtSig) {
            fcPart.thoughtSignature = thoughtSig;
          }
          parts.push(fcPart);
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Function responses go as tool messages with functionResponse parts
      const functionResponsePart: GeminiFunctionResponsePart = {
        functionResponse: {
          name: sanitizeFunctionNameForGemini(msg.name || ''),
          response: {
            result: typeof msg.content === 'string' ? msg.content : '',
          },
        },
      };

      // Group consecutive tool results into a single tool message
      const lastContent = contents[contents.length - 1];
      if (
        lastContent &&
        lastContent.role === 'tool' &&
        lastContent.parts.length > 0 &&
        'functionResponse' in lastContent.parts[0]
      ) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({
          role: 'tool',
          parts: [functionResponsePart],
        });
      }
      continue;
    }
  }

  return { systemInstruction, contents };
}

/**
 * Gemini only supports a subset of JSON Schema properties in function declarations.
 * Recursively strip unsupported properties to avoid 400 errors.
 */
const GEMINI_SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'description', 'properties', 'required', 'items', 'enum', 'nullable',
]);

function sanitizeSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);

  const cleaned: Record<string, any> = {};
  for (const key of Object.keys(schema)) {
    if (!GEMINI_SUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (key === 'properties' && typeof schema[key] === 'object') {
      const cleanedProps: Record<string, any> = {};
      for (const [propName, propValue] of Object.entries(schema[key])) {
        cleanedProps[propName] = sanitizeSchemaForGemini(propValue);
      }
      cleaned[key] = cleanedProps;
    } else if (key === 'items' && typeof schema[key] === 'object') {
      cleaned[key] = sanitizeSchemaForGemini(schema[key]);
    } else {
      cleaned[key] = schema[key];
    }
  }

  return cleaned;
}

/**
 * Gemini function names only support letters, numbers, and underscores.
 * Sanitize names (e.g. MCP tool names with hyphens) and maintain a mapping
 * so we can resolve them back to original names when processing responses.
 */
let geminiToolNameMap: Map<string, string> = new Map();
let geminiThoughtSignatureMap: Map<string, string> = new Map();

function sanitizeFunctionNameForGemini(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function resolveGeminiToolName(name: string): string {
  return geminiToolNameMap.get(name) || name;
}

function convertToGeminiTools(tools: FunctionTool[]): GeminiTool[] {
  geminiToolNameMap = new Map();

  const declarations: GeminiFunctionDeclaration[] = tools.map((t) => {
    const originalName = t.function.name;
    const safeName = sanitizeFunctionNameForGemini(originalName);
    if (safeName !== originalName) {
      geminiToolNameMap.set(safeName, originalName);
    }

    const decl: GeminiFunctionDeclaration = {
      name: safeName,
      description: t.function.description,
    };
    // Only include parameters if there are actual properties
    if (t.function.parameters && Object.keys(t.function.parameters.properties || {}).length > 0) {
      decl.parameters = sanitizeSchemaForGemini(t.function.parameters);
    }
    return decl;
  });

  return [{ functionDeclarations: declarations }];
}

// ============ Error Handling ============

const GEMINI_ERROR_MAP: Record<string, { code: string; retryable: boolean }> = {
  INVALID_ARGUMENT: { code: 'INVALID_REQUEST', retryable: false },
  FAILED_PRECONDITION: { code: 'INVALID_REQUEST', retryable: false },
  NOT_FOUND: { code: 'MODEL_NOT_FOUND', retryable: false },
  PERMISSION_DENIED: { code: 'AUTH_ERROR', retryable: false },
  UNAUTHENTICATED: { code: 'AUTH_ERROR', retryable: false },
  RESOURCE_EXHAUSTED: { code: 'RATE_LIMIT', retryable: true },
  INTERNAL: { code: 'SERVER_ERROR', retryable: true },
  UNAVAILABLE: { code: 'SERVER_ERROR', retryable: true },
  DEADLINE_EXCEEDED: { code: 'TIMEOUT', retryable: true },
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
  SAFETY_BLOCKED: '内容被安全过滤器拦截，请修改输入内容后重试',
  TOOL_PARSE_ERROR: '工具调用参数解析失败，已达最大重试次数',
  TOOL_EXECUTION_ERROR: '工具执行失败，已达最大重试次数',
  TOOL_CALL_LIMIT_EXCEEDED: '工具调用次数已达上限，请调整设置后重试',
  USER_ABORTED: '已终止本次生成',
  UNKNOWN: '发生未知错误，请稍后重试',
};

function parseGeminiError(status: number, body: any): ApiError {
  if (body?.error) {
    const errorStatus = body.error.status || '';
    const mapped = GEMINI_ERROR_MAP[errorStatus];
    if (mapped) {
      // Check for quota-specific messages
      const msg = (body.error.message || '').toLowerCase();
      if (mapped.code === 'RATE_LIMIT' && (msg.includes('quota') || msg.includes('billing'))) {
        return new ApiError(ERROR_MESSAGES['QUOTA_EXCEEDED'], 'QUOTA_EXCEEDED', false);
      }
      return new ApiError(
        ERROR_MESSAGES[mapped.code] || body.error.message,
        mapped.code,
        mapped.retryable,
      );
    }
  }

  // Fall back to HTTP status code
  if (status === 400) {
    return new ApiError(ERROR_MESSAGES['INVALID_REQUEST'], 'INVALID_REQUEST', false);
  }
  if (status === 401 || status === 403) {
    return new ApiError(ERROR_MESSAGES['AUTH_ERROR'], 'AUTH_ERROR', false);
  }
  if (status === 404) {
    return new ApiError(ERROR_MESSAGES['MODEL_NOT_FOUND'], 'MODEL_NOT_FOUND', false);
  }
  if (status === 429) {
    return new ApiError(ERROR_MESSAGES['RATE_LIMIT'], 'RATE_LIMIT', true);
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

// Check if response was blocked by safety filters
function checkSafetyBlock(chunk: GeminiStreamChunk): string | null {
  // Check prompt-level blocking
  if (chunk.promptFeedback?.blockReason) {
    return `Prompt blocked: ${chunk.promptFeedback.blockReason}`;
  }

  // Check candidate-level safety blocking
  if (chunk.candidates) {
    for (const candidate of chunk.candidates) {
      if (candidate.finishReason === 'SAFETY') {
        const blockedCategories = (candidate.safetyRatings || [])
          .filter(r => r.blocked || r.probability === 'HIGH')
          .map(r => r.category.replace('HARM_CATEGORY_', ''))
          .join(', ');
        return blockedCategories
          ? `Safety filter triggered: ${blockedCategories}`
          : 'Response blocked by safety filters';
      }
    }
  }

  return null;
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

function resolveGeminiBaseUrl(baseUrl: string): string {
  const url = baseUrl.trim();
  if (!url) return 'https://generativelanguage.googleapis.com/v1beta';
  // Check if user explicitly wants to skip version prefix (trailing slash)
  const skipVersion = url.endsWith('/');
  // Strip known OpenAI-compatible suffixes (from legacy config)
  let cleaned = url.replace(/\/v1beta\/openai\/?$/i, '');
  cleaned = cleaned.replace(/\/v1\/?$/i, '');
  // Remove trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');
  return skipVersion ? cleaned : cleaned + '/v1beta';
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

export async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<{ id: string; name?: string }[]> {
  const base = resolveGeminiBaseUrl(baseUrl);
  try {
    const response = await fetch(`${base}/models`, {
      headers: {
        'x-goog-api-key': apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const models: { id: string; name?: string }[] = [];

    if (data.models && Array.isArray(data.models)) {
      for (const model of data.models as GeminiModelInfo[]) {
        // Include models that support content generation,
        // or all models if supportedGenerationMethods is not provided (some proxies strip this field)
        if (!model.supportedGenerationMethods || model.supportedGenerationMethods.includes('generateContent')) {
          // Model name is like "models/gemini-2.0-flash", extract just the model ID
          const id = model.name.replace(/^models\//, '');
          models.push({
            id,
            name: model.displayName || id,
          });
        }
      }
    }

    return models;
  } catch (error) {
    console.error('Error fetching Gemini models:', error);
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

export async function* streamChatGemini(
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

  const baseUrl = resolveGeminiBaseUrl(provider.baseUrl);

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
  const geminiTools = tools.length > 0 ? convertToGeminiTools(tools) : undefined;

  let iteration = 0;
  let currentMessages = [...apiMessages];
  let toolCallRetryCount = 0;
  const maxToolCallRetries = 3;
  let executedToolCallCount = 0;
  geminiThoughtSignatureMap = new Map();

  while (iteration < maxIterations) {
    ensureNotAborted();
    iteration++;

    // Convert messages to Gemini format
    const { systemInstruction, contents } = convertToGeminiContents(currentMessages);

    const requestBody: GeminiRequest = {
      contents,
      generationConfig: {
        maxOutputTokens: 8192,
      },
    };

    if (systemInstruction) {
      requestBody.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    if (geminiTools && geminiTools.length > 0) {
      requestBody.tools = geminiTools;
      requestBody.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO',
        },
      };
    }

    // API call with retry
    let response: Response | null = null;
    let lastError: ApiError | null = null;

    const model = provider.selectedModel;
    const streamUrl = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`;

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
        response = await fetch(streamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': provider.apiKey,
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
          lastError = parseGeminiError(response.status, errorBody);

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
    let functionCallCounter = 0;

    try {
      const reader = response.body!.getReader();

      for await (const data of parseSSEStream(reader)) {
        ensureNotAborted();

        let chunk: GeminiStreamChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // Skip malformed JSON
        }

        // Check for inline errors
        if (chunk.error) {
          const apiError = parseGeminiError(chunk.error.code, { error: chunk.error });
          yield { type: 'error', error: apiError, retrying: false, attempt: retryConfig.maxRetries };
          throw apiError;
        }

        // Check for safety blocking
        const safetyMessage = checkSafetyBlock(chunk);
        if (safetyMessage) {
          const apiError = new ApiError(
            `${ERROR_MESSAGES['SAFETY_BLOCKED']}\n${safetyMessage}`,
            'SAFETY_BLOCKED',
            false,
          );
          yield { type: 'error', error: apiError, retrying: false, attempt: retryConfig.maxRetries };
          throw apiError;
        }

        // Process candidates
        if (chunk.candidates) {
          for (const candidate of chunk.candidates) {
            if (!candidate.content?.parts) continue;

            for (const part of candidate.content.parts) {
              // Text content
              if ('text' in part && part.text) {
                fullContent += part.text;
                yield { type: 'content', content: part.text };
              }

              // Function call
              if ('functionCall' in part && part.functionCall) {
                functionCallCounter++;
                const fc = part.functionCall;
                const tcId = `gemini-fc-${functionCallCounter}-${Date.now()}`;
                toolCalls.push({
                  id: tcId,
                  name: resolveGeminiToolName(fc.name),
                  arguments: JSON.stringify(fc.args || {}),
                });
                // Preserve thought signature for Gemini 2.5+/3.x thinking models
                if ('thoughtSignature' in part && part.thoughtSignature) {
                  geminiThoughtSignatureMap.set(tcId, part.thoughtSignature);
                }
              }
            }

            // Check for non-safety finish reasons that indicate issues
            if (candidate.finishReason === 'MAX_TOKENS') {
              // Content was truncated but not an error - just continue
              console.warn('[Gemini] Response truncated due to MAX_TOKENS');
            } else if (candidate.finishReason === 'RECITATION') {
              console.warn('[Gemini] Response stopped due to recitation filter');
            }
          }
        }
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

      // Build assistant message (internal format for context tracking)
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

export async function* streamChatGeminiSimple(
  provider: AIProvider,
  messages: ChatMessage[],
  pageContent?: string,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
): AsyncGenerator<string, void, unknown> {
  const baseUrl = resolveGeminiBaseUrl(provider.baseUrl);
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

  const { systemInstruction, contents } = convertToGeminiContents(apiMessages);

  const requestBody: GeminiRequest = {
    contents,
    generationConfig: {
      maxOutputTokens: 8192,
    },
  };

  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const model = provider.selectedModel;
  const streamUrl = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`;

  // API call with retry
  let response: Response | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), retryConfig.timeout);

    try {
      response = await fetch(streamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': provider.apiKey,
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
        const apiError = parseGeminiError(response.status, errorBody);

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
    for await (const data of parseSSEStream(reader)) {
      let chunk: GeminiStreamChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      // Check for safety blocking
      const safetyMessage = checkSafetyBlock(chunk);
      if (safetyMessage) {
        throw new ApiError(
          `${ERROR_MESSAGES['SAFETY_BLOCKED']}\n${safetyMessage}`,
          'SAFETY_BLOCKED',
          false,
        );
      }

      if (chunk.candidates) {
        for (const candidate of chunk.candidates) {
          if (!candidate.content?.parts) continue;
          for (const part of candidate.content.parts) {
            if ('text' in part && part.text) {
              yield part.text;
            }
          }
        }
      }
    }
  } catch (streamError) {
    if (streamError instanceof ApiError) throw streamError;
    throw new ApiError(ERROR_MESSAGES['UNKNOWN'], 'UNKNOWN', false, streamError);
  }
}
