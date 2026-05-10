<script setup lang="ts">
import { ref, shallowRef, triggerRef, onMounted, onUnmounted, nextTick, watch, computed } from 'vue';
import katex from 'katex';
import { Marked } from 'marked';
import {
  getAllProviders,
  saveProvider as saveProviderToDB,
  getActiveProvider,
  setActiveProviderId,
  watchProviders,
  watchActiveProviderId,
  getLanguage,
  watchLanguage,
  getThemeMode,
  setThemeMode,
  watchThemeMode,
  applyTheme,
  getUiFontScale,
  watchUiFontScale,
  applyUiFontScale,
  getResolvedTheme,
  getSelectionQuoteEnabled,
  watchSelectionQuoteEnabled,
  getMaxPageContentLength,
  watchMaxPageContentLength,
  getMaxToolCalls,
  watchMaxToolCalls,
  getRawExtractSites,
  isRawExtractSite,
  isVisionSupportedForModel,
  setAssistantDisplayMode,
  setAssistantWindowBounds,
  getPresetActions,
  watchPresetActions,
  type AIProvider,
  type Language,
  type ThemeMode,
  type PresetAction,
  type UiFontScale,
  type AssistantDisplayMode,
} from '../../utils/storage';
import {
  getSharePageContentPreferenceInitialized,
  getStoredSharePageContent,
  setSharePageContent,
  setSharePageContentPreferenceInitialized,
  setCurrentSessionId,
  getAllSessions,
  getSessionsPaginated,
  createSession,
  updateSession,
  deleteSession,
  generateSessionTitle,
  type ChatImage,
  type ChatMessage,
  type ChatSession,
} from '../../utils/db';
import { streamChat, getLastApiMessages, setLastApiMessages, ApiError, type ToolExecutor, type ApiMessage } from '../../utils/api';
import { extractPageContent, truncateContent } from '../../utils/pageExtractor';
import { getToolStatusText, isBrowserAutomationTool, isMcpTool, parseMcpToolName, type ToolCall, type ToolResult, type SkillInfo } from '../../utils/tools';
import { shouldSubmitOnEnter } from '../../utils/enterSubmit';
import { getAllSkills, getSkillByName, getSkillFileAsText, type Skill } from '../../utils/skills';
import { executeScript, setScriptConfirmCallback, type ScriptConfirmationRequest } from '../../utils/skillsExecutor';
import { t, type Translations } from '../../utils/i18n';
import { mcpManager, type McpTool } from '../../utils/mcp';
import { getEnabledMcpServers, watchMcpServers } from '../../utils/mcpStorage';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface SurfaceContext {
  tabId: number | null;
  windowId: number | null;
}

const props = withDefaults(defineProps<{
  surfaceMode?: AssistantDisplayMode;
}>(), {
  surfaceMode: 'sidepanel',
});

// Language state
const currentLanguage = ref<Language>('en');

// Theme state
const currentThemeMode = ref<ThemeMode>('system');
const showThemeSelector = ref(false);
const currentUiFontScale = ref<UiFontScale>(1);
const currentAssistantWindowId = ref<number | null>(null);
const hostSurfaceContext = ref<SurfaceContext>({
  tabId: null,
  windowId: null,
});

// 国际化辅助函数
const i18n = (key: keyof Translations, params?: Record<string, string | number>) => {
  return t(currentLanguage.value, key, params);
};

const isWindowSurface = computed(() => props.surfaceMode === 'window');

function readHostSurfaceContextFromUrl(): SurfaceContext {
  const searchParams = new URLSearchParams(window.location.search);
  const rawTabId = Number(searchParams.get('hostTabId'));
  const rawWindowId = Number(searchParams.get('hostWindowId'));

  return {
    tabId: Number.isFinite(rawTabId) ? rawTabId : null,
    windowId: Number.isFinite(rawWindowId) ? rawWindowId : null,
  };
}

function updateHostSurfaceContext(context?: Partial<SurfaceContext> | null): void {
  if (!context) return;
  if (typeof context.tabId === 'number') {
    hostSurfaceContext.value.tabId = context.tabId;
  }
  if (typeof context.windowId === 'number') {
    hostSurfaceContext.value.windowId = context.windowId;
  }
}

async function getTargetTab(): Promise<any | null> {
  const syncWindowSurfaceContext = (tab: any) => {
    if (!isWindowSurface.value || !tab) return;
    updateHostSurfaceContext({
      tabId: typeof tab.id === 'number' ? tab.id : undefined,
      windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
    });
  };

  if (lockedTabId.value) {
    try {
      const tab = await browser.tabs.get(lockedTabId.value);
      syncWindowSurfaceContext(tab);
      return tab;
    } catch {
      // 锁定标签页已关闭，继续回退
    }
  }

  if (isWindowSurface.value) {
    if (hostSurfaceContext.value.windowId !== null) {
      const [tab] = await browser.tabs.query({ active: true, windowId: hostSurfaceContext.value.windowId });
      if (tab) {
        syncWindowSurfaceContext(tab);
        return tab;
      }
    }

    if (hostSurfaceContext.value.tabId !== null) {
      try {
        const tab = await browser.tabs.get(hostSurfaceContext.value.tabId);
        syncWindowSurfaceContext(tab);
        return tab;
      } catch {
        // 记录的宿主标签页可能已关闭，继续回退
      }
    }
  }

  const [tab] = await browser.tabs.query({
    active: true,
    ...(isWindowSurface.value ? { lastFocusedWindow: true } : { currentWindow: true }),
  });
  syncWindowSurfaceContext(tab);
  return tab ?? null;
}

async function resolveSurfaceContext(): Promise<SurfaceContext> {
  const tab = await getTargetTab();
  return {
    tabId: typeof tab?.id === 'number' ? tab.id : hostSurfaceContext.value.tabId,
    windowId: typeof tab?.windowId === 'number' ? tab.windowId : hostSurfaceContext.value.windowId,
  };
}

function encodeMarkdownData(value: string): string {
  return encodeURIComponent(value);
}

