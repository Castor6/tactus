import {
  getAssistantDisplayMode,
  getAssistantWindowBounds,
  watchAssistantDisplayMode,
  type AssistantDisplayMode,
} from '../utils/storage';
import { createBrowserAutomationController } from '../utils/browserAutomation';

interface SurfaceContext {
  tabId?: number | null;
  windowId?: number | null;
}

const ASSISTANT_WINDOW_ID_STORAGE_KEY = 'assistantWindowId';

async function getStoredAssistantWindowId(): Promise<number | null> {
  const result = await browser.storage.local.get(ASSISTANT_WINDOW_ID_STORAGE_KEY);
  const windowId = result[ASSISTANT_WINDOW_ID_STORAGE_KEY];
  return typeof windowId === 'number' ? windowId : null;
}

async function setStoredAssistantWindowId(windowId: number | null): Promise<void> {
  if (typeof windowId === 'number') {
    await browser.storage.local.set({ [ASSISTANT_WINDOW_ID_STORAGE_KEY]: windowId });
    return;
  }
  await browser.storage.local.remove(ASSISTANT_WINDOW_ID_STORAGE_KEY);
}

async function resolveActiveTabForWindow(windowId: number): Promise<any | null> {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  return tab ?? null;
}

async function resolveSurfaceContext(messageContext?: SurfaceContext, sender?: any): Promise<{
  tabId: number | null;
  windowId: number | null;
}> {
  let tabId = typeof messageContext?.tabId === 'number' ? messageContext.tabId : sender?.tab?.id ?? null;
  let windowId = typeof messageContext?.windowId === 'number' ? messageContext.windowId : sender?.tab?.windowId ?? null;

  if (tabId === null && windowId !== null) {
    const tab = await resolveActiveTabForWindow(windowId);
    tabId = tab?.id ?? null;
  }

  if (tabId === null || windowId === null) {
    const [fallbackTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabId === null) {
      tabId = fallbackTab?.id ?? null;
    }
    if (windowId === null) {
      windowId = typeof fallbackTab?.windowId === 'number' ? fallbackTab.windowId : null;
    }
  }

  if (windowId === null) {
    try {
      const focusedWindow = await browser.windows.getLastFocused();
      windowId = focusedWindow?.id ?? null;
    } catch {
      windowId = null;
    }
  }

  return { tabId, windowId };
}

async function openSidePanel(tabId?: number | null, windowId?: number | null): Promise<void> {
  let resolvedTabId = typeof tabId === 'number' ? tabId : null;
  let resolvedWindowId = typeof windowId === 'number' ? windowId : null;

  if (resolvedTabId === null && typeof windowId === 'number') {
    const tab = await resolveActiveTabForWindow(windowId);
    resolvedTabId = tab?.id ?? null;
  }

  if (resolvedTabId === null) {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    resolvedTabId = tab?.id ?? null;
    resolvedWindowId = typeof tab?.windowId === 'number' ? tab.windowId : resolvedWindowId;
  }

  const sidePanelApi = (browser as any).sidePanel;
  if (sidePanelApi?.open && (resolvedWindowId || resolvedTabId)) {
    await sidePanelApi.open(resolvedWindowId ? { windowId: resolvedWindowId } : { tabId: resolvedTabId });
    return;
  }

  const sidebarActionApi = (browser as any).sidebarAction;
  if (sidebarActionApi?.open) {
    await sidebarActionApi.open();
    return;
  }

  throw new Error('当前浏览器不支持侧边栏 API');
}

async function closeSidePanel(sidePanelPort: any): Promise<void> {
  const sidebarActionApi = (browser as any).sidebarAction;
  if (sidePanelPort && sidebarActionApi?.close) {
    await sidebarActionApi.close();
    return;
  }

  if (sidePanelPort) {
    sidePanelPort.postMessage({ type: 'CLOSE' });
    return;
  }

  const sidebarToggleApi = (browser as any).sidebarAction;
  if (sidebarToggleApi?.toggle) {
    await sidebarToggleApi.toggle();
  }
}

function buildAssistantWindowUrl(context: { tabId: number | null; windowId: number | null }): string {
  const params = new URLSearchParams();
  if (context.tabId !== null) {
    params.set('hostTabId', String(context.tabId));
  }
  if (context.windowId !== null) {
    params.set('hostWindowId', String(context.windowId));
  }

  const suffix = params.toString();
  return browser.runtime.getURL(`/assistant-window.html${suffix ? `?${suffix}` : ''}` as any);
}

async function focusAssistantWindow(context?: { tabId: number | null; windowId: number | null }): Promise<boolean> {
  const existingWindowId = await getStoredAssistantWindowId();
  if (existingWindowId === null) return false;

  try {
    await browser.windows.update(existingWindowId, { focused: true });
    if (context) {
      await browser.runtime.sendMessage({
        type: 'ASSISTANT_HOST_CONTEXT_UPDATED',
        context,
      });
    }
    return true;
  } catch {
    await setStoredAssistantWindowId(null);
    return false;
  }
}

