export type BrowserAutomationTabOrigin = 'agent' | 'user';
export type BrowserAutomationKeepStatus = 'deliverable' | 'handoff';

export interface BrowserAutomationSessionState {
  chromeGroupId: number | null;
  title: string;
  activeTabId: number | null;
  tabOrigins: Record<string, BrowserAutomationTabOrigin>;
  finalized?: boolean;
}

export interface BrowserAutomationStoredState {
  sessions: Record<string, BrowserAutomationSessionState>;
  deliverableGroupId: number | null;
}

export interface BrowserAutomationCommandResponse {
  success: boolean;
  result?: any;
  error?: string;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  risk?: BrowserAutomationRisk;
  meta?: BrowserAutomationMeta;
}

export interface BrowserAutomationMeta {
  sessionId: string;
  activeTabId: number | null;
  activeTabTitle?: string;
  activeTabUrl?: string;
  groupTitle?: string;
  lastAction: string;
}

export interface BrowserAutomationRisk {
  level: 'none' | 'sensitive' | 'destructive';
  reasons: string[];
  preview?: string;
}

const STORAGE_KEY = 'TACTUS_BROWSER_AUTOMATION_STATE';
const DEFAULT_SESSION_GROUP_TITLE = 'Tactus Task';
const DELIVERABLE_GROUP_TITLE = 'Tactus Results';
const DOM_NODE_ID_PROP = '__tactusAutomationNodeId';
const DOM_NEXT_ID_PROP = '__tactusAutomationNextNodeId';
const PLAYWRIGHT_INJECTED_GLOBAL = '__tactusPlaywrightInjected';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_DOM_NODE_LIMIT = 250;
const DEFAULT_NODE_TEXT_LIMIT = 500;
const DEFAULT_EXPORT_LIMIT = 60000;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(label);
  }
  return number;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function displayUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function sanitizeCommandParams(params: any): Record<string, any> {
  return isRecord(params) ? params : {};
}

function hasTabId(tab: any): tab is any & { id: number } {
  return typeof tab?.id === 'number';
}

function toBrowserTab(tab: any, groupTitle?: string): Record<string, any> {
  return {
    id: tab.id,
    title: tab.title,
    active: Boolean(tab.active),
    url: tab.url,
    ...(groupTitle ? { tabGroup: groupTitle } : {}),
  };
}