function decodeMarkdownData(value?: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function renderMathExpression(expression: string, displayMode: boolean): string {
  return katex.renderToString(expression.trim(), {
    displayMode,
    strict: 'ignore',
    throwOnError: false,
  });
}

function getMarkdownToolbarLabels() {
  return {
    copy: i18n('copy'),
    copied: i18n('copied'),
    expand: currentLanguage.value === 'zh-CN' ? '全屏' : 'Expand',
    code: currentLanguage.value === 'zh-CN' ? '代码' : 'Code',
  };
}

const markdownRenderer = {
  link(this: any, { href = '', title, tokens }: any) {
    const text = this.parser.parseInline(tokens);
    const safeHref = escapeHtml(href);
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${safeTitle}>${text}</a>`;
  },
  code({ text = '', lang = '' }: any) {
    const { copy, copied, expand, code } = getMarkdownToolbarLabels();
    const normalizedCode = String(text).replace(/\n$/, '');
    const language = String(lang || '').trim();
    const languageLabel = language || code;
    const encodedCode = encodeMarkdownData(normalizedCode);
    const encodedLanguage = encodeMarkdownData(language);

    return `
      <div class="markdown-code-block">
        <div class="markdown-code-toolbar">
          <span class="markdown-code-language">${escapeHtml(languageLabel)}</span>
          <div class="markdown-code-actions">
            <button
              type="button"
              class="markdown-code-btn"
              data-markdown-action="copy-code"
              data-code="${encodedCode}"
              data-language="${encodedLanguage}"
              data-default-label="${escapeHtml(copy)}"
              data-copied-label="${escapeHtml(copied)}"
              title="${escapeHtml(copy)}"
              aria-label="${escapeHtml(copy)}"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              <span class="markdown-code-btn-label">${escapeHtml(copy)}</span>
            </button>
            <button
              type="button"
              class="markdown-code-btn"
              data-markdown-action="expand-code"
              data-code="${encodedCode}"
              data-language="${encodedLanguage}"
              title="${escapeHtml(expand)}"
              aria-label="${escapeHtml(expand)}"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3H5a2 2 0 00-2 2v3"/>
                <path d="M16 3h3a2 2 0 012 2v3"/>
                <path d="M8 21H5a2 2 0 01-2-2v-3"/>
                <path d="M16 21h3a2 2 0 002-2v-3"/>
              </svg>
              <span class="markdown-code-btn-label">${escapeHtml(expand)}</span>
            </button>
          </div>
        </div>
        <pre><code>${escapeHtml(normalizedCode)}</code></pre>
      </div>
    `;
  },
};

const blockMathExtension = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    return src.match(/\$\$/)?.index;
  },
  tokenizer(src: string) {
    const match = /^\$\$[ \t]*\n([\s\S]+?)\n\$\$(?:\n|$)/.exec(src)
      ?? /^\$\$([^\n]+?)\$\$(?:\n|$)/.exec(src);
    if (!match) return undefined;
    return {
      type: 'blockMath',
      raw: match[0],
      text: match[1],
    };
  },
  renderer(token: any) {
    return `<div class="markdown-math-block">${renderMathExpression(token.text, true)}</div>`;
  },
};

const inlineMathExtension = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('$');
  },
  tokenizer(src: string) {
    if (src.startsWith('$$')) return undefined;
    const match = /^\$((?:\\.|[^$\\\n])+?)\$(?!\$)/.exec(src);
    if (!match) return undefined;
    return {
      type: 'inlineMath',
      raw: match[0],
      text: match[1],
    };
  },
  renderer(token: any) {
    return renderMathExpression(token.text, false);
  },
};

const markdownParser = new Marked({
  breaks: true,
  gfm: true,
  renderer: markdownRenderer,
  extensions: [blockMathExtension, inlineMathExtension],
});

function renderMarkdown(content: string): string {
  if (!content) return '';
  return markdownParser.parse(content) as string;
}

// State
const messages = shallowRef<ChatMessage[]>([]);
const inputText = ref('');
const sharePageContent = ref(false);
const pendingQuote = ref<string | null>(null);
const isLoading = ref(false);
const showHistory = ref(false);
const chatAreaRef = ref<HTMLElement | null>(null);
const toolStatus = ref<string | null>(null); // 工具执行状态提示
const maxPageContentLength = ref(30000);
const maxToolCalls = ref(100);
const selectionQuoteEnabled = ref(true);
const imageInputRef = ref<HTMLInputElement | null>(null);
const pendingImages = ref<ChatImage[]>([]);
const isImageDragActive = ref(false);
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_SIZE_MB = 5;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

// 预设操作
const presetActions = ref<PresetAction[]>([]);
const unwatchPresetActions = ref<(() => void) | null>(null);

interface ActiveTabInfo {
  title: string;
  faviconUrl?: string;
}

const activeTabInfo = ref<ActiveTabInfo | null>(null);
const sharePageHintDismissed = ref(false);
const selectionQuotePopup = ref({
  visible: false,
  x: 0,
  y: 0,
  text: '',
});
const chatAbortController = ref<AbortController | null>(null);
const fullscreenCodeBlock = ref<{ code: string; language: string } | null>(null);

// Session state
const currentSession = ref<ChatSession | null>(null);
const sessions = ref<ChatSession[]>([]);
const sessionsHasMore = ref(true);
const sessionsLoading = ref(false);
const sessionsOffset = ref(0);
const SESSIONS_PAGE_SIZE = 15;

// Provider state
const providers = ref<AIProvider[]>([]);
const activeProviderId = ref<string | null>(null);
const showModelSelector = ref(false);

// Debug state
const showDebugModal = ref(false);
const debugApiMessages = ref<ApiMessage[]>([]);

// 思维链折叠状态（按消息索引存储）
const reasoningExpanded = ref<Record<number, boolean>>({});

// 切换思维链展开/折叠
function toggleReasoning(idx: number) {
  reasoningExpanded.value[idx] = !reasoningExpanded.value[idx];
}

// 编辑和复制状态
const editingMessageIndex = ref<number | null>(null);
const editingContent = ref<string>('');
const editingQuote = ref<string | null>(null);
const copiedMessageIndex = ref<number | null>(null);

// 复制按钮位置状态（按消息索引存储：'top' | 'bottom'）
const copyButtonPosition = ref<Record<number, 'top' | 'bottom'>>({});

// 标签页锁定状态 - 仅当 AI 正在回复时锁定
const isTabLocked = computed(() => {
  return isLoading.value && sharePageContent.value;
});

// 锁定时记住的 tabId，确保内容获取和脚本执行在正确的标签页上执行
const lockedTabId = ref<number | null>(null);

// 捕获当前活跃标签页 ID 并锁定
async function captureLockedTab(): Promise<void> {
  if (!sharePageContent.value) return;
  try {
    const tab = await getTargetTab();
    if (tab?.id) {
      lockedTabId.value = tab.id;
    }
  } catch (e) {
    console.error('Failed to capture locked tab:', e);
  }
}

// 释放锁定的标签页
function releaseLockedTab(): void {
  lockedTabId.value = null;
}

// 计算属性
const isEditing = computed(() => editingMessageIndex.value !== null);

function fallbackCopyText(content: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function writeTextToClipboard(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch (error) {
    console.error('Failed to copy with clipboard API:', error);
    return fallbackCopyText(content);
  }
}

// 复制消息（仅 AI 回复）
async function copyMessage(index: number): Promise<void> {
  const message = messages.value[index];
  if (!message.content || message.role !== 'assistant') return;

  const copied = await writeTextToClipboard(message.content);
  if (!copied) {
    alert(currentLanguage.value === 'zh-CN' ? '复制失败' : 'Copy failed');
    return;
  }

  copiedMessageIndex.value = index;
  setTimeout(() => {
    if (copiedMessageIndex.value === index) {
      copiedMessageIndex.value = null;
    }
  }, 2000);
}

// 处理消息鼠标移动，检测复制按钮应该显示在顶部还是底部
function handleMessageMouseMove(event: MouseEvent, index: number): void {
  const target = event.currentTarget as HTMLElement;
  if (!target) return;

  const rect = target.getBoundingClientRect();
  const mouseY = event.clientY;
  const middleY = rect.top + rect.height / 2;

  // 鼠标在消息上半部分显示顶部按钮，下半部分显示底部按钮
  copyButtonPosition.value[index] = mouseY < middleY ? 'top' : 'bottom';
}

function flashMarkdownCodeButton(button: HTMLButtonElement): void {
  const label = button.querySelector<HTMLElement>('.markdown-code-btn-label');
  if (!label) return;

  const defaultLabel = button.dataset.defaultLabel || label.textContent || '';
  const copiedLabel = button.dataset.copiedLabel || defaultLabel;
  const previousTimer = button.dataset.resetTimer ? Number(button.dataset.resetTimer) : null;
  if (previousTimer) {
    window.clearTimeout(previousTimer);
  }

  label.textContent = copiedLabel;
  button.classList.add('copied');

  const timerId = window.setTimeout(() => {
    label.textContent = defaultLabel;
    button.classList.remove('copied');
    delete button.dataset.resetTimer;
  }, 1600);

  button.dataset.resetTimer = String(timerId);
}

function openFullscreenCodeBlock(code: string, language: string): void {
  fullscreenCodeBlock.value = { code, language };
}

function closeFullscreenCodeBlock(): void {
  fullscreenCodeBlock.value = null;
}

async function copyFullscreenCodeBlock(): Promise<void> {
  if (!fullscreenCodeBlock.value) return;

  const copied = await writeTextToClipboard(fullscreenCodeBlock.value.code);
  if (!copied) {
    alert(currentLanguage.value === 'zh-CN' ? '复制失败' : 'Copy failed');
  }
}

async function handleMarkdownActionClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement | null;
  const actionButton = target?.closest<HTMLButtonElement>('[data-markdown-action]');
  if (!actionButton) return;

  event.preventDefault();
  event.stopPropagation();

  const code = decodeMarkdownData(actionButton.dataset.code);
  const language = decodeMarkdownData(actionButton.dataset.language);
  const action = actionButton.dataset.markdownAction;

  if (action === 'copy-code') {
    const copied = await writeTextToClipboard(code);
    if (copied) {
      flashMarkdownCodeButton(actionButton);
    } else {
      alert(currentLanguage.value === 'zh-CN' ? '复制失败' : 'Copy failed');
    }
    return;
  }

  if (action === 'expand-code') {
    openFullscreenCodeBlock(code, language);
  }
}

function dismissSharePageHint(): void {
  sharePageHintDismissed.value = true;
}

async function initializeSharePagePreference(): Promise<void> {
  const storedPreference = await getStoredSharePageContent();
  if (storedPreference !== undefined) {
    sharePageContent.value = storedPreference;
    await setSharePageContentPreferenceInitialized(true);
    return;
  }

  const preferenceInitialized = await getSharePageContentPreferenceInitialized();
  if (preferenceInitialized) {
    sharePageContent.value = false;
    return;
  }

  const existingSessions = await getAllSessions();
  const hasExistingData = providers.value.length > 0 || existingSessions.length > 0 || installedSkills.value.length > 0;
  const defaultShareValue = !hasExistingData;

  sharePageContent.value = defaultShareValue;
  await setSharePageContent(defaultShareValue);
  await setSharePageContentPreferenceInitialized(true);
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && fullscreenCodeBlock.value) {
    closeFullscreenCodeBlock();
  }
}

// 编辑消息
function startEditMessage(index: number): void {
  const message = messages.value[index];
  
  // 只允许编辑用户消息
  if (message.role !== 'user') return;
  
  // 保存编辑状态
  editingMessageIndex.value = index;
  editingContent.value = message.content;
  editingQuote.value = message.quote || null;
  
  // 不自动滚动，保持当前位置
}

// 取消编辑
function cancelEditMessage(): void {
  editingMessageIndex.value = null;
  editingContent.value = '';
  editingQuote.value = null;
}

// 移除编辑中的引用
function removeEditingQuote(): void {
  editingQuote.value = null;
}

// 保存编辑并重新生成
async function saveEditMessage(): Promise<void> {
  if (editingMessageIndex.value === null) return;
  
  const newContent = editingContent.value.trim();
  const originalMessage = messages.value[editingMessageIndex.value];
  const hasImages = Boolean(originalMessage?.images?.length);
  if (!newContent && !hasImages) {
    alert('消息不能为空');
    return;
  }
  
  if (!currentSession.value) {
    alert('会话不存在');
    cancelEditMessage();
    return;
  }
  
  const index = editingMessageIndex.value;
  
  // 获取当前的 API 上下文
  const currentApiMessages = currentSession.value.apiMessages || getLastApiMessages();
  
  // 计算被编辑的是第几条 user 消息（从 0 开始计数）
  // messages 数组中包含 user 和 assistant，需要计算 index 位置是第几个 user
  let userIndexInMessages = 0;
  for (let i = 0; i < index; i++) {
    if (messages.value[i]?.role === 'user') {
      userIndexInMessages++;
    }
  }
  // 此时 userIndexInMessages 表示被编辑的 user 消息是第几个（从 0 开始）
  
  // 在 apiMessages 中找到对应的 user 消息位置
  // apiMessages 结构: [system, user1, assistant1?, tool?, ..., user2, assistant2?, ...]
  let userCount = 0;
  let apiCutIndex = 0;
  for (let i = 0; i < currentApiMessages.length; i++) {
    if (currentApiMessages[i].role === 'user') {
      if (userCount === userIndexInMessages) {
        // 找到了要编辑的用户消息在 apiMessages 中的位置
        apiCutIndex = i;
        break;
      }
      userCount++;
    }
  }
  
  // 截取 apiMessages：保留到被编辑消息之前的所有内容（不包括被编辑的消息本身）
  const truncatedApiMessages = currentApiMessages.slice(0, apiCutIndex);
  
  // 更新消息内容
  messages.value[index].content = newContent;
  messages.value[index].quote = editingQuote.value || undefined;
  messages.value[index].timestamp = Date.now();
  
  // 删除该消息之后的所有消息
  messages.value = messages.value.slice(0, index + 1);
  
  // 更新 API 上下文为截取后的版本
  setLastApiMessages(truncatedApiMessages);
  
  // 同时更新会话中保存的 apiMessages
  if (currentSession.value) {
    currentSession.value.apiMessages = truncatedApiMessages;
  }
  
  // 清空编辑状态
  cancelEditMessage();
  
  // 触发重新生成
  await regenerateResponse();
}

// 重新生成 AI 回复
async function regenerateResponse(): Promise<void> {
  if (!currentSession.value) return;
  
  const provider = await getActiveProvider();
  if (!provider) {
    alert('未配置模型');
    return;
  }
  
  isLoading.value = true;
  await captureLockedTab();
  toolStatus.value = null;
  chatAbortController.value?.abort();
  chatAbortController.value = new AbortController();
  beginBrowserAutomationRun();
  let assistantMessage: ChatMessage | null = null;
  
  try {
    assistantMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    messages.value.push(assistantMessage);
    triggerRef(messages);
    scrollToBottom();
    
    // 使用 ReAct 范式的流式聊天
    const reactConfig = {
      enableTools: true,
      toolExecutor,
      maxIterations: 10,
      maxToolCalls: maxToolCalls.value,
      abortSignal: chatAbortController.value.signal,
    };
    
    // 构建 Skills 信息
    const skillsInfo: SkillInfo[] = installedSkills.value.map(s => ({
      name: s.metadata.name,
      description: s.metadata.description,
    }));
    
    // 获取当前页面信息（优先使用锁定的 tabId）
    let pageInfo: { domain: string; title: string; url: string } | undefined;
    if (sharePageContent.value) {
      try {
        let tab: any = null;
        if (lockedTabId.value) {
          try {
            tab = await browser.tabs.get(lockedTabId.value);
          } catch {
            // 锁定标签页已关闭，回退
          }
        }
        if (!tab) {
          tab = await getTargetTab();
        }
        if (tab?.url && tab?.title) {
          const urlObj = new URL(tab.url);
          pageInfo = {
            domain: urlObj.hostname,
            title: tab.title,
            url: tab.url,
          };
        }
      } catch (e) {
        console.error('Failed to get page info:', e);
      }
    }

    // 获取当前语言设置
    const currentLanguage = await getLanguage();

    // 获取之前保存的 API 上下文（已在 saveEditMessage 中正确截取）
    const previousApiMessages = currentSession.value?.apiMessages || getLastApiMessages();
    // 只有当之前有消息时才传入（排除只有 system 消息的情况）
    const hasValidPreviousContext = previousApiMessages.length > 1;

    for await (const event of streamChat(
      provider,
      messages.value.slice(0, -1),
      {
        sharePageContent: sharePageContent.value,
        skills: skillsInfo,
        mcpTools: mcpTools.value,
        browserAutomationAvailable,
        browserVisionAvailable: browserAutomationAvailable && activeModelSupportsVision.value,
        pageInfo,
        language: currentLanguage,
      },
      reactConfig,
      undefined, // retryConfig 使用默认值
      hasValidPreviousContext ? previousApiMessages : undefined
    )) {
      switch (event.type) {
        case 'reasoning':
          if (!assistantMessage.reasoning) {
            assistantMessage.reasoning = '';
          }
          assistantMessage.reasoning += event.content;
          triggerRef(messages);
          break;
        case 'content':
          assistantMessage.content += event.content;
          triggerRef(messages);
          break;
        case 'tool_call':
          isLoading.value = true;
          toolStatus.value = getToolStatusText(event.toolCall.name, event.toolCall.arguments);
          break;
        case 'thinking':
          toolStatus.value = event.message;
          break;
        case 'tool_result':
          toolStatus.value = null;
          if (assistantMessage.content && !assistantMessage.content.endsWith('\n')) {
            assistantMessage.content += '\n';
          }
          triggerRef(messages);
          break;
        case 'done':
          toolStatus.value = null;
          assistantMessage.content = assistantMessage.content.trim();
          if (assistantMessage.reasoning) {
            assistantMessage.reasoning = assistantMessage.reasoning.trim();
          }
          break;
      }
    }
    
    assistantMessage.timestamp = Date.now();
  } catch (error: any) {
    const isUserAborted = error instanceof ApiError && error.code === 'USER_ABORTED';
    if (isUserAborted) {
      if (assistantMessage && !assistantMessage.content.trim() && !(assistantMessage.reasoning || '').trim()) {
        const lastMessage = messages.value[messages.value.length - 1];
        if (lastMessage === assistantMessage) {
          messages.value.pop();
          triggerRef(messages);
        }
      }
    } else {
      messages.value.push({
        role: 'assistant',
        content: `重新生成失败: ${error.message}`,
        timestamp: Date.now(),
      });
      triggerRef(messages);
    }
  } finally {
    await endBrowserAutomationRun(!browserAutomationWasStopped.value);
    chatAbortController.value = null;
    isLoading.value = false;
    releaseLockedTab();
    toolStatus.value = null;
    await saveCurrentSession();
  }
}

// Skills state
const installedSkills = ref<Skill[]>([]);
const showScriptConfirmModal = ref(false);
const pendingScriptConfirm = ref<{
  request: ScriptConfirmationRequest;
  resolve: (result: { confirmed: boolean; trustForever: boolean }) => void;
} | null>(null);

interface BrowserAutomationMeta {
  sessionId: string;
  activeTabId: number | null;
  activeTabTitle?: string;
  activeTabUrl?: string;
  groupTitle?: string;
  lastAction: string;
}

interface BrowserAutomationRisk {
  level: 'none' | 'sensitive' | 'destructive';
  reasons: string[];
  preview?: string;
}

interface BrowserAutomationConfirmRequest {
  kind: 'sensitive';
  title: string;
  message: string;
  risk?: BrowserAutomationRisk;
  resolve: (confirmed: boolean) => void;
}

const browserAutomationAvailable = !import.meta.env.FIREFOX;
const browserAutomationSessionId = ref<string | null>(null);
const browserAutomationTurnId = ref<string | null>(null);
const browserAutomationUsed = ref(false);
const browserAutomationFinalized = ref(false);
const browserAutomationWasStopped = ref(false);
const browserAutomationStatus = ref<BrowserAutomationMeta | null>(null);
const showBrowserAutomationConfirmModal = ref(false);
const pendingBrowserAutomationConfirm = ref<BrowserAutomationConfirmRequest | null>(null);

// MCP state
const mcpTools = ref<McpTool[]>([]);
const mcpConnecting = ref(false);
const unwatchMcpServers = ref<(() => void) | null>(null);

// Computed
const activeProvider = computed(() => {
  return providers.value.find(p => p.id === activeProviderId.value) || null;
});

const activeModelName = computed(() => {
  if (!activeProvider.value) return i18n('notConfigured');
  const model = activeProvider.value.selectedModel;
  // return model.length > 12 ? model.substring(0, 12) + '...' : model;
  return model;
});

// 构建所有可选的模型列表（供应商+模型组合）
const allModelOptions = computed(() => {
  const options: { providerId: string; providerName: string; model: string }[] = [];
  for (const p of providers.value) {
    const models = Array.isArray(p.models) ? p.models : [];
    for (const m of models) {
      options.push({
        providerId: p.id,
        providerName: p.name,
        model: m,
      });
    }
  }
  return options;
});

const activeModelSupportsVision = computed(() => {
  if (!activeProvider.value) return false;
  return isVisionSupportedForModel(activeProvider.value, activeProvider.value.selectedModel);
});
const browserAutomationConfirmPrimaryLabel = computed(() => {
  return currentLanguage.value === 'zh-CN' ? '确认执行' : 'Confirm';
});
const hasPendingImages = computed(() => pendingImages.value.length > 0);
const showSharePageHint = computed(() => {
  return !sharePageContent.value && !sharePageHintDismissed.value && Boolean(activeTabInfo.value) && !isTabLocked.value;
});
const canSendMessage = computed(() => {
  return !isEditing.value && !isLoading.value && (inputText.value.trim().length > 0 || hasPendingImages.value);
});
const sharePageHintText = computed(() => {
  return currentLanguage.value === 'zh-CN'
    ? '点击选中这个标签页后，当前网页内容才会共享给 AI。'
    : 'Click the tab chip to share the current page with AI.';
});
const codePreviewTitle = computed(() => {
  return currentLanguage.value === 'zh-CN' ? '代码预览' : 'Code Preview';
});
const fullscreenLanguageLabel = computed(() => {
  if (fullscreenCodeBlock.value?.language) {
    return fullscreenCodeBlock.value.language;
  }
  return currentLanguage.value === 'zh-CN' ? '代码' : 'Code';
});

const activeTabButtonTitle = computed(() => {
  const statusText = sharePageContent.value ? i18n('pageContentShared') : i18n('sharePageContent');
  if (!activeTabInfo.value?.title) return statusText;
  return `${activeTabInfo.value.title} · ${statusText}`;
});

// Format timestamp
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const locale = currentLanguage.value === 'zh-CN' ? 'zh-CN' : 'en-US';
  
  if (isToday) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSessionDate(timestamp: number): string {
  const date = new Date(timestamp);
  const locale = currentLanguage.value === 'zh-CN' ? 'zh-CN' : 'en-US';
  return date.toLocaleDateString(locale, { 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('textarea, input, [contenteditable="true"], .pending-quote, .pending-images, .inline-selection-quote');
}

async function refreshActiveTabInfo(): Promise<void> {
  // AI 回复期间锁定标签页信息，不随浏览器标签页切换而更新
  if (isTabLocked.value) return;
  try {
    const tab = await getTargetTab();
    if (!tab?.url || !tab.title) {
      activeTabInfo.value = null;
      return;
    }
    activeTabInfo.value = {
      title: tab.title,
      faviconUrl: tab.favIconUrl || undefined,
    };
  } catch (error) {
    console.error('Failed to refresh active tab info:', error);
    activeTabInfo.value = null;
  }
}

async function toggleShareCurrentTab(): Promise<void> {
  // 如果标签页被锁定，不允许切换
  if (isTabLocked.value) {
    return;
  }
  sharePageContent.value = !sharePageContent.value;
}

function removePendingImage(imageId: string): void {
  pendingImages.value = pendingImages.value.filter(image => image.id !== imageId);
}

function openImagePicker(): void {
  if (!activeModelSupportsVision.value) return;
  imageInputRef.value?.click();
}

function isSupportedImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error || new Error('Failed to read image file'));
    };
    reader.readAsDataURL(file);
  });
}

async function addPendingImageFiles(fileList: FileList | File[]): Promise<void> {
  if (!activeModelSupportsVision.value) return;

  const files = Array.from(fileList);
  if (files.length === 0) return;

  const imageFiles = files.filter(isSupportedImageFile);
  if (imageFiles.length === 0) {
    alert(i18n('imageOnlyFiles'));
    return;
  }

  const availableSlots = Math.max(0, MAX_IMAGE_COUNT - pendingImages.value.length);
  if (availableSlots <= 0) {
    alert(i18n('imageCountLimit', { count: MAX_IMAGE_COUNT }));
    return;
  }

  if (imageFiles.length > availableSlots) {
    alert(i18n('imageCountLimit', { count: MAX_IMAGE_COUNT }));
  }

  const filesToProcess = imageFiles.slice(0, availableSlots);
  for (const file of filesToProcess) {
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      alert(i18n('imageTooLarge', { sizeMB: MAX_IMAGE_SIZE_MB }));
      continue;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      if (!dataUrl) continue;
      pendingImages.value.push({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || 'image/*',
        dataUrl,
      });
    } catch (error) {
      console.error('Failed to read image file:', error);
    }
  }
}

async function handleImageInputChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  await addPendingImageFiles(input.files);
  input.value = '';
}

function handleInputBoxDragEnter(event: DragEvent): void {
  if (!activeModelSupportsVision.value) return;
  if (event.dataTransfer?.types.includes('Files')) {
    isImageDragActive.value = true;
  }
}

function handleInputBoxDragOver(event: DragEvent): void {
  if (!activeModelSupportsVision.value) return;
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
  isImageDragActive.value = true;
}

function handleInputBoxDragLeave(event: DragEvent): void {
  if (!activeModelSupportsVision.value) return;
  const currentTarget = event.currentTarget as HTMLElement | null;
  const relatedTarget = event.relatedTarget as Node | null;
  if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
    return;
  }
  isImageDragActive.value = false;
}

async function handleInputBoxDrop(event: DragEvent): Promise<void> {
  if (!activeModelSupportsVision.value) return;
  isImageDragActive.value = false;
  if (!event.dataTransfer?.files?.length) return;
  await addPendingImageFiles(event.dataTransfer.files);
}

async function handleInputPaste(event: ClipboardEvent): Promise<void> {
  if (!activeModelSupportsVision.value) return;
  if (!event.clipboardData) return;

  const imageFiles: File[] = [];
  for (const item of Array.from(event.clipboardData.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) {
      imageFiles.push(file);
    }
  }

  if (imageFiles.length === 0 && event.clipboardData.files.length > 0) {
    for (const file of Array.from(event.clipboardData.files)) {
      if (isSupportedImageFile(file)) {
        imageFiles.push(file);
      }
    }
  }

  if (imageFiles.length === 0) return;
  event.preventDefault();
  await addPendingImageFiles(imageFiles);
}

function hideSelectionQuotePopup(): void {
  selectionQuotePopup.value.visible = false;
}

function getSelectionEndPosition(): { x: number; y: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const endRange = range.cloneRange();
  endRange.collapse(false);
  const rects = endRange.getClientRects();

  if (rects.length > 0) {
    const lastRect = rects[rects.length - 1];
    return { x: lastRect.right, y: lastRect.bottom };
  }

  const boundingRect = range.getBoundingClientRect();
  if (boundingRect.width === 0 && boundingRect.height === 0) {
    return null;
  }
  return { x: boundingRect.right, y: boundingRect.bottom };
}

function useSidepanelSelectionQuote(): void {
  if (!selectionQuotePopup.value.text) return;
  pendingQuote.value = selectionQuotePopup.value.text;
  hideSelectionQuotePopup();
  window.getSelection()?.removeAllRanges();
}

function handleSidepanelSelectionMouseup(event: MouseEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest('.inline-selection-quote')) {
    return;
  }

  if (!selectionQuoteEnabled.value) {
    hideSelectionQuotePopup();
    return;
  }
  if (isEditableElement(event.target)) {
    hideSelectionQuotePopup();
    return;
  }

  const selection = window.getSelection();
  const text = selection?.toString().trim() || '';
  if (!text) {
    hideSelectionQuotePopup();
    return;
  }

  const position = getSelectionEndPosition();
  if (!position) {
    hideSelectionQuotePopup();
    return;
  }

  selectionQuotePopup.value = {
    visible: true,
    x: Math.max(position.x, 12),
    y: Math.max(position.y + 10, 12),
    text,
  };
}

function handleSidepanelSelectionMousedown(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.inline-selection-quote')) {
    return;
  }
  hideSelectionQuotePopup();
}

function terminateCurrentGeneration(): void {
  if (!chatAbortController.value) return;
  browserAutomationWasStopped.value = true;
  chatAbortController.value.abort();
  toolStatus.value = currentLanguage.value === 'zh-CN' ? '已终止' : 'Stopped';
  isLoading.value = false;
  releaseLockedTab();
  void endBrowserAutomationRun(false);
}

function beginBrowserAutomationRun(): void {
  browserAutomationSessionId.value = currentSession.value?.id
    ? `chat_${currentSession.value.id}`
    : `chat_${crypto.randomUUID()}`;
  browserAutomationTurnId.value = crypto.randomUUID();
  browserAutomationUsed.value = false;
  browserAutomationFinalized.value = false;
  browserAutomationWasStopped.value = false;
  browserAutomationStatus.value = null;
}

async function endBrowserAutomationRun(finalize: boolean): Promise<void> {
  const sessionId = browserAutomationSessionId.value;
  if (!sessionId || !browserAutomationUsed.value) return;

  try {
    await browser.runtime.sendMessage({
      type: 'BROWSER_AUTOMATION_END',
      sessionId,
      finalize: finalize && !browserAutomationFinalized.value,
    });
  } catch (error) {
    console.error('Failed to end browser automation session:', error);
  } finally {
    browserAutomationSessionId.value = null;
    browserAutomationTurnId.value = null;
    browserAutomationUsed.value = false;
    browserAutomationFinalized.value = false;
    browserAutomationStatus.value = null;
  }
}

function requestBrowserAutomationConfirmation(request: Omit<BrowserAutomationConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise(resolve => {
    pendingBrowserAutomationConfirm.value = { ...request, resolve };
    showBrowserAutomationConfirmModal.value = true;
  });
}

function resolveBrowserAutomationConfirmation(confirmed: boolean): void {
  pendingBrowserAutomationConfirm.value?.resolve(confirmed);
  pendingBrowserAutomationConfirm.value = null;
  showBrowserAutomationConfirmModal.value = false;
}

async function confirmSensitiveBrowserAutomation(response: any): Promise<boolean> {
  return await requestBrowserAutomationConfirmation({
    kind: 'sensitive',
    title: currentLanguage.value === 'zh-CN' ? '确认敏感页面操作' : 'Confirm sensitive page action',
    message: response.confirmationMessage || (currentLanguage.value === 'zh-CN'
      ? '该页面操作可能涉及敏感或破坏性行为，请确认后继续。'
      : 'This page action may be sensitive or destructive. Confirm to continue.'),
    risk: response.risk,
  });
}

function getBrowserAutomationToolResultText(toolName: string, result: any): string {
  if (result?.dataUrl && result?.mimeType) {
    return JSON.stringify({
      screenshot: true,
      mimeType: result.mimeType,
      description: result.description || toolName,
      note: 'Screenshot image is attached as a follow-up image context.',
    }, null, 2);
  }
  return typeof result === 'string' ? result : JSON.stringify(result ?? {}, null, 2);
}

function buildBrowserAutomationToolResult(toolCall: ToolCall, response: any): ToolResult {
  if (!response.success) {
    return {
      tool_call_id: toolCall.id,
      name: toolCall.name,
      result: response.error || '浏览器自动化执行失败',
      success: false,
    };
  }

  const result = response.result;
  const toolResult: ToolResult = {
    tool_call_id: toolCall.id,
    name: toolCall.name,
    result: getBrowserAutomationToolResultText(toolCall.name, result),
    success: true,
  };

  if (result?.dataUrl && result?.mimeType) {
    toolResult.images = [{
      dataUrl: result.dataUrl,
      mimeType: result.mimeType,
      description: result.description || toolCall.name,
    }];
  }

  return toolResult;
}

async function executeBrowserAutomationTool(toolCall: ToolCall): Promise<ToolResult> {
  if (!browserAutomationAvailable) {
    return {
      tool_call_id: toolCall.id,
      name: toolCall.name,
      result: 'Firefox 暂不支持浏览器自动化',
      success: false,
    };
  }

  if (!browserAutomationSessionId.value || !browserAutomationTurnId.value) {
    beginBrowserAutomationRun();
  }

  const context = await resolveSurfaceContext();
  const baseParams = {
    ...toolCall.arguments,
    ...(typeof toolCall.arguments.window_id === 'number' || context.windowId === null ? {} : { window_id: context.windowId }),
  };

  const sendCommand = async (params: Record<string, any>) => {
    return await browser.runtime.sendMessage({
      type: 'BROWSER_AUTOMATION_COMMAND',
      sessionId: browserAutomationSessionId.value,
      turnId: browserAutomationTurnId.value,
      command: toolCall.name,
      params,
    });
  };

  browserAutomationUsed.value = true;
  let response = await sendCommand(baseParams);
  if (response?.requiresConfirmation) {
    const confirmed = await confirmSensitiveBrowserAutomation(response);
    if (!confirmed) {
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        result: '用户取消了敏感页面操作',
        success: false,
      };
    }
    response = await sendCommand({ ...baseParams, confirmed: true });
  }

  if (response?.meta) {
    browserAutomationStatus.value = response.meta;
  }
  if (toolCall.name === 'browser_finalize_tabs' && response?.success) {
    browserAutomationFinalized.value = true;
  }

  return buildBrowserAutomationToolResult(toolCall, response);
}

// Initialize
const unwatchProviders = ref<(() => void) | null>(null);
const unwatchActiveProviderId = ref<(() => void) | null>(null);
const unwatchLanguage = ref<(() => void) | null>(null);
const unwatchThemeMode = ref<(() => void) | null>(null);
const unwatchUiFontScale = ref<(() => void) | null>(null);
const unwatchSelectionQuoteEnabled = ref<(() => void) | null>(null);
const unwatchMaxPageContentLength = ref<(() => void) | null>(null);
const unwatchMaxToolCalls = ref<(() => void) | null>(null);
const systemThemeMediaQuery = ref<MediaQueryList | null>(null);
let storageChangeListener: ((...args: any[]) => void) | null = null;
let tabsActivatedListener: ((activeInfo: any) => void) | null = null;
let tabsUpdatedListener: ((tabId: number, changeInfo: any, tab: any) => void) | null = null;
let sidepanelSelectionMouseupHandler: ((event: MouseEvent) => void) | null = null;
let sidepanelSelectionMousedownHandler: ((event: MouseEvent) => void) | null = null;
let markdownActionClickHandler: ((event: MouseEvent) => void) | null = null;
let globalKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
let windowBoundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let assistantWindowBoundsListener: ((windowInfo: any) => void) | null = null;

onMounted(async () => {
  hostSurfaceContext.value = readHostSurfaceContextFromUrl();
  providers.value = await getAllProviders();
  const activeProvider = await getActiveProvider();
  activeProviderId.value = activeProvider?.id || null;
  currentUiFontScale.value = await getUiFontScale();
  applyUiFontScale(currentUiFontScale.value);
  selectionQuoteEnabled.value = await getSelectionQuoteEnabled();
  maxPageContentLength.value = await getMaxPageContentLength();
  maxToolCalls.value = await getMaxToolCalls();
  
  // 加载语言设置
  currentLanguage.value = await getLanguage();
  
  // 加载主题设置
  currentThemeMode.value = await getThemeMode();
  applyTheme(currentThemeMode.value);

  if (isWindowSurface.value) {
    try {
      const currentWindow = await browser.windows.getCurrent();
      currentAssistantWindowId.value = currentWindow?.id ?? null;
      if (currentAssistantWindowId.value !== null) {
        await browser.storage.local.set({ assistantWindowId: currentAssistantWindowId.value });
      }
    } catch (error) {
      console.error('Failed to register assistant window:', error);
    }
  }
  
  // 监听系统主题变化
  systemThemeMediaQuery.value = window.matchMedia('(prefers-color-scheme: dark)');
  systemThemeMediaQuery.value.addEventListener('change', handleSystemThemeChange);
  
  // 加载已安装的 Skills
  installedSkills.value = await getAllSkills();
  await initializeSharePagePreference();
  
  // 初始化 MCP 连接
  await initMcpConnections();
  
  // 监听 MCP Server 配置变化
  unwatchMcpServers.value = watchMcpServers(async () => {
    await initMcpConnections();
  });
  
  // 设置脚本确认回调
  setScriptConfirmCallback(async (request) => {
    return new Promise((resolve) => {
      pendingScriptConfirm.value = { request, resolve };
      showScriptConfirmModal.value = true;
    });
  });
  
  currentSession.value = null;
  messages.value = [];

  // 监听 providers 变化（跨页面同步）
  unwatchProviders.value = watchProviders((newProviders) => {
    providers.value = newProviders;
  });
  
  // 监听 activeProviderId 变化（跨页面同步）
  unwatchActiveProviderId.value = watchActiveProviderId((newId) => {
    activeProviderId.value = newId;
  });
  
  // 监听语言变化（跨页面同步）
  unwatchLanguage.value = watchLanguage((newLang) => {
    currentLanguage.value = newLang;
  });
  
  // 监听主题变化（跨页面同步）
  unwatchThemeMode.value = watchThemeMode((newMode) => {
    currentThemeMode.value = newMode;
    applyTheme(newMode);
  });

  // 监听字号变化（跨页面同步）
  unwatchUiFontScale.value = watchUiFontScale((scale) => {
    currentUiFontScale.value = scale;
    applyUiFontScale(scale);
  });

  // 监听划词引用设置变化
  unwatchSelectionQuoteEnabled.value = watchSelectionQuoteEnabled((enabled) => {
    selectionQuoteEnabled.value = enabled;
    if (!enabled) {
      hideSelectionQuotePopup();
    }
  });

  // 监听网页提取字数上限变化
  unwatchMaxPageContentLength.value = watchMaxPageContentLength((value) => {
    maxPageContentLength.value = value;
  });

  // 监听工具调用次数上限变化
  unwatchMaxToolCalls.value = watchMaxToolCalls((value) => {
    maxToolCalls.value = value;
  });

  // 加载预设操作
  presetActions.value = await getPresetActions();

  // 监听预设操作变化
  unwatchPresetActions.value = watchPresetActions((presets) => {
    presetActions.value = presets;
  });

  // 监听 skills 变更消息
  browser.runtime.onMessage.addListener(handleRuntimeMessage);

  // 监听活动标签页变化，保持“当前标签页”卡片同步
  tabsActivatedListener = (activeInfo: any) => {
    if (isWindowSurface.value && activeInfo?.windowId === hostSurfaceContext.value.windowId) {
      updateHostSurfaceContext({ tabId: activeInfo.tabId });
    }
    refreshActiveTabInfo();
  };
  browser.tabs.onActivated.addListener(tabsActivatedListener);

  tabsUpdatedListener = (_tabId: number, changeInfo: any, tab: any) => {
    if (!tab.active) return;
    if (isWindowSurface.value && tab.windowId === hostSurfaceContext.value.windowId) {
      updateHostSurfaceContext({
        tabId: typeof tab.id === 'number' ? tab.id : undefined,
        windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
      });
    }
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
      refreshActiveTabInfo();
    }
  };
  browser.tabs.onUpdated.addListener(tabsUpdatedListener);
  await refreshActiveTabInfo();

  if (isWindowSurface.value) {
    assistantWindowBoundsListener = (windowInfo: any) => {
      if (windowInfo?.id !== currentAssistantWindowId.value || !windowInfo?.width || !windowInfo?.height) {
        return;
      }
      if (windowBoundsSaveTimer) {
        clearTimeout(windowBoundsSaveTimer);
      }
      windowBoundsSaveTimer = setTimeout(() => {
        setAssistantWindowBounds({
          width: windowInfo.width,
          height: windowInfo.height,
        }).catch((error) => {
          console.error('Failed to persist assistant window bounds:', error);
        });
      }, 120);
    };
    browser.windows.onBoundsChanged.addListener(assistantWindowBoundsListener);
  }

  // Check for pending quote from content script
  const result = await browser.storage.local.get('pendingQuote');
  if (result.pendingQuote) {
    pendingQuote.value = result.pendingQuote as string;
    await browser.storage.local.remove('pendingQuote');
  }

  // Listen for storage changes (for pendingQuote only)
  storageChangeListener = async (changes) => {
    if (changes.pendingQuote?.newValue) {
      pendingQuote.value = changes.pendingQuote.newValue as string;
      await browser.storage.local.remove('pendingQuote');
    }
  };
  browser.storage.local.onChanged.addListener(storageChangeListener);

  // 侧边栏内划词引用
  sidepanelSelectionMouseupHandler = (event: MouseEvent) => {
    handleSidepanelSelectionMouseup(event);
  };
  sidepanelSelectionMousedownHandler = (event: MouseEvent) => {
    handleSidepanelSelectionMousedown(event);
  };
  document.addEventListener('mouseup', sidepanelSelectionMouseupHandler);
  document.addEventListener('mousedown', sidepanelSelectionMousedownHandler);
  markdownActionClickHandler = (event: MouseEvent) => {
    void handleMarkdownActionClick(event);
  };
  globalKeydownHandler = (event: KeyboardEvent) => {
    handleGlobalKeydown(event);
  };
  document.addEventListener('click', markdownActionClickHandler);
  document.addEventListener('keydown', globalKeydownHandler);
});

// Runtime 消息处理
function handleRuntimeMessage(message: any) {
  if (message?.type === 'SKILLS_CHANGED') {
    getAllSkills().then(skills => {
      installedSkills.value = skills;
    });
    return;
  }

  if (message?.type === 'ASSISTANT_HOST_CONTEXT_UPDATED' && isWindowSurface.value) {
    updateHostSurfaceContext(message.context);
  }
}

// MCP 连接初始化
async function initMcpConnections() {
  mcpConnecting.value = true;
  mcpTools.value = [];
  
  try {
    // 先断开所有现有连接
    await mcpManager.disconnectAll();
    
    // 获取启用的 MCP Server 配置
    const enabledServers = await getEnabledMcpServers();
    
    // 连接每个 Server 并收集工具
    const allTools: McpTool[] = [];
    for (const server of enabledServers) {
      try {
        const tools = await mcpManager.connect(server);
        allTools.push(...tools);
        console.log(`[MCP] 已连接 ${server.name}，获取 ${tools.length} 个工具`);
      } catch (error) {
        console.error(`[MCP] 连接 ${server.name} 失败:`, error);
      }
    }
    
    mcpTools.value = allTools;
  } finally {
    mcpConnecting.value = false;
  }
}

// 系统主题变化处理
function handleSystemThemeChange() {
  if (currentThemeMode.value === 'system') {
    applyTheme('system');
  }
}

// 切换主题
async function changeThemeMode(mode: ThemeMode) {
  currentThemeMode.value = mode;
  await setThemeMode(mode);
  applyTheme(mode);
  showThemeSelector.value = false;
}

// 获取当前主题图标类型
const currentThemeIcon = computed(() => {
  if (currentThemeMode.value === 'system') {
    return getResolvedTheme('system');
  }
  return currentThemeMode.value;
});

// 清理 watchers
onUnmounted(() => {
  chatAbortController.value?.abort();
  chatAbortController.value = null;
  void endBrowserAutomationRun(false);
  unwatchProviders.value?.();
  unwatchActiveProviderId.value?.();
  unwatchLanguage.value?.();
  unwatchThemeMode.value?.();
  unwatchUiFontScale.value?.();
  unwatchSelectionQuoteEnabled.value?.();
  unwatchMaxPageContentLength.value?.();
  unwatchMaxToolCalls.value?.();
  unwatchPresetActions.value?.();
  // 移除系统主题监听
  systemThemeMediaQuery.value?.removeEventListener('change', handleSystemThemeChange);
  // 移除 skills 变更监听
  browser.runtime.onMessage.removeListener(handleRuntimeMessage);
  // 移除标签页监听
  if (tabsActivatedListener) {
    browser.tabs.onActivated.removeListener(tabsActivatedListener);
  }
  if (tabsUpdatedListener) {
    browser.tabs.onUpdated.removeListener(tabsUpdatedListener);
  }
  // 移除 storage 监听
  if (storageChangeListener) {
    browser.storage.local.onChanged.removeListener(storageChangeListener);
  }
  // 移除侧边栏内划词监听
  if (sidepanelSelectionMouseupHandler) {
    document.removeEventListener('mouseup', sidepanelSelectionMouseupHandler);
  }
  if (sidepanelSelectionMousedownHandler) {
    document.removeEventListener('mousedown', sidepanelSelectionMousedownHandler);
  }
  if (markdownActionClickHandler) {
    document.removeEventListener('click', markdownActionClickHandler);
  }
  if (globalKeydownHandler) {
    document.removeEventListener('keydown', globalKeydownHandler);
  }
  if (assistantWindowBoundsListener) {
    browser.windows.onBoundsChanged.removeListener(assistantWindowBoundsListener);
  }
  if (windowBoundsSaveTimer) {
    clearTimeout(windowBoundsSaveTimer);
  }
  // 清理调试面板刷新定时器
  if (debugRefreshTimer) {
    clearInterval(debugRefreshTimer);
    debugRefreshTimer = null;
  }
  // 断开所有 MCP 连接
  mcpManager.disconnectAll();
});

// Watch share page content toggle
watch(sharePageContent, async (val) => {
  await setSharePageContent(val);
});

watch(activeModelSupportsVision, (enabled) => {
  if (!enabled) {
    pendingImages.value = [];
    isImageDragActive.value = false;
  }
});

// Scroll to bottom
const scrollToBottom = () => {
  nextTick(() => {
    if (chatAreaRef.value) {
      chatAreaRef.value.scrollTop = chatAreaRef.value.scrollHeight;
    }
  });
};

async function executeTabScript<T>(tabId: number, func: () => T): Promise<T | undefined> {
  const scriptingApi = (browser as any).scripting;
  if (scriptingApi?.executeScript) {
    const results = await scriptingApi.executeScript({
      target: { tabId },
      func,
    });
    return results?.[0]?.result as T | undefined;
  }

  const tabsApi = (browser as any).tabs;
  if (tabsApi?.executeScript) {
    const code = `(${func.toString()})();`;
    const results = await tabsApi.executeScript(tabId, { code });
    return results?.[0] as T | undefined;
  }

  throw new Error('当前浏览器不支持脚本执行 API');
}

// 使用 Readability + Turndown 提取清洗后的页面内容
async function extractCleanPageContent(): Promise<string> {
  try {
    // 优先使用锁定的 tabId，确保在 AI 回复期间始终操作锁定时的标签页
    let targetTabId = lockedTabId.value;
    let targetTab: any = null;

    if (targetTabId) {
      // 使用锁定的 tabId 获取标签页信息
      try {
        targetTab = await browser.tabs.get(targetTabId);
      } catch {
        // 锁定的标签页可能已关闭，回退到当前活跃标签页
        targetTabId = null;
      }
    }

    if (!targetTabId) {
      const tab = await getTargetTab();
      targetTab = tab;
      targetTabId = tab?.id ?? null;
    }

    if (!targetTabId || !targetTab?.url) {
      return '无法获取当前页面信息';
    }

    const pageData = await executeTabScript(targetTabId, () => {
      // 返回完整的 HTML 和 URL
      return {
        html: document.documentElement.outerHTML,
        url: window.location.href,
        title: document.title,
      };
    });
    if (!pageData) {
      return '无法获取页面内容';
    }

    // 在这里解析 HTML（sidepanel 环境中）
    const parser = new DOMParser();
    const doc = parser.parseFromString(pageData.html, 'text/html');
    
    // 检查是否需要使用原始提取
    const rawExtractSites = await getRawExtractSites();
    const useRawExtract = isRawExtractSite(pageData.url, rawExtractSites);
    
    const extracted = extractPageContent(doc, pageData.url, { useRawExtract });
    const content = truncateContent(extracted.content, maxPageContentLength.value);
    
    // 始终包含元数据
    const metadata = [
      `# ${extracted.title}`,
      extracted.byline ? `作者: ${extracted.byline}` : '',
      extracted.siteName ? `来源: ${extracted.siteName}` : '',
      `URL: ${extracted.url}`,
      '',
      '---',
      '',
      content,
    ].filter(Boolean).join('\n');
    return metadata;
  } catch (e) {
    console.error('Failed to extract page content:', e);
    return `提取页面内容失败: ${e instanceof Error ? e.message : '未知错误'}`;
  }
}