async function openAssistantWindow(context: { tabId: number | null; windowId: number | null }): Promise<void> {
  const wasFocused = await focusAssistantWindow(context);
  if (wasFocused) return;

  const bounds = await getAssistantWindowBounds();
  const createdWindow = await browser.windows.create({
    url: buildAssistantWindowUrl(context),
    type: 'popup',
    width: bounds.width,
    height: bounds.height,
    focused: true,
  });

  await setStoredAssistantWindowId(createdWindow?.id ?? null);
}

async function closeAssistantWindow(windowId?: number | null): Promise<void> {
  const targetWindowId = typeof windowId === 'number' ? windowId : await getStoredAssistantWindowId();
  if (targetWindowId === null) return;

  try {
    await browser.windows.remove(targetWindowId);
  } catch {
    // 窗口可能已经被用户关闭
  } finally {
    await setStoredAssistantWindowId(null);
  }
}

async function openAssistantSurface(mode: AssistantDisplayMode, context: { tabId: number | null; windowId: number | null }): Promise<void> {
  if (mode === 'window') {
    await openAssistantWindow(context);
    return;
  }

  await openSidePanel(context.tabId, context.windowId);
}

async function toggleAssistantSurface(
  mode: AssistantDisplayMode,
  context: { tabId: number | null; windowId: number | null },
  sidePanelPort: any,
): Promise<void> {
  if (mode === 'window') {
    const existingWindowId = await getStoredAssistantWindowId();
    if (existingWindowId !== null) {
      await closeAssistantWindow(existingWindowId);
      return;
    }

    await openAssistantWindow(context);
    return;
  }

  const sidePanelApi = (browser as any).sidePanel;
  if (sidePanelApi?.open) {
    if (sidePanelPort) {
      await closeSidePanel(sidePanelPort);
      return;
    }

    await openSidePanel(context.tabId, context.windowId);
    return;
  }

  const sidebarActionApi = (browser as any).sidebarAction;
  if (sidebarActionApi?.toggle) {
    await sidebarActionApi.toggle();
    return;
  }

  if (sidePanelPort) {
    await closeSidePanel(sidePanelPort);
    return;
  }

  await openSidePanel(context.tabId, context.windowId);
}

async function executeMainWorldScript(tabId: number, code: string): Promise<void> {
  const scriptingApi = (browser as any).scripting;
  if (scriptingApi?.executeScript) {
    await scriptingApi.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (injectedCode: string) => {
        const script = document.createElement('script');
        script.textContent = injectedCode;
        document.documentElement.appendChild(script);
        script.remove();
      },
      args: [code],
    });
    return;
  }

  const tabsApi = (browser as any).tabs;
  if (tabsApi?.executeScript) {
    const injectionCode = `
(() => {
  const script = document.createElement('script');
  script.textContent = ${JSON.stringify(code)};
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
})();`;
    await tabsApi.executeScript(tabId, { code: injectionCode });
    return;
  }

  throw new Error('当前浏览器不支持脚本注入 API');
}

async function readMainWorldResult(tabId: number, key: string): Promise<any> {
  const scriptingApi = (browser as any).scripting;
  if (scriptingApi?.executeScript) {
    const results = await scriptingApi.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (resultKey: string) => {
        const result = (window as any)[resultKey];
        if (result !== undefined && result !== null) {
          delete (window as any)[resultKey];
          return result;
        }
        return undefined;
      },
      args: [key],
    });

    return results?.[0]?.result;
  }

  const tabsApi = (browser as any).tabs;
  if (tabsApi?.executeScript) {
    const readCode = `
(() => {
  const resultKey = ${JSON.stringify(key)};
  const result = window[resultKey];
  if (result !== undefined && result !== null) {
    delete window[resultKey];
    return result;
  }
  return undefined;
})();`;

    const results = await tabsApi.executeScript(tabId, { code: readCode });
    return results?.[0];
  }

  throw new Error('当前浏览器不支持脚本读取 API');
}

// 执行脚本的核心逻辑
async function executeScriptInTab(tabId: number, code: string, args: Record<string, any>, scriptId: string): Promise<any> {
  const resultKey = `__skill_result_${scriptId}_${Date.now()}__`;

  const wrappedCode = `
(async () => {
  try {
    const __args__ = ${JSON.stringify(args || {})};
    const __result__ = await (async () => {
      ${code}
    })();
    window['${resultKey}'] = { success: true, data: __result__ };
  } catch (error) {
    window['${resultKey}'] = {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
})();
`;

  // 使用 script 标签注入执行，绕过 CSP
  await executeMainWorldScript(tabId, wrappedCode);

  // 轮询等待结果，最多 60 秒
  const maxWait = 60000;
  const interval = 1000;
  let waited = 0;

  while (waited < maxWait) {
    await new Promise(resolve => setTimeout(resolve, interval));
    waited += interval;

    const execResult = await readMainWorldResult(tabId, resultKey);
    if (execResult && typeof execResult === 'object' && 'success' in execResult) {
      if (execResult.success) {
        return execResult.data;
      }
      throw new Error(execResult.error);
    }
  }

  throw new Error('脚本执行超时');
}