function compareLastAccessed(left: any, right: any): number {
  const byLastAccessed = (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
  if (byLastAccessed !== 0) return byLastAccessed;
  const byWindow = (left.windowId ?? 0) - (right.windowId ?? 0);
  return byWindow !== 0 ? byWindow : (left.index ?? 0) - (right.index ?? 0);
}

function isInternalTabUrl(url?: string): boolean {
  if (!url) return true;
  if (/^about:blank(?:[?#].*)?$/i.test(url)) return false;
  return /^(chrome|edge|about|moz-extension|chrome-extension):/i.test(url);
}

function modifierMask(keys: unknown): number {
  if (!Array.isArray(keys)) return 0;
  let mask = 0;
  for (const key of keys.flatMap(part => String(part).split('+'))) {
    const normalized = key.trim().toLowerCase();
    if (normalized === 'alt' || normalized === 'option') mask |= 1;
    if (normalized === 'control' || normalized === 'ctrl') mask |= 2;
    if (normalized === 'meta' || normalized === 'cmd' || normalized === 'command' || normalized === 'controlormeta') mask |= 4;
    if (normalized === 'shift') mask |= 8;
  }
  return mask;
}

function mouseButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === 'right' || value === 3) return 'right';
  if (value === 'middle' || value === 2) return 'middle';
  return 'left';
}

function buttonMask(button: 'left' | 'right' | 'middle'): number {
  if (button === 'left') return 1;
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 0;
}

function normalizeKeyChord(keys: unknown): string[] {
  if (!Array.isArray(keys)) {
    if (typeof keys === 'string' && keys.trim()) return [keys.trim()];
    throw new Error('keypress requires a non-empty keys array');
  }
  const parts = keys.flatMap(key => String(key).split('+').filter(Boolean));
  const joined = parts.map(part => part.toLowerCase()).join('+');
  const aliases: Record<string, string[]> = {
    'ctrl+a': ['ControlOrMeta', 'a'],
    'ctrl+c': ['ControlOrMeta', 'c'],
    'ctrl+l': ['ControlOrMeta', 'l'],
    'ctrl+v': ['ControlOrMeta', 'v'],
    'ctrl+x': ['ControlOrMeta', 'x'],
    'ctrl+z': ['ControlOrMeta', 'z'],
    'ctrl+shift+z': ['ControlOrMeta', 'Shift', 'z'],
    'cmd+a': ['ControlOrMeta', 'a'],
    'cmd+c': ['ControlOrMeta', 'c'],
    'cmd+l': ['ControlOrMeta', 'l'],
    'cmd+v': ['ControlOrMeta', 'v'],
    'cmd+x': ['ControlOrMeta', 'x'],
    'cmd+z': ['ControlOrMeta', 'z'],
  };
  return aliases[joined] ?? parts;
}

function normalizeKeyName(key: string): { key: string; code?: string; text?: string; windowsVirtualKeyCode?: number } {
  const platform = globalThis.navigator?.platform?.toLowerCase() ?? '';
  const normalized = key === 'ControlOrMeta' ? (platform.includes('mac') ? 'Meta' : 'Control') : key;
  const lower = normalized.toLowerCase();
  const special: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
    control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
    ctrl: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
    meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
    command: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
    cmd: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
    alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
    option: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  };
  if (special[lower]) return special[lower];
  if (normalized.length === 1) {
    const upper = normalized.toUpperCase();
    return {
      key: normalized,
      code: /^[a-z]$/i.test(normalized) ? `Key${upper}` : undefined,
      text: normalized,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  return { key: normalized };
}

function riskExpressionForElement(elementExpression: string): string {
  return `(() => {
    const element = ${elementExpression};
    if (!element) throw new Error("Target element was not found");
    const text = [
      element.innerText,
      element.value,
      element.alt,
      element.title,
      element.getAttribute("aria-label"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("placeholder"),
      element.getAttribute("autocomplete"),
      element.getAttribute("type")
    ].filter(Boolean).join(" ").trim();
    const haystack = text.toLowerCase();
    const destructive = /(delete|remove|discard|destroy|clear|reset|cancel order|close account|注销|删除|移除|清空|重置|销毁|取消订单)/i.test(haystack);
    const sensitive = /(\b(password|passcode|otp|2fa|verification code|credit card|debit card|card number|cvv|cvc|ssn|social security|identity|id card|passport|pay|payment|purchase|checkout|transfer|wire|bank account|submit order|place order|confirm order|submit payment|confirm payment)\b|密码|验证码|信用卡|银行卡|身份证|护照|支付|付款|购买|结账|转账|提交订单|确认订单|提交付款|确认付款|提交支付|确认支付)/i.test(haystack);
    const reasons = [];
    if (destructive) reasons.push("destructive keyword");
    if (sensitive) reasons.push("sensitive keyword or field");
    if (element.matches?.('input[type="password"], input[autocomplete*="cc-"], input[autocomplete*="one-time-code"]')) {
      reasons.push("sensitive input type");
    }
    return {
      level: destructive ? "destructive" : (reasons.length ? "sensitive" : "none"),
      reasons,
      preview: text.slice(0, 200)
    };
  })()`;
}

function domFindNodeExpression(nodeId: string): string {
  return `Array.from(document.querySelectorAll("*")).find((candidate) => candidate[${JSON.stringify(DOM_NODE_ID_PROP)}] === ${JSON.stringify(String(nodeId))})`;
}

function domSnapshotExpression(limit: number, textLimit: number): string {
  return `(() => {
    const idProp = ${JSON.stringify(DOM_NODE_ID_PROP)};
    const nextIdProp = ${JSON.stringify(DOM_NEXT_ID_PROP)};
    window[nextIdProp] = window[nextIdProp] || 1;
    const selector = [
      "a", "button", "input", "textarea", "select", "summary",
      "details", "label", "img", "video", "audio", "[role]",
      "[onclick]", "[contenteditable=true]", "[tabindex]"
    ].join(",");
    const viewport = window.visualViewport || { width: window.innerWidth, height: window.innerHeight, offsetLeft: 0, offsetTop: 0 };
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && rect.bottom >= 0 && rect.right >= 0 && rect.top <= viewport.height && rect.left <= viewport.width;
    };
    const accessibleText = (element) => [
      element.innerText,
      element.value,
      element.alt,
      element.title,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder")
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim().slice(0, ${textLimit});
    const stateFor = (element) => ({
      disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true",
      checked: !!element.checked || element.getAttribute("aria-checked") === "true",
      selected: !!element.selected,
      editable: element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName),
      expanded: element.getAttribute("aria-expanded"),
    });
    const riskFor = (element, text) => {
      const haystack = [
        text,
        element.getAttribute("name"),
        element.getAttribute("id"),
        element.getAttribute("type"),
        element.getAttribute("autocomplete")
      ].filter(Boolean).join(" ").toLowerCase();
      const destructive = /(delete|remove|discard|destroy|clear|reset|cancel order|close account|注销|删除|移除|清空|重置|销毁|取消订单)/i.test(haystack);
      const sensitive = /(\b(password|passcode|otp|2fa|verification code|credit card|debit card|card number|cvv|cvc|ssn|social security|identity|id card|passport|pay|payment|purchase|checkout|transfer|wire|bank account|submit order|place order|confirm order|submit payment|confirm payment)\b|密码|验证码|信用卡|银行卡|身份证|护照|支付|付款|购买|结账|转账|提交订单|确认订单|提交付款|确认付款|提交支付|确认支付)/i.test(haystack) || element.matches?.('input[type="password"], input[autocomplete*="cc-"], input[autocomplete*="one-time-code"]');
      return destructive ? "destructive" : (sensitive ? "sensitive" : "none");
    };
    const nodes = Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .slice(0, ${limit})
      .map((element) => {
        if (!element[idProp]) {
          Object.defineProperty(element, idProp, {
            configurable: true,
            value: String(window[nextIdProp]++),
          });
        }
        const rect = element.getBoundingClientRect();
        const text = accessibleText(element);
        return {
          node_id: element[idProp],
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          aria: element.getAttribute("aria-label"),
          text,
          type: element.getAttribute("type"),
          href: element.href || element.getAttribute("href"),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          state: stateFor(element),
          risk: riskFor(element, text)
        };
      });
    return {
      url: window.location.href,
      title: document.title,
      viewport: {
        width: viewport.width,
        height: viewport.height,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      nodeCount: nodes.length,
      truncated: document.querySelectorAll(selector).length > nodes.length,
      nodes
    };
  })()`;
}

function playwrightInjectionExpression(): string {
  return `(() => {
    if (window.${PLAYWRIGHT_INJECTED_GLOBAL}) return true;
    const isVisible = (element) => {
      if (!element || !element.isConnected) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    window.${PLAYWRIGHT_INJECTED_GLOBAL} = {
      parseSelector: (selector) => String(selector || ""),
      querySelectorAll: (selector, root) => {
        const value = String(selector || "");
        if (value.startsWith("text=")) {
          const needle = value.slice(5).replace(/^["']|["']$/g, "").toLowerCase();
          return Array.from((root || document).querySelectorAll("*")).filter((element) => (element.innerText || element.textContent || "").toLowerCase().includes(needle));
        }
        return Array.from((root || document).querySelectorAll(value));
      },
      elementState: (element, state) => {
        if (!element || !element.isConnected) return { matches: false, received: "error:notconnected" };
        if (state === "visible") {
          const visible = isVisible(element);
          return { matches: visible, received: visible ? "visible" : "hidden" };
        }
        if (state === "hidden") {
          const visible = isVisible(element);
          return { matches: !visible, received: visible ? "visible" : "hidden" };
        }
        if (state === "enabled" || state === "disabled") {
          const disabled = !!element.disabled || element.getAttribute("aria-disabled") === "true";
          return { matches: state === "disabled" ? disabled : !disabled, received: disabled ? "disabled" : "enabled" };
        }
        if (state === "editable") {
          const editable = element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
          return { matches: editable && !element.disabled && !element.readOnly, received: editable ? "editable" : "readOnly" };
        }
        if (state === "checked" || state === "unchecked") {
          const checked = !!element.checked || element.getAttribute("aria-checked") === "true";
          return { matches: state === "checked" ? checked : !checked, received: checked ? "checked" : "unchecked", isRadio: element.type === "radio" };
        }
        return { matches: false, received: "unsupported" };
      },
      fill: (element, value) => {
        element.scrollIntoView({ block: "center", inline: "nearest" });
        element.focus();
        if (element.isContentEditable) {
          element.textContent = value;
        } else {
          element.value = value;
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    };
    return true;
  })()`;
}

function selectorAllExpression(selector: string, pageFunction: string, arg: any): string {
  return `(() => {
    const injected = window.${PLAYWRIGHT_INJECTED_GLOBAL};
    if (!injected) throw new Error("Playwright selector runtime is not injected");
    const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document);
    return (${pageFunction})(elements, injected, ${JSON.stringify(arg ?? null)});
  })()`;
}

function selectorOneExpression(selector: string, pageFunction: string, arg: any): string {
  return `(() => {
    const injected = window.${PLAYWRIGHT_INJECTED_GLOBAL};
    if (!injected) throw new Error("Playwright selector runtime is not injected");
    const matches = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document);
    const visible = matches.filter((element) => injected.elementState(element, "visible").matches);
    const element = matches.length === 1 ? matches[0] : (visible.length === 1 ? visible[0] : matches[0]);
    if (!element) throw new Error("No element matched selector");
    return (${pageFunction})(element, injected, ${JSON.stringify(arg ?? null)});
  })()`;
}

export class BrowserAutomationController {
  private state: BrowserAutomationStoredState = { sessions: {}, deliverableGroupId: null };
  private ready: Promise<void>;
  private attachedTabs = new Set<number>();

  constructor() {
    this.ready = this.load();
    const debuggerApi = (browser as any).debugger;
    debuggerApi?.onDetach?.addListener?.((source: any) => {
      if (typeof source?.tabId === 'number') {
        this.attachedTabs.delete(source.tabId);
      }
    });
  }

  async execute(command: string, params: Record<string, any>): Promise<BrowserAutomationCommandResponse> {
    try {
      await this.ready;
      this.assertChromeAutomationAvailable();
      const safeParams = sanitizeCommandParams(params);
      const sessionId = this.requireSessionId(safeParams);
      const turnId = typeof safeParams.turn_id === 'string' ? safeParams.turn_id : 'turn';
      await this.ensureSession(sessionId);

      let result: any;
      switch (command) {
        case 'browser_create_tab':
          result = await this.createTab(sessionId, safeParams);
          break;
        case 'browser_claim_current_tab':
          result = await this.claimCurrentTab(sessionId, safeParams);
          break;
        case 'browser_list_tabs':
          result = await this.listTabs(sessionId);
          break;
        case 'browser_select_tab':
          result = await this.selectTab(sessionId, safeParams);
          break;
        case 'browser_finalize_tabs':
          result = await this.finalizeTabs(sessionId, safeParams);
          break;
        case 'browser_dom_snapshot':
          result = await this.domSnapshot(sessionId, safeParams);
          break;
        case 'browser_screenshot':
        case 'playwright_screenshot':
          result = await this.screenshot(sessionId, safeParams);
          break;
        case 'browser_element_screenshot':
          result = await this.elementScreenshot(sessionId, safeParams);
          break;
        case 'browser_export_content':
          result = await this.exportContent(sessionId, safeParams);
          break;
        case 'browser_click_node':
          result = await this.clickNode(sessionId, safeParams);
          break;
        case 'browser_fill_node':
          result = await this.fillNode(sessionId, safeParams);
          break;
        case 'browser_type_text':
          result = await this.typeText(sessionId, safeParams);
          break;
        case 'browser_keypress':
          result = await this.keypress(sessionId, safeParams);
          break;
        case 'browser_scroll':
          result = await this.scroll(sessionId, safeParams);
          break;
        case 'browser_navigate':
          result = await this.navigate(sessionId, safeParams);
          break;
        case 'browser_back':
          result = await this.navigateHistory(sessionId, safeParams, -1);
          break;
        case 'browser_forward':
          result = await this.navigateHistory(sessionId, safeParams, 1);
          break;
        case 'browser_reload':
          result = await this.reload(sessionId, safeParams);
          break;
        case 'playwright_locator_click':
          result = await this.locatorClick(sessionId, safeParams);
          break;
        case 'playwright_locator_fill':
          result = await this.locatorFill(sessionId, safeParams);
          break;
        case 'playwright_locator_inner_text':
          result = await this.locatorRead(sessionId, safeParams, 'innerText');
          break;
        case 'playwright_locator_text_content':
          result = await this.locatorRead(sessionId, safeParams, 'textContent');
          break;
        case 'playwright_locator_count':
          result = await this.locatorCount(sessionId, safeParams);
          break;
        case 'playwright_locator_is_visible':
          result = await this.locatorIsVisible(sessionId, safeParams);
          break;
        case 'playwright_locator_wait_for':
          result = await this.locatorWaitFor(sessionId, safeParams);
          break;
        default:
          throw new Error(`Unknown browser automation command: ${command}`);
      }

      if (result?.requiresConfirmation) {
        return {
          success: false,
          requiresConfirmation: true,
          confirmationMessage: result.confirmationMessage,
          risk: result.risk,
          meta: await this.meta(sessionId, command),
        };
      }

      return {
        success: true,
        result,
        meta: await this.meta(sessionId, command),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async endSession(sessionId: string, options: { finalize?: boolean } = {}): Promise<void> {
    await this.ready;
    const session = this.state.sessions[sessionId];
    if (!session) return;
    if (options.finalize && !session.finalized) {
      await this.finalizeTabs(sessionId, { keep: [] }).catch(() => undefined);
      return;
    }
    const tabs = await this.getSessionTabs(sessionId);
    await this.detachMany(tabs.map(tab => tab.id).filter((id): id is number => typeof id === 'number'));
  }

  private assertChromeAutomationAvailable(): void {
    if (import.meta.env.FIREFOX) {
      throw new Error('Firefox 暂不支持浏览器自动化');
    }
    const debuggerApi = (browser as any).debugger;
    if (!debuggerApi?.attach || !debuggerApi?.sendCommand) {
      throw new Error('当前浏览器不支持页面自动化能力');
    }
  }

  private requireSessionId(params: Record<string, any>): string {
    if (typeof params.session_id === 'string' && params.session_id.trim()) {
      return params.session_id;
    }
    throw new Error('Missing browser automation session_id');
  }

  private async load(): Promise<void> {
    try {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      const value = stored[STORAGE_KEY];
      if (isRecord(value)) {
        this.state = {
          sessions: isRecord(value.sessions) ? value.sessions as Record<string, BrowserAutomationSessionState> : {},
          deliverableGroupId: typeof value.deliverableGroupId === 'number' ? value.deliverableGroupId : null,
        };
      }
    } catch {
      this.state = { sessions: {}, deliverableGroupId: null };
    }
  }

  private async save(): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: this.state });
  }

  private async ensureSession(sessionId: string): Promise<BrowserAutomationSessionState> {
    let session = this.state.sessions[sessionId];
    if (!session) {
      session = {
        chromeGroupId: null,
        title: DEFAULT_SESSION_GROUP_TITLE,
        activeTabId: null,
        tabOrigins: {},
      };
      this.state.sessions[sessionId] = session;
      await this.save();
    }
    return session;
  }

  private async createTab(sessionId: string, params: Record<string, any>): Promise<any> {
    const windowId = await this.chooseWindowId(params.window_id);
    const tab = await browser.tabs.create({
      active: false,
      url: typeof params.url === 'string' && params.url.trim() ? params.url.trim() : 'about:blank',
      ...(typeof windowId === 'number' ? { windowId } : {}),
    });
    if (!hasTabId(tab)) throw new Error('Created tab has no id');
    const createdTabId = tab.id as number;
    await this.ensureSessionGroup(sessionId, createdTabId, 'agent');
    await this.setActiveTab(sessionId, createdTabId);
    return { tab: toBrowserTab(tab), activeTabId: createdTabId };
  }

  private async claimCurrentTab(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = optionalPositiveInteger(params.tab_id);
    const tab = tabId ? await browser.tabs.get(tabId) : await this.resolveActiveUserTab(params.window_id);
    if (!hasTabId(tab)) throw new Error('Unable to resolve current tab');
    if (isInternalTabUrl(tab.url)) throw new Error(`Cannot automate internal tab: ${tab.url ?? 'unknown URL'}`);
    await this.ensureSessionGroup(sessionId, tab.id, 'user');
    await this.setActiveTab(sessionId, tab.id);
    return { tab: toBrowserTab(tab), activeTabId: tab.id };
  }

  private async listTabs(sessionId: string): Promise<any> {
    const sessionTabs = await this.getSessionTabs(sessionId);
    const userTabs = (await browser.tabs.query({}))
      .filter(hasTabId)
      .filter(tab => !isInternalTabUrl(tab.url))
      .sort(compareLastAccessed)
      .slice(0, 100);
    const groupTitles = await this.readGroupTitles([...sessionTabs, ...userTabs]);
    return {
      activeTabId: this.state.sessions[sessionId]?.activeTabId ?? null,
      sessionTabs: sessionTabs.map(tab => toBrowserTab(tab, groupTitles.get(tab.groupId))),
      userTabs: userTabs.map(tab => toBrowserTab(tab, groupTitles.get(tab.groupId))),
    };
  }

  private async selectTab(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = positiveInteger(params.tab_id, 'browser_select_tab requires tab_id');
    const tab = await browser.tabs.get(tabId);
    if (!hasTabId(tab)) throw new Error(`Tab ${tabId} does not exist`);
    if (isInternalTabUrl(tab.url)) throw new Error(`Cannot automate internal tab: ${tab.url ?? 'unknown URL'}`);
    const sessionTabs = await this.getSessionTabs(sessionId);
    if (!sessionTabs.some(candidate => candidate.id === tabId)) {
      await this.ensureSessionGroup(sessionId, tabId, 'user');
    }
    await this.setActiveTab(sessionId, tabId);
    return { tab: toBrowserTab(tab), activeTabId: tabId };
  }

  private async finalizeTabs(sessionId: string, params: Record<string, any>): Promise<any> {
    const session = await this.ensureSession(sessionId);
    const tabs = await this.getSessionTabs(sessionId);
    const knownTabIds = new Set(tabs.filter(hasTabId).map(tab => tab.id));
    const keepEntries = Array.isArray(params.keep) ? params.keep : [];
    const keep = new Map<number, BrowserAutomationKeepStatus>();

    if (keepEntries.length === 0 && typeof session.activeTabId === 'number' && knownTabIds.has(session.activeTabId)) {
      keep.set(session.activeTabId, 'deliverable');
    }

    for (const entry of keepEntries) {
      if (!isRecord(entry)) throw new Error('browser_finalize_tabs keep entries must be objects');
      const tabId = positiveInteger(entry.tab_id ?? entry.tabId, 'browser_finalize_tabs keep entry requires tab_id');
      if (!knownTabIds.has(tabId)) throw new Error(`Cannot keep unknown tab ${tabId}`);
      const status = entry.status === 'handoff' ? 'handoff' : 'deliverable';
      keep.set(tabId, status);
    }

    const agentTabsToClose: number[] = [];
    const userTabsToRelease: number[] = [];
    const deliverableTabs: number[] = [];
    const handoffTabs: number[] = [];

    for (const tab of tabs) {
      if (!hasTabId(tab)) continue;
      const keptStatus = keep.get(tab.id);
      if (keptStatus === 'deliverable') {
        deliverableTabs.push(tab.id);
        continue;
      }
      if (keptStatus === 'handoff') {
        handoffTabs.push(tab.id);
        continue;
      }
      if (session.tabOrigins[String(tab.id)] === 'agent') {
        agentTabsToClose.push(tab.id);
      } else {
        userTabsToRelease.push(tab.id);
      }
    }

    await this.detachMany([...agentTabsToClose, ...userTabsToRelease, ...deliverableTabs]);

    if (agentTabsToClose.length > 0) {
      if (agentTabsToClose.length === 1) {
        await browser.tabs.remove(agentTabsToClose[0]);
      } else {
        await browser.tabs.remove(agentTabsToClose);
      }
    }
    await this.ungroupTabs(userTabsToRelease);
    if (deliverableTabs.length > 0) {
      await this.moveToDeliverables(deliverableTabs);
    }

    if (handoffTabs.length > 0) {
      session.activeTabId = handoffTabs.includes(session.activeTabId ?? -1) ? session.activeTabId : handoffTabs[0];
      for (const tabId of [...agentTabsToClose, ...userTabsToRelease, ...deliverableTabs]) {
        delete session.tabOrigins[String(tabId)];
      }
      await this.save();
    } else {
      session.finalized = true;
      delete this.state.sessions[sessionId];
      await this.save();
    }

    return {
      closed: agentTabsToClose,
      released: userTabsToRelease,
      deliverables: deliverableTabs,
      handoff: handoffTabs,
    };
  }

  private async domSnapshot(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const limit = Math.floor(boundedNumber(params.limit, DEFAULT_DOM_NODE_LIMIT, 1, 1000));
    const textLimit = Math.floor(boundedNumber(params.text_limit, DEFAULT_NODE_TEXT_LIMIT, 20, 2000));
    return await this.evaluateJavascript(tabId, domSnapshotExpression(limit, textLimit), false);
  }

  private async screenshot(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    await this.ensureAttached(tabId);

    const captureParams: Record<string, any> = {
      format: params.format === 'jpeg' ? 'jpeg' : 'png',
      ...(params.format === 'jpeg' ? { quality: Math.floor(boundedNumber(params.quality, 80, 1, 100)) } : {}),
    };

    if ([params.crop_x, params.crop_y, params.crop_width, params.crop_height].every(value => value !== undefined)) {
      captureParams.captureBeyondViewport = true;
      captureParams.clip = {
        x: Number(params.crop_x),
        y: Number(params.crop_y),
        width: Number(params.crop_width),
        height: Number(params.crop_height),
        scale: 1,
      };
    } else if (params.full_page === true) {
      const metrics = await this.cdp(tabId, 'Page.getLayoutMetrics');
      const size = metrics.cssContentSize;
      captureParams.captureBeyondViewport = true;
      captureParams.clip = {
        x: size?.x ?? 0,
        y: size?.y ?? 0,
        width: size?.width ?? 1,
        height: size?.height ?? 1,
        scale: 1,
      };
    } else {
      const metrics = await this.cdp(tabId, 'Page.getLayoutMetrics');
      const viewport = metrics.cssVisualViewport;
      captureParams.clip = {
        x: viewport?.pageX ?? 0,
        y: viewport?.pageY ?? 0,
        width: viewport?.clientWidth ?? 1,
        height: viewport?.clientHeight ?? 1,
        scale: 1,
      };
    }

    const result = await this.cdp(tabId, 'Page.captureScreenshot', captureParams);
    if (typeof result.data !== 'string' || !result.data) {
      throw new Error('Page.captureScreenshot returned no data');
    }
    const mimeType = captureParams.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return {
      mimeType,
      dataUrl: `data:${mimeType};base64,${result.data}`,
      description: params.full_page === true ? 'Full-page browser screenshot' : 'Visible browser screenshot',
    };
  }

  private async elementScreenshot(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    let box: any;
    if (params.node_id !== undefined) {
      box = await this.evaluateJavascript(tabId, `(() => {
        const element = ${domFindNodeExpression(String(params.node_id))};
        if (!element) throw new Error("Unknown DOM node id");
        element.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
      })()`, false);
    } else if (typeof params.selector === 'string') {
      await this.ensurePlaywrightInjected(tabId);
      box = await this.evaluateOnSelector(tabId, params.selector, `(element) => {
        element.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
      }`, null, params.timeout_ms);
    } else {
      throw new Error('browser_element_screenshot requires node_id or selector');
    }
    if (!box || box.width <= 0 || box.height <= 0) throw new Error('Element does not have a screenshot area');
    return await this.screenshot(sessionId, {
      ...params,
      tab_id: tabId,
      crop_x: box.x,
      crop_y: box.y,
      crop_width: box.width,
      crop_height: box.height,
    });
  }

  private async exportContent(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const maxLength = Math.floor(boundedNumber(params.max_length, DEFAULT_EXPORT_LIMIT, 1000, 500000));
    let format = 'mhtml';
    let content = '';
    try {
      await this.ensureAttached(tabId);
      const snapshot = await this.cdp(tabId, 'Page.captureSnapshot', { format: 'mhtml' });
      content = String(snapshot.data ?? '');
    } catch {
      format = 'html';
      content = String(await this.evaluateJavascript(tabId, `(() => "<!doctype html>\\n" + document.documentElement.outerHTML)()`, false) ?? '');
    }
    const originalLength = content.length;
    const truncated = originalLength > maxLength;
    if (truncated) {
      content = `${content.slice(0, maxLength)}\n\n[Content truncated at ${maxLength} characters out of ${originalLength}.]`;
    }
    const tab = await browser.tabs.get(tabId).catch(() => null);
    return {
      format,
      title: tab?.title ?? '',
      url: tab?.url ?? '',
      originalLength,
      truncated,
      content,
    };
  }

  private async clickNode(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const nodeId = String(params.node_id ?? '');
    if (!nodeId) throw new Error('browser_click_node requires node_id');
    const risk = await this.assessNodeRisk(tabId, nodeId);
    if (this.requiresConfirmation(risk, params)) return this.confirmationResult(risk, '点击该节点可能涉及敏感或破坏性操作。');
    const point = await this.nodePoint(tabId, nodeId);
    await this.clickPoint(tabId, point.x, point.y, {
      button: mouseButton(params.button),
      clickCount: Math.floor(boundedNumber(params.click_count, 1, 1, 2)),
      modifiers: modifierMask(params.keys ?? params.modifiers),
    });
    return { clicked: true, node_id: nodeId, point };
  }

  private async fillNode(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const nodeId = String(params.node_id ?? '');
    if (!nodeId) throw new Error('browser_fill_node requires node_id');
    if (typeof params.value !== 'string') throw new Error('browser_fill_node requires string value');
    const risk = await this.assessNodeRisk(tabId, nodeId);
    if (this.requiresConfirmation(risk, params)) return this.confirmationResult(risk, '填写该节点可能涉及敏感信息。');
    await this.evaluateJavascript(tabId, `(() => {
      const element = ${domFindNodeExpression(nodeId)};
      if (!element) throw new Error("Unknown DOM node id");
      element.scrollIntoView({ block: "center", inline: "nearest" });
      element.focus();
      const value = ${JSON.stringify(params.value)};
      if (element.isContentEditable) {
        element.textContent = value;
      } else {
        element.value = value;
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`, false);
    return { filled: true, node_id: nodeId };
  }

  private async typeText(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    if (typeof params.text !== 'string') throw new Error('browser_type_text requires text');
    await this.cdp(tabId, 'Input.insertText', { text: params.text });
    return { typed: true, length: params.text.length };
  }

  private async keypress(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    await this.dispatchKeyChord(tabId, normalizeKeyChord(params.keys ?? params.value));
    return { pressed: true };
  }

  private async scroll(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const metrics = await this.cdp(tabId, 'Page.getLayoutMetrics').catch(() => null);
    const viewport = metrics?.cssVisualViewport;
    const x = Number.isFinite(Number(params.x)) ? Number(params.x) : (viewport?.clientWidth ?? 800) / 2;
    const y = Number.isFinite(Number(params.y)) ? Number(params.y) : (viewport?.clientHeight ?? 600) / 2;
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: Number(params.scroll_x ?? params.delta_x ?? 0),
      deltaY: Number(params.scroll_y ?? params.delta_y ?? 600),
      modifiers: modifierMask(params.keys ?? params.modifiers),
    });
    return { scrolled: true };
  }

  private async navigate(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params, { createIfMissing: true });
    if (typeof params.url !== 'string' || !params.url.trim()) throw new Error('browser_navigate requires url');
    await this.cdp(tabId, 'Page.enable', {});
    const result = await this.cdp(tabId, 'Page.navigate', { url: params.url.trim() });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await this.waitForLoadState(tabId, params.timeout_ms);
    return { navigated: true, tab_id: tabId, url: params.url.trim() };
  }

  private async navigateHistory(sessionId: string, params: Record<string, any>, offset: -1 | 1): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const history = await this.cdp(tabId, 'Page.getNavigationHistory');
    const entry = history.entries?.[history.currentIndex + offset];
    if (!entry) throw new Error(offset < 0 ? 'Cannot navigate back' : 'Cannot navigate forward');
    await this.cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    await this.waitForLoadState(tabId, params.timeout_ms);
    return { navigated: offset < 0 ? 'back' : 'forward' };
  }

  private async reload(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    await this.cdp(tabId, 'Page.reload', {});
    await this.waitForLoadState(tabId, params.timeout_ms);
    return { reloaded: true };
  }

  private async locatorClick(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const selector = this.requireSelector(params);
    await this.ensurePlaywrightInjected(tabId);
    const risk = await this.assessSelectorRisk(tabId, selector, params.timeout_ms);
    if (this.requiresConfirmation(risk, params)) return this.confirmationResult(risk, '点击该 locator 可能涉及敏感或破坏性操作。');
    const point = await this.resolveSelectorPoint(tabId, selector, params.timeout_ms);
    await this.clickPoint(tabId, point.x, point.y, {
      button: mouseButton(params.button),
      clickCount: 1,
      modifiers: modifierMask(params.keys ?? params.modifiers),
    });
    return { clicked: true, selector, point };
  }

  private async locatorFill(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const selector = this.requireSelector(params);
    if (typeof params.value !== 'string') throw new Error('playwright_locator_fill requires value');
    await this.ensurePlaywrightInjected(tabId);
    const risk = await this.assessSelectorRisk(tabId, selector, params.timeout_ms);
    if (this.requiresConfirmation(risk, params)) return this.confirmationResult(risk, '填写该 locator 可能涉及敏感信息。');
    await this.evaluateOnSelector(tabId, selector, `(element, injected, data) => injected.fill(element, data.value)`, { value: params.value }, params.timeout_ms);
    return { filled: true, selector };
  }

  private async locatorRead(sessionId: string, params: Record<string, any>, field: 'innerText' | 'textContent'): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const selector = this.requireSelector(params);
    await this.ensurePlaywrightInjected(tabId);
    const value = await this.evaluateOnSelector(tabId, selector, `(element) => ${field === 'innerText' ? '("innerText" in element ? String(element.innerText) : "")' : 'element.textContent'}`, null, params.timeout_ms);
    return { value };
  }

  private async locatorCount(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const selector = this.requireSelector(params);
    await this.ensurePlaywrightInjected(tabId);
    const count = await this.evaluateOnSelectorAll(tabId, selector, `(elements) => elements.length`, null);
    return { count };
  }

  private async locatorIsVisible(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const selector = this.requireSelector(params);
    await this.ensurePlaywrightInjected(tabId);
    const value = await this.evaluateOnSelectorAll(tabId, selector, `(elements, injected) => {
      const element = elements[0] ?? null;
      return element ? injected.elementState(element, "visible").matches : false;
    }`, null);
    return { value };
  }

  private async locatorWaitFor(sessionId: string, params: Record<string, any>): Promise<any> {
    const tabId = await this.resolveSessionTabId(sessionId, params);
    const selector = this.requireSelector(params);
    const state = params.state ?? 'visible';
    const timeoutMs = Math.floor(boundedNumber(params.timeout_ms, 3000, 0, 30000));
    const deadline = Date.now() + timeoutMs;
    await this.ensurePlaywrightInjected(tabId);
    for (;;) {
      const visible = await this.locatorIsVisible(sessionId, { ...params, tab_id: tabId }).then(result => Boolean(result.value)).catch(() => false);
      const count = await this.locatorCount(sessionId, { ...params, tab_id: tabId }).then(result => Number(result.count)).catch(() => 0);
      if (state === 'attached' && count > 0) return { state, matched: true };
      if (state === 'detached' && count === 0) return { state, matched: true };
      if (state === 'visible' && visible) return { state, matched: true };
      if (state === 'hidden' && !visible) return { state, matched: true };
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for selector ${selector} to be ${state}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private requireSelector(params: Record<string, any>): string {
    if (typeof params.selector !== 'string' || !params.selector.trim()) {
      throw new Error('Locator command requires selector');
    }
    return params.selector.trim();
  }

  private async resolveSessionTabId(
    sessionId: string,
    params: Record<string, any>,
    options: { createIfMissing?: boolean } = {},
  ): Promise<number> {
    const explicitTabId = optionalPositiveInteger(params.tab_id ?? params.tabId);
    const session = await this.ensureSession(sessionId);
    if (explicitTabId) {
      const tabs = await this.getSessionTabs(sessionId);
      if (!tabs.some(tab => tab.id === explicitTabId)) {
        await this.selectTab(sessionId, { tab_id: explicitTabId });
      }
      return explicitTabId;
    }
    if (typeof session.activeTabId === 'number') {
      try {
        await browser.tabs.get(session.activeTabId);
        return session.activeTabId;
      } catch {
        session.activeTabId = null;
        await this.save();
      }
    }
    if (options.createIfMissing) {
      const created = await this.createTab(sessionId, params);
      return created.activeTabId;
    }
    const claimed = await this.claimCurrentTab(sessionId, params);
    return claimed.activeTabId;
  }

  private async chooseWindowId(preferredWindowId?: unknown): Promise<number | null> {
    const preferred = optionalPositiveInteger(preferredWindowId);
    if (preferred) return preferred;
    const windows = await browser.windows.getAll({ windowTypes: ['normal'] as any });
    const focused = windows.find((win: any) => win.focused && typeof win.id === 'number');
    return focused?.id ?? windows.find((win: any) => typeof win.id === 'number')?.id ?? null;
  }

  private async resolveActiveUserTab(preferredWindowId?: unknown): Promise<any> {
    const windowId = optionalPositiveInteger(preferredWindowId);
    const query = windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    const [tab] = await browser.tabs.query(query as any);
    if (tab) return tab;
    const [fallback] = await browser.tabs.query({ active: true, currentWindow: true });
    return fallback;
  }

  private async ensureSessionGroup(sessionId: string, tabId: number, origin: BrowserAutomationTabOrigin): Promise<void> {
    const session = await this.ensureSession(sessionId);
    const tabsApi = browser.tabs as any;
    const tabGroupsApi = (browser as any).tabGroups;
    if (!tabsApi.group || !tabGroupsApi?.update) {
      session.tabOrigins[String(tabId)] = origin;
      await this.save();
      return;
    }

    let groupId = session.chromeGroupId;
    if (typeof groupId === 'number') {
      try {
        await tabGroupsApi.get(groupId);
        await tabsApi.group({ groupId, tabIds: [tabId] });
      } catch {
        groupId = null;
      }
    }
    if (typeof groupId !== 'number') {
      groupId = await tabsApi.group({ tabIds: [tabId] });
      session.chromeGroupId = groupId;
    }

    session.title = session.title || DEFAULT_SESSION_GROUP_TITLE;
    session.tabOrigins[String(tabId)] = origin;
    await this.save();
    await tabGroupsApi.update(groupId, {
      title: session.title,
      color: 'blue',
      collapsed: false,
    }).catch(() => undefined);
  }

  private async setActiveTab(sessionId: string, tabId: number): Promise<void> {
    const session = await this.ensureSession(sessionId);
    session.activeTabId = tabId;
    await this.save();
  }

  private async getSessionTabs(sessionId: string): Promise<any[]> {
    const session = await this.ensureSession(sessionId);
    if (typeof session.chromeGroupId === 'number') {
      try {
        const tabs = await browser.tabs.query({ groupId: session.chromeGroupId } as any);
        return tabs.filter(hasTabId).filter(tab => !isInternalTabUrl(tab.url));
      } catch {
        session.chromeGroupId = null;
        await this.save();
      }
    }
    const ids = Object.keys(session.tabOrigins).map(Number).filter(Number.isInteger);
    const tabs: any[] = [];
    for (const id of ids) {
      try {
        const tab = await browser.tabs.get(id);
        if (hasTabId(tab) && !isInternalTabUrl(tab.url)) tabs.push(tab);
      } catch {
        delete session.tabOrigins[String(id)];
      }
    }
    await this.save();
    return tabs;
  }

  private async moveToDeliverables(tabIds: number[]): Promise<void> {
    if (tabIds.length === 0) return;
    const tabsApi = browser.tabs as any;
    const tabGroupsApi = (browser as any).tabGroups;
    if (!tabsApi.group || !tabGroupsApi?.update) return;
    let groupId = this.state.deliverableGroupId;
    if (typeof groupId === 'number') {
      try {
        await tabGroupsApi.get(groupId);
        await tabsApi.group({ groupId, tabIds });
      } catch {
        groupId = null;
      }
    }
    if (typeof groupId !== 'number') {
      groupId = await tabsApi.group({ tabIds });
      this.state.deliverableGroupId = groupId;
    }
    await this.save();
    await tabGroupsApi.update(groupId, {
      title: DELIVERABLE_GROUP_TITLE,
      color: 'green',
      collapsed: false,
    }).catch(() => undefined);
  }

  private async ungroupTabs(tabIds: number[]): Promise<void> {
    if (tabIds.length === 0) return;
    const tabsApi = browser.tabs as any;
    if (tabsApi.ungroup) {
      await tabsApi.ungroup(tabIds.length === 1 ? tabIds[0] : tabIds).catch(() => undefined);
    }
  }

  private async readGroupTitles(tabs: any[]): Promise<Map<number, string>> {
    const tabGroupsApi = (browser as any).tabGroups;
    if (!tabGroupsApi?.get) return new Map();
    const ids = new Set<number>();
    for (const tab of tabs) {
      if (typeof tab.groupId === 'number' && tab.groupId !== -1) ids.add(tab.groupId);
    }
    const entries = await Promise.all([...ids].map(async groupId => {
      try {
        const group = await tabGroupsApi.get(groupId);
        return typeof group?.title === 'string' ? [groupId, group.title] as const : null;
      } catch {
        return null;
      }
    }));
    return new Map(entries.filter((entry): entry is readonly [number, string] => entry !== null));
  }

  private async cdp(tabId: number, method: string, commandParams: Record<string, any> = {}): Promise<any> {
    await this.ensureAttached(tabId);
    return await (browser as any).debugger.sendCommand({ tabId }, method, commandParams);
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    try {
      await (browser as any).debugger.attach({ tabId }, '1.3');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Another debugger')) {
        throw error;
      }
    }
    this.attachedTabs.add(tabId);
    await (browser as any).debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  }

  private async detachMany(tabIds: number[]): Promise<void> {
    await Promise.allSettled(tabIds.map(tabId => this.detachTab(tabId)));
  }

  private async detachTab(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    try {
      await (browser as any).debugger.detach({ tabId });
    } catch {
      // The tab may already be closed or detached by the browser.
    } finally {
      this.attachedTabs.delete(tabId);
    }
  }

  private async evaluateJavascript<T = any>(tabId: number, expression: string, awaitPromise = true): Promise<T> {
    const result = await this.cdp(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'JavaScript evaluation failed';
      throw new Error(description);
    }
    return result.result?.value as T;
  }

  private async waitForLoadState(tabId: number, timeoutValue?: unknown): Promise<void> {
    const timeoutMs = Math.floor(boundedNumber(timeoutValue, DEFAULT_TIMEOUT_MS, 0, 60000));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const readyState = await this.evaluateJavascript<string>(tabId, 'document.readyState', false).catch(() => '');
      if (readyState === 'complete' || readyState === 'interactive') return;
      if (Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }

  private async nodePoint(tabId: number, nodeId: string): Promise<{ x: number; y: number }> {
    return await this.evaluateJavascript(tabId, `(() => {
      const element = ${domFindNodeExpression(nodeId)};
      if (!element) throw new Error("Unknown DOM node id");
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error("DOM node is not visible");
      return { x: Math.max(0, rect.left + rect.width / 2), y: Math.max(0, rect.top + rect.height / 2) };
    })()`, false);
  }

  private async clickPoint(
    tabId: number,
    x: number,
    y: number,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number; modifiers: number },
  ): Promise<void> {
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      modifiers: options.modifiers,
    });
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: options.button,
      buttons: buttonMask(options.button),
      clickCount: options.clickCount,
      modifiers: options.modifiers,
    });
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: options.button,
      buttons: 0,
      clickCount: options.clickCount,
      modifiers: options.modifiers,
    });
  }

  private async dispatchKeyChord(tabId: number, keys: string[]): Promise<void> {
    const normalized = keys.map(normalizeKeyName);
    const modifiers = keys.filter(key => ['ControlOrMeta', 'Control', 'Ctrl', 'Meta', 'Command', 'Cmd', 'Alt', 'Option', 'Shift'].includes(key));
    const modifierKeys = normalized.slice(0, Math.max(0, normalized.length - 1));
    const finalKey = normalized[normalized.length - 1];
    if (!finalKey) throw new Error('keypress requires at least one key');
    for (const key of modifierKeys) {
      await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key, modifiers: modifierMask(modifiers) });
    }
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...finalKey,
      modifiers: modifierMask(modifiers),
      ...(finalKey.text && modifierKeys.length === 0 ? { text: finalKey.text } : {}),
    });
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...finalKey,
      modifiers: modifierMask(modifiers),
    });
    for (const key of modifierKeys.reverse()) {
      await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key, modifiers: 0 });
    }
  }

  private async ensurePlaywrightInjected(tabId: number): Promise<void> {
    const present = await this.evaluateJavascript<boolean>(tabId, `!!window.${PLAYWRIGHT_INJECTED_GLOBAL}`, false).catch(() => false);
    if (present) return;
    await this.evaluateJavascript(tabId, playwrightInjectionExpression(), false);
  }

  private async evaluateOnSelector(tabId: number, selector: string, pageFunction: string, arg: any, timeoutValue?: unknown): Promise<any> {
    const timeoutMs = Math.floor(boundedNumber(timeoutValue, 3000, 0, 30000));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.evaluateJavascript(tabId, selectorOneExpression(selector, pageFunction, arg), true);
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private async evaluateOnSelectorAll(tabId: number, selector: string, pageFunction: string, arg: any): Promise<any> {
    return await this.evaluateJavascript(tabId, selectorAllExpression(selector, pageFunction, arg), true);
  }

  private async resolveSelectorPoint(tabId: number, selector: string, timeoutValue?: unknown): Promise<{ x: number; y: number }> {
    return await this.evaluateOnSelector(tabId, selector, `(element, injected) => {
      const visible = injected.elementState(element, "visible");
      const enabled = injected.elementState(element, "enabled");
      if (!visible.matches) throw new Error("Element is not visible");
      if (!enabled.matches) throw new Error("Element is not enabled");
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error("Element does not have a clickable bounding box");
      return { x: Math.max(0, rect.left + rect.width / 2), y: Math.max(0, rect.top + rect.height / 2) };
    }`, null, timeoutValue);
  }

  private async assessNodeRisk(tabId: number, nodeId: string): Promise<BrowserAutomationRisk> {
    return await this.evaluateJavascript(tabId, riskExpressionForElement(domFindNodeExpression(nodeId)), false);
  }

  private async assessSelectorRisk(tabId: number, selector: string, timeoutValue?: unknown): Promise<BrowserAutomationRisk> {
    await this.ensurePlaywrightInjected(tabId);
    return await this.evaluateOnSelector(tabId, selector, `(element) => {
      const text = [
        element.innerText,
        element.value,
        element.alt,
        element.title,
        element.getAttribute("aria-label"),
        element.getAttribute("name"),
        element.getAttribute("id"),
        element.getAttribute("placeholder"),
        element.getAttribute("autocomplete"),
        element.getAttribute("type")
      ].filter(Boolean).join(" ").trim();
      const haystack = text.toLowerCase();
      const destructive = /(delete|remove|discard|destroy|clear|reset|cancel order|close account|注销|删除|移除|清空|重置|销毁|取消订单)/i.test(haystack);
      const sensitive = /(\b(password|passcode|otp|2fa|verification code|credit card|debit card|card number|cvv|cvc|ssn|social security|identity|id card|passport|pay|payment|purchase|checkout|transfer|wire|bank account|submit order|place order|confirm order|submit payment|confirm payment)\b|密码|验证码|信用卡|银行卡|身份证|护照|支付|付款|购买|结账|转账|提交订单|确认订单|提交付款|确认付款|提交支付|确认支付)/i.test(haystack) || element.matches?.('input[type="password"], input[autocomplete*="cc-"], input[autocomplete*="one-time-code"]');
      const reasons = [];
      if (destructive) reasons.push("destructive keyword");
      if (sensitive) reasons.push("sensitive keyword or field");
      return { level: destructive ? "destructive" : (reasons.length ? "sensitive" : "none"), reasons, preview: text.slice(0, 200) };
    }`, null, timeoutValue);
  }

  private requiresConfirmation(risk: BrowserAutomationRisk, params: Record<string, any>): boolean {
    return params.confirmed !== true && risk.level !== 'none';
  }

  private confirmationResult(risk: BrowserAutomationRisk, confirmationMessage: string): any {
    return {
      requiresConfirmation: true,
      confirmationMessage,
      risk,
    };
  }

  private async meta(sessionId: string, lastAction: string): Promise<BrowserAutomationMeta> {
    const session = this.state.sessions[sessionId];
    const activeTabId = session?.activeTabId ?? null;
    let activeTabTitle: string | undefined;
    let activeTabUrl: string | undefined;
    if (typeof activeTabId === 'number') {
      try {
        const tab = await browser.tabs.get(activeTabId);
        activeTabTitle = tab.title;
        activeTabUrl = displayUrl(tab.url);
      } catch {
        activeTabTitle = undefined;
        activeTabUrl = undefined;
      }
    }
    return {
      sessionId,
      activeTabId,
      activeTabTitle,
      activeTabUrl,
      groupTitle: session?.title ?? DEFAULT_SESSION_GROUP_TITLE,
      lastAction,
    };
  }
}

export function createBrowserAutomationController(): BrowserAutomationController {
  return new BrowserAutomationController();
}