// 工具执行器
const toolExecutor: ToolExecutor = async (toolCall: ToolCall): Promise<ToolResult> => {
  if (isBrowserAutomationTool(toolCall.name)) {
    return await executeBrowserAutomationTool(toolCall);
  }

  switch (toolCall.name) {
    case 'extract_page_content': {
      const content = await extractCleanPageContent();
      // 检查是否是错误消息
      const isError = content.startsWith('无法获取') || content.startsWith('提取页面内容失败');
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        result: content,
        success: !isError,
      };
    }
    case 'activate_skill': {
      const skillName = toolCall.arguments.skill_name;
      const skill = await getSkillByName(skillName);
      if (!skill) {
        return {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          result: `未找到名为 "${skillName}" 的 Skill`,
          success: false,
        };
      }
      // 返回 Skill 的完整指令
      const skillInfo = `# Skill: ${skill.metadata.name}

## 描述
${skill.metadata.description}

## 指令
${skill.instructions}

## 可用脚本
${skill.scripts.length > 0 
  ? skill.scripts.map(s => `- ${s.path}`).join('\n')
  : '无可用脚本'}

## 引用文件
${skill.references.length > 0 
  ? skill.references.map(r => `- ${r.path}`).join('\n')
  : '无引用文件'}`;
      
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        result: skillInfo,
        success: true,
      };
    }
    case 'execute_skill_script': {
      const skillName = toolCall.arguments.skill_name;
      const scriptPath = toolCall.arguments.script_path;
      const scriptArgs = toolCall.arguments.arguments || {};
      
      const skill = await getSkillByName(skillName);
      if (!skill) {
        return {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          result: `未找到名为 "${skillName}" 的 Skill`,
          success: false,
        };
      }
      
      const script = skill.scripts.find(s => s.path === scriptPath);
      if (!script) {
        return {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          result: `Skill "${skillName}" 中未找到脚本 "${scriptPath}"`,
          success: false,
        };
      }
      
      const execResult = await executeScript({ skill, script, tabId: lockedTabId.value ?? undefined, arguments: scriptArgs });
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        result: execResult.success 
          ? JSON.stringify(execResult.output, null, 2)
          : `脚本执行失败: ${execResult.error}`,
        success: execResult.success,
      };
    }
    case 'read_skill_file': {
      const skillName = toolCall.arguments.skill_name;
      const filePath = toolCall.arguments.file_path;
      
      const skill = await getSkillByName(skillName);
      if (!skill) {
        return {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          result: `未找到名为 "${skillName}" 的 Skill`,
          success: false,
        };
      }
      
      const content = await getSkillFileAsText(skill.id, filePath);
      if (content === null) {
        return {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          result: `文件 "${filePath}" 不存在或不是文本文件`,
          success: false,
        };
      }
      
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        result: content,
        success: true,
      };
    }
    default: {
      // 检查是否为 MCP 工具
      if (isMcpTool(toolCall.name)) {
        const parsed = parseMcpToolName(toolCall.name);
        if (parsed) {
          const mcpResult = await mcpManager.callTool(
            parsed.serverId,
            parsed.toolName,
            toolCall.arguments
          );
          return {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            result: mcpResult.content,
            success: mcpResult.success,
          };
        }
      }
      
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        result: `未知工具: ${toolCall.name}`,
        success: false,
      };
    }
  }
};