export default defineBackground(() => {
  let currentDisplayMode: AssistantDisplayMode = 'sidepanel';
  const browserAutomation = createBrowserAutomationController();

  const updatePanelBehavior = async (mode: AssistantDisplayMode) => {
    currentDisplayMode = mode;
    const sidePanelApi = (browser as any).sidePanel;
    if (sidePanelApi?.setPanelBehavior) {
      await sidePanelApi.setPanelBehavior({
        openPanelOnActionClick: mode === 'sidepanel',
      });
    }
  };

  void getAssistantDisplayMode()
    .then(updatePanelBehavior)
    .catch((error) => {
      console.error('Failed to initialize assistant display mode:', error);
    });

  watchAssistantDisplayMode((mode) => {
    void updatePanelBehavior(mode).catch((error) => {
      console.error('Failed to update side panel behavior:', error);
    });
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
      const { initializeLanguage } = await import('../utils/storage');
      await initializeLanguage();
    }
  });

  let sidePanelPort: any = null;

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'sidepanel') {
      sidePanelPort = port;
      port.onDisconnect.addListener(() => {
        sidePanelPort = null;
      });
    }
  });

  browser.windows.onRemoved.addListener((windowId) => {
    getStoredAssistantWindowId().then((storedWindowId) => {
      if (storedWindowId === windowId) {
        void setStoredAssistantWindowId(null);
      }
    });
  });

  const actionApi = (browser as any).action ?? (browser as any).browserAction;
  actionApi?.onClicked?.addListener(async (tab: any) => {
    try {
      if (currentDisplayMode === 'sidepanel' && (browser as any).sidePanel?.setPanelBehavior) {
        return;
      }
      const context = await resolveSurfaceContext({
        tabId: tab?.id ?? null,
        windowId: tab?.windowId ?? null,
      });
      await toggleAssistantSurface(currentDisplayMode, context, sidePanelPort);
    } catch (error) {
      console.error('Failed to toggle assistant surface:', error);
    }
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'OPEN_SIDEPANEL') {
      const directContext = {
        tabId: typeof message.context?.tabId === 'number' ? message.context.tabId : sender?.tab?.id ?? null,
        windowId: typeof message.context?.windowId === 'number' ? message.context.windowId : sender?.tab?.windowId ?? null,
      };
      void openAssistantSurface(currentDisplayMode, directContext).catch((error) => {
        console.error('Failed to open assistant surface:', error);
      });
    }

    if (message.type === 'TOGGLE_SIDEPANEL') {
      const directContext = {
        tabId: typeof message.context?.tabId === 'number' ? message.context.tabId : sender?.tab?.id ?? null,
        windowId: typeof message.context?.windowId === 'number' ? message.context.windowId : sender?.tab?.windowId ?? null,
      };
      void toggleAssistantSurface(currentDisplayMode, directContext, sidePanelPort).catch((error) => {
        console.error('Failed to toggle assistant surface:', error);
      });
    }

    if (message.type === 'SWITCH_ASSISTANT_SURFACE') {
      resolveSurfaceContext(message.context, sender)
        .then(async (context) => {
          if (message.targetMode === 'window') {
            await openAssistantWindow(context);
            await closeSidePanel(sidePanelPort);
            return;
          }

          await openSidePanel(context.tabId, context.windowId);
          await closeAssistantWindow(message.assistantWindowId);
        })
        .catch((error) => {
          console.error('Failed to switch assistant surface:', error);
        });
    }

    if (message.type === 'CLOSE_ASSISTANT_WINDOW') {
      void closeAssistantWindow(message.assistantWindowId).catch((error) => {
        console.error('Failed to close assistant window:', error);
      });
    }

    if (message.type === 'SET_QUOTE') {
      browser.storage.local.set({ pendingQuote: message.quote });
    }

    if (message.type === 'EXECUTE_SKILL_SCRIPT') {
      const { tabId, code, args, scriptId } = message;
      executeScriptInTab(tabId, code, args, scriptId)
        .then(result => sendResponse({ success: true, result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }

    if (message.type === 'BROWSER_AUTOMATION_COMMAND') {
      const params = {
        ...(message.params || {}),
        session_id: message.sessionId,
        turn_id: message.turnId,
      };
      browserAutomation.execute(message.command, params)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      return true;
    }

    if (message.type === 'BROWSER_AUTOMATION_END') {
      browserAutomation.endSession(message.sessionId, { finalize: message.finalize === true })
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      return true;
    }

    return true;
  });

  (browser as any).sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});