// Save current session
async function saveCurrentSession() {
  if (!currentSession.value) return;
  const sessionToSave: ChatSession = {
    ...currentSession.value,
    messages: JSON.parse(JSON.stringify(messages.value)),
    apiMessages: JSON.parse(JSON.stringify(getLastApiMessages())), // 持久化 API 上下文
  };
  await updateSession(sessionToSave);
  // 刷新当前已加载的会话列表
  await loadInitialSessions();
}

// 加载初始会话列表
async function loadInitialSessions() {
  sessionsOffset.value = 0;
  const result = await getSessionsPaginated(SESSIONS_PAGE_SIZE, 0);
  sessions.value = result.sessions;
  sessionsHasMore.value = result.hasMore;
  sessionsOffset.value = result.sessions.length;
}

// 加载更多会话
async function loadMoreSessions() {
  if (sessionsLoading.value || !sessionsHasMore.value) return;
  
  sessionsLoading.value = true;
  try {
    const result = await getSessionsPaginated(SESSIONS_PAGE_SIZE, sessionsOffset.value);
    sessions.value = [...sessions.value, ...result.sessions];
    sessionsHasMore.value = result.hasMore;
    sessionsOffset.value += result.sessions.length;
  } finally {
    sessionsLoading.value = false;
  }
}

// 历史列表滚动处理
const sessionListRef = ref<HTMLElement | null>(null);

function handleSessionListScroll(e: Event) {
  const el = e.target as HTMLElement;
  const threshold = 50;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
    loadMoreSessions();
  }
}

// Handle preset action click
function handlePresetAction(preset: PresetAction) {
  inputText.value = preset.content;
  // Focus the input
  nextTick(() => {
    const textarea = document.querySelector('.input-box textarea') as HTMLTextAreaElement;
    textarea?.focus();
  });
}

// Send message
async function sendMessage() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  if ((!text && !hasImages) || isLoading.value || isEditing.value) {
    return;
  }
  if (hasImages && !activeModelSupportsVision.value) {
    pendingImages.value = [];
    isImageDragActive.value = false;
    alert(i18n('currentModelNoVision'));
    return;
  }
  
  // 立即设置 loading 状态，防止重复调用
  isLoading.value = true;
  await captureLockedTab();
  toolStatus.value = null;
  chatAbortController.value?.abort();
  chatAbortController.value = new AbortController();

  const provider = await getActiveProvider();
  if (!provider) {
    chatAbortController.value = null;
    isLoading.value = false;
    releaseLockedTab();
    alert(i18n('noModelConfig'));
    openSettings();
    return;
  }

  if (!currentSession.value) {
    currentSession.value = await createSession(activeProviderId.value || undefined);
    await loadInitialSessions();
  }
  beginBrowserAutomationRun();

  const messageImages = pendingImages.value.map(image => ({ ...image }));
  const userMessage: ChatMessage = {
    role: 'user',
    content: text,
    timestamp: Date.now(),
    quote: pendingQuote.value || undefined,
    images: messageImages.length > 0 ? messageImages : undefined,
  };

  messages.value.push(userMessage);
  triggerRef(messages);
  inputText.value = '';
  pendingQuote.value = null;
  pendingImages.value = [];
  isImageDragActive.value = false;
  scrollToBottom();

  if (messages.value.length === 1) {
    currentSession.value.title = await generateSessionTitle(text || i18n('uploadImage'));
  }

  let assistantMessage: ChatMessage | null = null;
  try {
    assistantMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    messages.value.push(assistantMessage);
    triggerRef(messages);

    // 使用 ReAct 范式的流式聊天
    const reactConfig = {
      enableTools: true, // 默认启用工具
      toolExecutor,
      maxIterations: 10,
      maxToolCalls: maxToolCalls.value,
      abortSignal: chatAbortController.value.signal,
    };

    // 构建 Skills 信息
    const skillsInfo: SkillInfo[] = installedSkills.value.map(s => ({
      name: s.metadata.name,
      description: s.metadata.description,
    }));

    // 获取当前页面信息（优先使用锁定的 tabId）
    let pageInfo: { domain: string; title: string; url: string } | undefined;
    if (sharePageContent.value) {
      try {
        let tab: any = null;
        if (lockedTabId.value) {
          try {
            tab = await browser.tabs.get(lockedTabId.value);
          } catch {
            // 锁定标签页已关闭，回退
          }
        }
        if (!tab) {
          tab = await getTargetTab();
        }
        if (tab?.url && tab?.title) {
          const urlObj = new URL(tab.url);
          pageInfo = {
            domain: urlObj.hostname,
            title: tab.title,
            url: tab.url,
          };
        }
      } catch (e) {
        console.error('Failed to get page info:', e);
      }
    }

    // 获取当前语言设置
    const currentLanguage = await getLanguage();

    // 获取之前保存的 API 上下文（包含完整的工具调用历史）
    const previousApiMessages = currentSession.value?.apiMessages || getLastApiMessages();
    // 只有当之前有消息时才传入（排除只有 system 消息的情况）
    const hasValidPreviousContext = previousApiMessages.length > 1;

    for await (const event of streamChat(
      provider,
      messages.value.slice(0, -1),
      {
        sharePageContent: sharePageContent.value,
        skills: skillsInfo,
        mcpTools: mcpTools.value,
        browserAutomationAvailable,
        browserVisionAvailable: browserAutomationAvailable && activeModelSupportsVision.value,
        pageInfo,
        language: currentLanguage,
      },
      reactConfig,
      undefined, // retryConfig 使用默认值
      hasValidPreviousContext ? previousApiMessages : undefined
    )) {
      switch (event.type) {
        case 'reasoning':
          // 思维链内容（如 DeepSeek reasoning_content）
          if (!assistantMessage.reasoning) {
            assistantMessage.reasoning = '';
          }
          assistantMessage.reasoning += event.content;
          triggerRef(messages);
          break;
        case 'content':
          assistantMessage.content += event.content;
          triggerRef(messages);
          // 不自动滚动，让用户自行控制查看位置
          break;
        case 'tool_call':
          isLoading.value = true; // 工具调用时显示 loading
          toolStatus.value = getToolStatusText(event.toolCall.name, event.toolCall.arguments);
          break;
        case 'thinking':
          toolStatus.value = event.message;
          break;
        case 'tool_result':
          // 工具执行完成，清除状态
          toolStatus.value = null;
          if (assistantMessage.content && !assistantMessage.content.endsWith('\n')) {
            assistantMessage.content += '\n';
          }
          triggerRef(messages);
          break;
        case 'done':
          toolStatus.value = null;
          // 清理末尾空白
          assistantMessage.content = assistantMessage.content.trim();
          if (assistantMessage.reasoning) {
            assistantMessage.reasoning = assistantMessage.reasoning.trim();
          }
          break;
      }
    }
    
    assistantMessage.timestamp = Date.now();
  } catch (error: any) {
    const isUserAborted = error instanceof ApiError && error.code === 'USER_ABORTED';

    if (isUserAborted) {
      if (assistantMessage && !assistantMessage.content.trim() && !(assistantMessage.reasoning || '').trim()) {
        const lastMessage = messages.value[messages.value.length - 1];
        if (lastMessage === assistantMessage) {
          messages.value.pop();
          triggerRef(messages);
        }
      }
    } else {
      messages.value.push({
        role: 'assistant',
        content: `错误: ${error.message}`,
        timestamp: Date.now(),
      });
      triggerRef(messages);
    }
  } finally {
    await endBrowserAutomationRun(!browserAutomationWasStopped.value);
    chatAbortController.value = null;
    isLoading.value = false;
    releaseLockedTab();
    toolStatus.value = null;
    // 不自动滚动，让用户自行控制查看位置
    await saveCurrentSession();
  }
}

// Handle Enter key
function handleKeydown(e: KeyboardEvent) {
  if (!shouldSubmitOnEnter({
    key: e.key,
    shiftKey: e.shiftKey,
    isComposing: e.isComposing || isInputComposing.value,
    keyCode: e.keyCode,
    which: e.which,
  })) return;

  e.preventDefault();
  sendMessage();
}

// Textarea ref for auto-resize
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const isInputComposing = ref(false);

function handleCompositionStart() {
  isInputComposing.value = true;
}

function handleCompositionEnd() {
  isInputComposing.value = false;
}

function autoResizeTextarea() {
  const textarea = textareaRef.value;
  if (!textarea) return;
  
  textarea.style.height = 'auto';
  const lineHeight = 22;
  const maxLines = 6;
  const maxHeight = lineHeight * maxLines;
  const paddingY = 24;
  
  const newHeight = Math.min(textarea.scrollHeight, maxHeight + paddingY);
  textarea.style.height = `${newHeight}px`;
}

watch(inputText, () => {
  nextTick(autoResizeTextarea);
});

// New chat
async function newChat() {
  currentSession.value = null;
  messages.value = [];
  setLastApiMessages([]); // 清空 API 上下文
  pendingImages.value = [];
  isImageDragActive.value = false;
  showHistory.value = false;
}

// Open history modal
async function openHistory() {
  await loadInitialSessions();
  showHistory.value = true;
}

// Load session
async function loadSession(session: ChatSession) {
  currentSession.value = session;
  messages.value = session.messages;
  // 恢复 API 上下文
  if (session.apiMessages) {
    setLastApiMessages(session.apiMessages);
  } else {
    setLastApiMessages([]);
  }
  await setCurrentSessionId(session.id);
  showHistory.value = false;
  scrollToBottom();
}

// Delete session
async function removeSession(id: string, e: Event) {
  e.stopPropagation();
  if (confirm(i18n('confirmDeleteChat'))) {
    await deleteSession(id);
    sessions.value = await getAllSessions();
    if (currentSession.value?.id === id) {
      if (sessions.value.length > 0) {
        await loadSession(sessions.value[0]);
      } else {
        currentSession.value = null;
        messages.value = [];
      }
    }
  }
}

// Open settings page
function openSettings() {
  browser.runtime.openOptionsPage();
}

const surfaceToggleTitle = computed(() => {
  return i18n(isWindowSurface.value ? 'switchToSidepanel' : 'switchToWindow');
});

async function switchSurfaceMode() {
  const targetMode: AssistantDisplayMode = isWindowSurface.value ? 'sidepanel' : 'window';
  const directSurfaceContext = {
    tabId: hostSurfaceContext.value.tabId,
    windowId: hostSurfaceContext.value.windowId,
  };

  if (
    isWindowSurface.value &&
    (browser as any).sidePanel?.open &&
    directSurfaceContext.windowId !== null
  ) {
    try {
      await (browser as any).sidePanel.open({ windowId: directSurfaceContext.windowId });
      await setAssistantDisplayMode('sidepanel');
      await browser.runtime.sendMessage({
        type: 'CLOSE_ASSISTANT_WINDOW',
        assistantWindowId: currentAssistantWindowId.value,
      });
      return;
    } catch (error) {
      console.error('Failed to switch assistant surface directly:', error);
    }
  }

  const surfaceContext = await resolveSurfaceContext();

  if (surfaceContext.windowId === null && surfaceContext.tabId === null) {
    console.error('Failed to resolve a valid surface context for assistant switch');
    return;
  }

  await setAssistantDisplayMode(targetMode);

  const message: Record<string, any> = {
    type: 'SWITCH_ASSISTANT_SURFACE',
    targetMode,
    context: surfaceContext,
  };

  if (isWindowSurface.value) {
    message.assistantWindowId = currentAssistantWindowId.value;
  }

  try {
    await browser.runtime.sendMessage(message);
  } catch (error) {
    console.error('Failed to switch assistant surface:', error);
  }
}

// Select provider and model
async function selectProviderModel(providerId: string, model: string) {
  // 从 storage 重新获取最新的 provider 数据，避免使用可能不完整的内存数据
  const { getProvider } = await import('../../utils/storage');
  const freshProvider = await getProvider(providerId);
  
  if (!freshProvider) {
    console.error('Provider not found in storage:', providerId);
    return;
  }
  
  // 验证 provider 数据完整性
  if (!Array.isArray(freshProvider.models) || freshProvider.models.length === 0) {
    console.error('Provider data corrupted, skipping save:', freshProvider);
    return;
  }
  
  // 验证要选择的模型确实存在于 provider 的模型列表中
  if (!freshProvider.models.includes(model)) {
    console.error('Model not found in provider:', model, freshProvider.models);
    return;
  }
  
  // 只有当模型确实改变时才保存
  if (freshProvider.selectedModel !== model) {
    freshProvider.selectedModel = model;
    await saveProviderToDB(freshProvider);
    // 更新本地状态
    const localProvider = providers.value.find((p: AIProvider) => p.id === providerId);
    if (localProvider) {
      localProvider.selectedModel = model;
    }
  }
  
  // 设置为当前活跃的 provider
  activeProviderId.value = providerId;
  await setActiveProviderId(providerId);
  showModelSelector.value = false;
}

// 调试面板实时刷新定时器
let debugRefreshTimer: ReturnType<typeof setInterval> | null = null;

// 查看调试信息
function viewDebugMessages() {
  // 始终从内存获取最新的 API 上下文（lastApiMessages 是实时更新的）
  // 只有当内存中没有数据时，才从会话中获取持久化的数据
  const memoryApiMessages = getLastApiMessages();
  if (memoryApiMessages.length > 0) {
    debugApiMessages.value = memoryApiMessages;
  } else if (currentSession.value?.apiMessages?.length) {
    debugApiMessages.value = currentSession.value.apiMessages;
  } else {
    debugApiMessages.value = [];
  }
  showDebugModal.value = true;
  
  // 启动实时刷新（每 500ms 更新一次）
  if (debugRefreshTimer) {
    clearInterval(debugRefreshTimer);
  }
  debugRefreshTimer = setInterval(() => {
    // 始终从内存获取最新数据
    const latestApiMessages = getLastApiMessages();
    if (latestApiMessages.length > 0) {
      debugApiMessages.value = latestApiMessages;
    }
  }, 500);
}

// 关闭调试面板时停止刷新
function closeDebugModal() {
  showDebugModal.value = false;
  if (debugRefreshTimer) {
    clearInterval(debugRefreshTimer);
    debugRefreshTimer = null;
  }
}

// 复制调试信息到剪贴板
function copyDebugMessages() {
  const text = JSON.stringify(debugApiMessages.value, null, 2);
  navigator.clipboard.writeText(text);
}

// 格式化 tool_calls 显示
function formatToolCalls(toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>): string {
  return toolCalls.map(tc => {
    let args = tc.function.arguments;
    try {
      args = JSON.stringify(JSON.parse(args), null, 2);
    } catch {}
    return `${tc.function.name}(${args})`;
  }).join('\n');
}

function formatDebugContent(content: ApiMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') {
      return part.text;
    }
    const truncatedUrl = part.image_url.url.length > 120
      ? `${part.image_url.url.slice(0, 120)}...`
      : part.image_url.url;
    return `[image]\n${truncatedUrl}`;
  }).join('\n\n');
}

// 脚本确认处理
function confirmScript(trustForever: boolean) {
  if (pendingScriptConfirm.value) {
    pendingScriptConfirm.value.resolve({ confirmed: true, trustForever });
    pendingScriptConfirm.value = null;
    showScriptConfirmModal.value = false;
  }
}

function rejectScript() {
  if (pendingScriptConfirm.value) {
    pendingScriptConfirm.value.resolve({ confirmed: false, trustForever: false });
    pendingScriptConfirm.value = null;
    showScriptConfirmModal.value = false;
  }
}
</script>

<template>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1><a href="https://tactus.cc.cd/" target="_blank" rel="noopener noreferrer" class="brand-link">Tactus</a></h1>
      <div class="header-actions">
        <!-- Theme Selector -->
        <div class="theme-selector-wrapper">
          <button class="icon-btn" @click="showThemeSelector = !showThemeSelector" :title="currentLanguage === 'zh-CN' ? '主题' : 'Theme'">
            <!-- Sun icon for light -->
            <svg v-if="currentThemeIcon === 'light'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            <!-- Moon icon for dark -->
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
            </svg>
          </button>
          <!-- Theme dropdown -->
          <div v-if="showThemeSelector" class="theme-dropdown">
            <div class="theme-option" :class="{ active: currentThemeMode === 'light' }" @click="changeThemeMode('light')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="5"/>
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
              <span>{{ currentLanguage === 'zh-CN' ? '浅色' : 'Light' }}</span>
            </div>
            <div class="theme-option" :class="{ active: currentThemeMode === 'dark' }" @click="changeThemeMode('dark')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
              </svg>
              <span>{{ currentLanguage === 'zh-CN' ? '深色' : 'Dark' }}</span>
            </div>
            <div class="theme-option" :class="{ active: currentThemeMode === 'system' }" @click="changeThemeMode('system')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <path d="M8 21h8M12 17v4"/>
              </svg>
              <span>{{ currentLanguage === 'zh-CN' ? '跟随系统' : 'System' }}</span>
            </div>
          </div>
          <div v-if="showThemeSelector" class="theme-backdrop" @click="showThemeSelector = false"></div>
        </div>
        <button class="icon-btn" @click="switchSurfaceMode" :title="surfaceToggleTitle">
          <svg v-if="!isWindowSurface" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="14" rx="2"/>
            <path d="M8 20h8"/>
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 5h16"/>
            <path d="M4 12h16"/>
            <path d="M4 19h10"/>
            <rect x="15" y="14" width="6" height="5" rx="1"/>
          </svg>
        </button>
        <button class="icon-btn" @click="viewDebugMessages" title="API Context">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
          </svg>
        </button>
        <button class="icon-btn" @click="newChat" :title="i18n('newChat')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
        <button class="icon-btn" @click="openHistory" :title="i18n('history')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        </button>
        <button class="icon-btn" @click="openSettings" :title="i18n('settings')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Chat area -->
    <div class="chat-area" ref="chatAreaRef">
      <div v-if="!messages.length" class="empty-state">
        <p>{{ i18n('welcomeMessage') }}</p>
        <p v-if="sharePageContent" class="empty-hint">
          {{ i18n('pageContentShared') }}
        </p>
      </div>

      <template v-for="(msg, idx) in messages" :key="idx">
        <!-- 在最后一条 assistant 消息上方显示 loading 状态 -->
        <div 
          v-if="isLoading && msg.role === 'assistant' && idx === messages.length - 1" 
          class="loading"
        >
          <div class="loading-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <span v-if="toolStatus">{{ toolStatus }}</span>
          <span v-else>{{ i18n('thinking') }}</span>
        </div>

        <div 
          class="message" 
          :class="msg.role"
          @mousemove="msg.role === 'assistant' ? handleMessageMouseMove($event, idx) : undefined"
        >
          <div v-if="msg.content || msg.reasoning || msg.images?.length" class="message-time">{{ formatTime(msg.timestamp) }}</div>
          
          <!-- 编辑模式 -->
          <div v-if="editingMessageIndex === idx" class="message-edit-mode">
            <!-- 引用内容（如果有） -->
            <div v-if="editingQuote" class="edit-quote">
              <div class="quote-content">"{{ editingQuote }}"</div>
              <button class="remove-quote-btn" @click="removeEditingQuote" title="移除引用">×</button>
            </div>
            
            <!-- 编辑文本框 -->
            <textarea
              v-model="editingContent"
              class="edit-textarea"
              rows="3"
              placeholder="编辑您的消息..."
              @keydown.ctrl.enter="saveEditMessage"
              @keydown.meta.enter="saveEditMessage"
              @keydown.esc="cancelEditMessage"
            ></textarea>
            
            <!-- 操作按钮 -->
            <div class="edit-actions">
              <button class="btn btn-outline btn-sm" @click="cancelEditMessage">
                {{ i18n('cancel') }}
              </button>
              <button class="btn btn-primary btn-sm" @click="saveEditMessage" :disabled="!editingContent.trim() && !(messages[idx]?.images?.length)">
                {{ i18n('send') }}
              </button>
            </div>
          </div>
          
          <!-- 正常显示模式 -->
          <template v-else>
            <div v-if="msg.quote" class="quote">"{{ msg.quote }}"</div>
            
            <!-- 消息操作按钮（顶部悬浮） -->
            <div class="message-actions" :class="{ 'force-hide': msg.role === 'assistant' && copyButtonPosition[idx] === 'bottom' }">
              <!-- 编辑按钮（仅用户消息） -->
              <button 
                v-if="msg.role === 'user' && !isEditing"
                class="message-action-btn edit-btn"
                @click="startEditMessage(idx)"
                :title="i18n('editMessage')"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              
              <!-- AI 消息顶部复制按钮 -->
              <button 
                v-if="msg.role === 'assistant' && msg.content && copyButtonPosition[idx] !== 'bottom'"
                class="message-action-btn copy-btn"
                @click="copyMessage(idx)"
                :title="copiedMessageIndex === idx ? i18n('copied') : i18n('copyMessage')"
                :class="{ copied: copiedMessageIndex === idx }"
              >
                <svg v-if="copiedMessageIndex !== idx" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </button>
            </div>
          
            <!-- 思维链折叠区域 -->
            <div v-if="msg.reasoning" class="reasoning-section">
              <button 
                class="reasoning-toggle"
                @click="toggleReasoning(idx)"
                :class="{ expanded: reasoningExpanded[idx] }"
              >
                <svg class="reasoning-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                </svg>
                <span class="reasoning-label">{{ currentLanguage === 'zh-CN' ? '思维链' : 'Reasoning' }}</span>
                <svg class="reasoning-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>
              <div v-if="reasoningExpanded[idx]" class="reasoning-content">
                <div class="reasoning-text" v-html="renderMarkdown(msg.reasoning)"></div>
              </div>
            </div>

            <div v-if="msg.images?.length" class="message-image-grid">
              <div v-for="image in msg.images" :key="image.id" class="message-image-item">
                <img :src="image.dataUrl" :alt="image.name" />
              </div>
            </div>

            <div v-if="msg.role === 'assistant'" class="markdown-content" v-html="renderMarkdown(msg.content)"></div>
            <div v-else-if="msg.content" v-html="msg.content.replace(/\n/g, '<br>')"></div>
            
            <!-- AI 消息底部复制按钮（悬浮显示，仅当鼠标在下半部分时） -->
            <div v-if="msg.role === 'assistant' && msg.content && copyButtonPosition[idx] === 'bottom'" class="message-actions-bottom">
              <button 
                class="message-action-btn copy-btn"
                @click="copyMessage(idx)"
                :title="copiedMessageIndex === idx ? i18n('copied') : i18n('copyMessage')"
                :class="{ copied: copiedMessageIndex === idx }"
              >
                <svg v-if="copiedMessageIndex !== idx" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </button>
            </div>
          </template>
        </div>
      </template>

      <!-- 当没有 assistant 消息时（刚发送用户消息），显示 loading -->
      <div 
        v-if="isLoading && (messages.length === 0 || messages[messages.length - 1].role !== 'assistant')" 
        class="loading"
      >
        <div class="loading-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <span v-if="toolStatus">{{ toolStatus }}</span>
        <span v-else>{{ i18n('thinking') }}</span>
      </div>
    </div>

    <div
      v-if="selectionQuotePopup.visible"
      class="inline-selection-quote"
      :style="{ left: `${selectionQuotePopup.x}px`, top: `${selectionQuotePopup.y}px` }"
    >
      <button class="inline-selection-btn" @mousedown.stop @mouseup.stop @click="useSidepanelSelectionQuote">
        {{ i18n('quoteSelection') }}
      </button>
    </div>

    <!-- Input area -->
    <div class="input-area">
      <!-- Preset Actions Bar -->
      <div v-if="presetActions.length > 0" class="preset-actions-bar">
        <button
          v-for="preset in presetActions"
          :key="preset.id"
          class="preset-action-btn"
          :title="preset.content"
          @click="handlePresetAction(preset)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          {{ preset.name }}
        </button>
      </div>

      <div class="tab-share-stack">
        <div v-if="showSharePageHint" class="tab-share-hint" role="status">
          <div class="tab-share-hint-label">{{ currentLanguage === 'zh-CN' ? '网页共享' : 'Page Share' }}</div>
          <p class="tab-share-hint-text">{{ sharePageHintText }}</p>
          <button
            class="tab-share-hint-close"
            type="button"
            :title="currentLanguage === 'zh-CN' ? '关闭提示' : 'Dismiss hint'"
            @click="dismissSharePageHint"
          >
            ×
          </button>
        </div>

        <div class="tab-share-row">
          <button
            class="current-tab-chip"
            :class="{ active: sharePageContent, disabled: !activeTabInfo, locked: isTabLocked, 'glow-animation': isTabLocked }"
            :disabled="!activeTabInfo || isTabLocked"
            :title="activeTabButtonTitle"
            @click="toggleShareCurrentTab"
          >
            <span v-if="isTabLocked" class="lock-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
            </span>
            <span class="tab-favicon" :class="{ placeholder: !activeTabInfo?.faviconUrl }">
              <img v-if="activeTabInfo?.faviconUrl" :src="activeTabInfo.faviconUrl" alt="" />
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="9"/>
                <path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18"/>
              </svg>
            </span>
            <span class="tab-title">{{ activeTabInfo?.title || i18n('currentTab') }}</span>
          </button>
        </div>

      </div>

      <div v-if="pendingQuote" class="pending-quote">
        <div class="quote-text">"{{ pendingQuote }}"</div>
        <button class="remove-quote" @click="pendingQuote = null">×</button>
      </div>
      <div v-if="pendingImages.length > 0" class="pending-images">
        <div v-for="image in pendingImages" :key="image.id" class="pending-image-item">
          <img :src="image.dataUrl" :alt="image.name" />
          <button class="pending-image-remove" :title="i18n('removeImage')" @click="removePendingImage(image.id)">
            ×
          </button>
        </div>
      </div>
      <div
        class="input-box"
        :class="{ 'drag-active': isImageDragActive }"
        @dragenter.prevent="handleInputBoxDragEnter"
        @dragover.prevent="handleInputBoxDragOver"
        @dragleave="handleInputBoxDragLeave"
        @drop.prevent="handleInputBoxDrop"
      >
        <div v-if="activeModelSupportsVision" class="image-upload-hint" :class="{ active: isImageDragActive }">
          <span>{{ isImageDragActive ? i18n('dragImageHere') : i18n('imageUploadHint') }}</span>
        </div>
        <textarea
          ref="textareaRef"
          v-model="inputText"
          :placeholder="i18n('inputPlaceholder')"
          rows="1"
          @keydown="handleKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
          @paste="handleInputPaste"
        ></textarea>
        <div class="input-actions">
          <button v-if="activeModelSupportsVision" class="upload-btn" @click="openImagePicker" :title="i18n('uploadImage')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </button>
          <input
            v-if="activeModelSupportsVision"
            ref="imageInputRef"
            class="image-input"
            type="file"
            accept="image/*"
            multiple
            @change="handleImageInputChange"
          />
          <!-- Model selector -->
          <div class="model-selector-wrapper">
            <button 
              class="model-selector-btn" 
              @click="showModelSelector = !showModelSelector"
              :title="activeProvider?.selectedModel || ''"
            >
              <span class="model-name">{{ activeModelName }}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </button>
            <!-- Model dropdown -->
            <div v-if="showModelSelector" class="model-dropdown">
              <div v-if="allModelOptions.length === 0" class="dropdown-empty">
                <span>{{ i18n('noProviders') }}</span>
                <button class="dropdown-settings-btn" @click="openSettings">{{ i18n('settings') }}</button>
              </div>
              <div v-else class="model-options-list">
                <div
                  v-for="(opt, idx) in allModelOptions"
                  :key="`${opt.providerId}-${opt.model}-${idx}`"
                  class="model-option"
                  :class="{ active: opt.providerId === activeProviderId && opt.model === activeProvider?.selectedModel }"
                  @click="selectProviderModel(opt.providerId, opt.model)"
                >
                  <span class="option-provider">{{ opt.providerName }}</span>
                  <span class="option-model">{{ opt.model }}</span>
                </div>
              </div>
            </div>
            <!-- Backdrop -->
            <div v-if="showModelSelector" class="model-backdrop" @click="showModelSelector = false"></div>
          </div>
          <button
            v-if="isLoading"
            class="stop-btn"
            type="button"
            :title="i18n('stop')"
            :aria-label="i18n('stop')"
            @click="terminateCurrentGeneration"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
          <!-- Send button -->
          <button class="send-btn" @click="sendMessage" :disabled="!canSendMessage">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div v-if="fullscreenCodeBlock" class="modal-overlay code-fullscreen-overlay" @click.self="closeFullscreenCodeBlock">
      <div class="modal code-fullscreen-modal">
        <div class="modal-header code-fullscreen-header">
          <div class="code-fullscreen-meta">
            <h2>{{ codePreviewTitle }}</h2>
            <span class="code-fullscreen-language">{{ fullscreenLanguageLabel }}</span>
          </div>
          <div class="code-fullscreen-actions">
            <button class="copy-btn" @click="copyFullscreenCodeBlock" :title="i18n('copy')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              {{ i18n('copy') }}
            </button>
            <button class="close-btn" @click="closeFullscreenCodeBlock">×</button>
          </div>
        </div>
        <div class="code-fullscreen-body">
          <pre><code>{{ fullscreenCodeBlock.code }}</code></pre>
        </div>
      </div>
    </div>

    <!-- History Modal -->
    <div v-if="showHistory" class="modal-overlay" @click.self="showHistory = false">
      <div class="modal">
        <div class="modal-header">
          <h2>{{ i18n('history') }}</h2>
          <button class="close-btn" @click="showHistory = false">×</button>
        </div>
        <div class="modal-body">
          <div v-if="sessions.length === 0" class="empty-history">
            {{ currentLanguage === 'zh-CN' ? '暂无历史对话' : 'No chat history' }}
          </div>
          <div v-else class="session-list" ref="sessionListRef" @scroll="handleSessionListScroll">
            <div
              v-for="session in sessions"
              :key="session.id"
              class="session-item"
              :class="{ active: session.id === currentSession?.id }"
              @click="loadSession(session)"
            >
              <div class="session-info">
                <div class="session-title">{{ session.title }}</div>
                <div class="session-meta">
                  <span>{{ session.messages?.length || 0 }} {{ currentLanguage === 'zh-CN' ? '条消息' : 'messages' }}</span>
                  <span>{{ formatSessionDate(session.updatedAt) }}</span>
                </div>
              </div>
              <button class="delete-session-btn" @click="removeSession(session.id, $event)" :title="i18n('delete')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                </svg>
              </button>
            </div>
            <!-- 加载更多提示 -->
            <div v-if="sessionsLoading" class="session-loading">
              <span>{{ i18n('loading') }}</span>
            </div>
            <div v-else-if="!sessionsHasMore && sessions.length > 0" class="session-end">
              <span>{{ currentLanguage === 'zh-CN' ? '没有更多了' : 'No more' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Debug Modal -->
    <div v-if="showDebugModal" class="modal-overlay" @click.self="closeDebugModal">
      <div class="modal debug-modal">
        <div class="modal-header">
          <h2>{{ currentLanguage === 'zh-CN' ? 'API 上下文调试' : 'API Context Debug' }}</h2>
          <div class="debug-header-actions">
            <button class="copy-btn" @click="copyDebugMessages" title="Copy JSON">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              复制
            </button>
            <button class="close-btn" @click="closeDebugModal">×</button>
          </div>
        </div>
        <div class="modal-body debug-body">
          <div v-if="debugApiMessages.length === 0" class="empty-history">
            暂无 API 消息记录，请先发送一条消息
          </div>
          <div v-else class="debug-messages">
            <div 
              v-for="(msg, idx) in debugApiMessages" 
              :key="idx" 
              class="debug-message"
              :class="msg.role"
            >
              <div class="debug-role">
                <template v-if="msg.role === 'tool'">
                  🔧 tool{{ msg.name ? ` (${msg.name})` : '' }}
                </template>
                <template v-else-if="msg.role === 'assistant' && msg.tool_calls?.length">
                  assistant → 调用工具
                </template>
                <template v-else>{{ msg.role }}</template>
              </div>
              <!-- 思维链内容 -->
              <div v-if="msg.reasoning" class="debug-reasoning">
                <div class="debug-reasoning-label">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                  </svg>
                  {{ currentLanguage === 'zh-CN' ? '思维链' : 'Reasoning' }}
                </div>
                <pre class="debug-content debug-reasoning-content">{{ msg.reasoning }}</pre>
              </div>
              <pre v-if="msg.content !== null && msg.content !== undefined" class="debug-content">{{ formatDebugContent(msg.content) }}</pre>
              <pre v-if="msg.tool_calls?.length" class="debug-content debug-tool-calls">{{ formatToolCalls(msg.tool_calls) }}</pre>
              <div
                v-if="((Array.isArray(msg.content) ? msg.content.length === 0 : (msg.content === null || msg.content === undefined || msg.content === '')) && !msg.tool_calls?.length && !msg.reasoning)"
                class="debug-empty"
              >
                {{ currentLanguage === 'zh-CN' ? '(空)' : '(empty)' }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Browser Automation Confirm Modal -->
    <div v-if="showBrowserAutomationConfirmModal && pendingBrowserAutomationConfirm" class="modal-overlay">
      <div class="modal browser-automation-confirm-modal">
        <div class="modal-header">
          <h2>{{ pendingBrowserAutomationConfirm.title }}</h2>
        </div>
        <div class="modal-body">
          <div class="browser-automation-confirm-copy">
            <p>{{ pendingBrowserAutomationConfirm.message }}</p>
          </div>
          <div v-if="pendingBrowserAutomationConfirm.risk" class="browser-automation-risk">
            <div class="browser-automation-risk-label">
              {{ pendingBrowserAutomationConfirm.risk.level === 'destructive'
                ? (currentLanguage === 'zh-CN' ? '高风险操作' : 'High-risk action')
                : (currentLanguage === 'zh-CN' ? '敏感操作' : 'Sensitive action') }}
            </div>
            <div v-if="pendingBrowserAutomationConfirm.risk.preview" class="browser-automation-risk-preview">
              {{ pendingBrowserAutomationConfirm.risk.preview }}
            </div>
            <div v-if="pendingBrowserAutomationConfirm.risk.reasons.length" class="browser-automation-risk-reasons">
              {{ pendingBrowserAutomationConfirm.risk.reasons.join(' · ') }}
            </div>
          </div>
          <div class="browser-automation-confirm-note">
            {{ currentLanguage === 'zh-CN'
              ? '你可以随时点击停止；Tactus 会停止页面操作，并保留已打开的结果页。'
              : 'You can stop at any time. Tactus will stop page actions and keep opened result tabs.' }}
          </div>
          <div class="script-confirm-actions">
            <button class="btn btn-outline" @click="resolveBrowserAutomationConfirmation(false)">{{ i18n('cancel') }}</button>
            <button class="btn btn-primary" @click="resolveBrowserAutomationConfirmation(true)">{{ browserAutomationConfirmPrimaryLabel }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Script Confirm Modal -->
    <div v-if="showScriptConfirmModal && pendingScriptConfirm" class="modal-overlay">
      <div class="modal script-confirm-modal">
        <div class="modal-header">
          <h2>{{ currentLanguage === 'zh-CN' ? '脚本执行确认' : 'Script Execution Confirm' }}</h2>
        </div>
        <div class="modal-body">
          <div class="script-confirm-info">
            <p>{{ currentLanguage === 'zh-CN' ? 'Skill' : 'Skill' }} <strong>{{ pendingScriptConfirm.request.skillName }}</strong> {{ currentLanguage === 'zh-CN' ? '请求执行以下脚本：' : 'requests to execute:' }}</p>
            <div class="script-name-display">{{ pendingScriptConfirm.request.scriptName }}</div>
          </div>
          <div class="script-preview">
            <div class="script-preview-label">{{ currentLanguage === 'zh-CN' ? '脚本内容预览' : 'Script Preview' }}</div>
            <pre>{{ pendingScriptConfirm.request.scriptContent.slice(0, 500) }}{{ pendingScriptConfirm.request.scriptContent.length > 500 ? '...' : '' }}</pre>
          </div>
          <div class="script-confirm-warning">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>{{ currentLanguage === 'zh-CN' ? '请确认脚本内容安全后再执行' : 'Please verify the script is safe before executing' }}</span>
          </div>
          <div class="script-confirm-actions">
            <button class="btn btn-outline" @click="rejectScript">{{ i18n('cancel') }}</button>
            <button class="btn btn-secondary" @click="confirmScript(false)">{{ currentLanguage === 'zh-CN' ? '执行一次' : 'Run Once' }}</button>
            <button class="btn btn-primary" @click="confirmScript(true)">{{ currentLanguage === 'zh-CN' ? '信任并执行' : 'Trust & Run' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
