/**
 * OpenAI Function Calling 工具定义
 */

import { mcpManager, mcpToolToOpenAITool, parseMcpToolName, isMcpTool, type McpTool } from './mcp';

// OpenAI Function Calling 格式的工具定义
export interface FunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
      parameters: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
        additionalProperties?: boolean;
      };
    strict?: boolean;
  };
}

// 工具状态文本映射
export interface ToolStatusMap {
  [toolName: string]: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  result: string;
  success: boolean;
  images?: Array<{
    dataUrl: string;
    mimeType: string;
    description?: string;
  }>;
}

// 工具状态提示文本（静态）
const toolStatusTexts: ToolStatusMap = {
  extract_page_content: '正在提取网页内容...',
  activate_skill: '正在激活 Skill...',
  execute_skill_script: '正在执行脚本...',
  read_skill_file: '正在读取文件...',
  browser_create_tab: '正在创建 AI 工作标签页...',
  browser_claim_current_tab: '正在认领当前标签页...',
  browser_list_tabs: '正在读取浏览器标签页...',
  browser_select_tab: '正在选择 AI 工作标签页...',
  browser_finalize_tabs: '正在整理 AI 工作标签页...',
  browser_dom_snapshot: '正在读取页面可交互节点...',
  browser_screenshot: '正在截取页面截图...',
  browser_element_screenshot: '正在截取元素截图...',
  browser_export_content: '正在导出页面原始内容...',
  browser_click_node: '正在点击页面节点...',
  browser_fill_node: '正在填写页面节点...',
  browser_type_text: '正在输入文本...',
  browser_keypress: '正在发送键盘操作...',
  browser_scroll: '正在滚动页面...',
  browser_navigate: '正在导航页面...',
  browser_back: '正在后退页面...',
  browser_forward: '正在前进页面...',
  browser_reload: '正在刷新页面...',
  playwright_locator_click: '正在点击 Locator...',
  playwright_locator_fill: '正在填写 Locator...',
  playwright_locator_inner_text: '正在读取 Locator 文本...',
  playwright_locator_text_content: '正在读取 Locator 内容...',
  playwright_locator_count: '正在统计 Locator...',
  playwright_locator_is_visible: '正在检查 Locator 可见性...',
  playwright_locator_wait_for: '正在等待 Locator...',
  playwright_screenshot: '正在截取 Playwright 风格截图...',
};

// 导出 MCP 相关函数
export { parseMcpToolName, isMcpTool };

// 工具状态提示文本（动态，带参数）
function getDynamicToolStatusText(
  toolName: string,
  args?: Record<string, any>
): string | null {
  if (!args) return null;

  // MCP 工具
  if (isMcpTool(toolName)) {
    const parsed = parseMcpToolName(toolName);
    if (parsed) {
      return `正在调用 MCP 工具: ${parsed.toolName}...`;
    }
  }

  switch (toolName) {
    case 'activate_skill':
      if (args.skill_name) {
        return `正在激活 Skill: ${args.skill_name}...`;
      }
      break;
    case 'execute_skill_script':
      if (args.skill_name && args.script_path) {
        return `正在执行脚本: ${args.skill_name}/${args.script_path}...`;
      }
      break;
    case 'read_skill_file':
      if (args.skill_name && args.file_path) {
        return `正在读取文件: ${args.skill_name}/${args.file_path}...`;
      }
      break;
  }
  return null;
}

function createFunctionTool(
  name: string,
  description: string,
  properties: Record<string, any> = {},
  required: string[] = [],
): FunctionTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

const tabIdProperty = {
  type: 'integer',
  description: '目标标签页 ID。省略时使用当前 AI browser session 的活动标签页；若还没有活动标签页，会认领当前用户标签页。',
};

const timeoutProperty = {
  type: 'integer',
  description: '等待超时时间，单位毫秒。',
};

const browserAutomationTools: FunctionTool[] = [
  createFunctionTool(
    'browser_create_tab',
    '在用户当前 Chrome 窗口中创建一个 AI 工作标签页，并把它加入 Tactus Task 标签组。适合打开新网站、搜索资料或避免干扰用户当前标签页。',
    {
      url: { type: 'string', description: '可选，要打开的 URL。省略时打开 about:blank。' },
    },
  ),
  createFunctionTool(
    'browser_claim_current_tab',
    '认领用户当前标签页作为 AI 工作标签页，并加入 Tactus Task 标签组。用户要求操作“当前页面/这个网页/这里”时先调用。',
    {
      tab_id: { type: 'integer', description: '可选，明确要认领的标签页 ID。' },
    },
  ),
  createFunctionTool(
    'browser_list_tabs',
    '列出 AI session 标签页和用户浏览器中可认领的普通标签页。',
  ),
  createFunctionTool(
    'browser_select_tab',
    '把指定标签页设为当前 AI 工作标签页；如果该标签页尚未在 session 中，会作为用户标签页认领。',
    {
      tab_id: { type: 'integer', description: '要选择的标签页 ID。' },
    },
    ['tab_id'],
  ),
  createFunctionTool(
    'browser_finalize_tabs',
    '结束 AI 浏览器任务。关闭中间 agent 标签页，释放被认领的用户标签页，并把结果页移动到 Tactus Results 标签组。',
    {
      keep: {
        type: 'array',
        description: '要保留的标签页列表。每项包含 tab_id 和 status；status 为 deliverable 或 handoff。省略或为空时默认保留当前活动标签页为 deliverable。',
        items: {
          type: 'object',
          properties: {
            tab_id: { type: 'integer' },
            status: { type: 'string', enum: ['deliverable', 'handoff'] },
          },
          required: ['tab_id', 'status'],
          additionalProperties: false,
        },
      },
    },
  ),
  createFunctionTool(
    'browser_dom_snapshot',
    '读取当前 AI 工作标签页的可见可交互 DOM 节点快照。自动化前优先调用它，使用返回的 node_id 进行点击或填写。',
    {
      tab_id: tabIdProperty,
      limit: { type: 'integer', description: '最多返回节点数，默认 250。' },
      text_limit: { type: 'integer', description: '每个节点最多返回文本长度，默认 500。' },
    },
  ),
  createFunctionTool(
    'browser_export_content',
    '导出当前 AI 工作标签页的原始页面内容。优先 CDP MHTML snapshot，失败时回退完整 HTML；不使用 Readability，也不转 Markdown。',
    {
      tab_id: tabIdProperty,
      max_length: { type: 'integer', description: '最大返回字符数，默认 60000。' },
    },
  ),
  createFunctionTool(
    'browser_click_node',
    '点击 browser_dom_snapshot 返回的 DOM node_id。敏感或破坏性节点会要求用户二次确认。',
    {
      tab_id: tabIdProperty,
      node_id: { type: 'string', description: 'browser_dom_snapshot 返回的 node_id。' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按钮，默认 left。' },
      click_count: { type: 'integer', description: '点击次数，1 或 2。' },
      keys: { type: 'array', items: { type: 'string' }, description: '点击时按住的修饰键。' },
    },
    ['node_id'],
  ),
  createFunctionTool(
    'browser_fill_node',
    '填写 browser_dom_snapshot 返回的输入节点。敏感字段会要求用户二次确认。',
    {
      tab_id: tabIdProperty,
      node_id: { type: 'string', description: 'browser_dom_snapshot 返回的 node_id。' },
      value: { type: 'string', description: '要填写的文本。' },
    },
    ['node_id', 'value'],
  ),
  createFunctionTool(
    'browser_type_text',
    '向当前焦点输入文本。',
    {
      tab_id: tabIdProperty,
      text: { type: 'string', description: '要输入的文本。' },
    },
    ['text'],
  ),
  createFunctionTool(
    'browser_keypress',
    '向当前 AI 工作标签页发送键盘组合键，例如 ["Enter"]、["ControlOrMeta","L"]、["Escape"]。',
    {
      tab_id: tabIdProperty,
      keys: { type: 'array', items: { type: 'string' }, description: '按键或组合键。' },
    },
    ['keys'],
  ),
  createFunctionTool(
    'browser_scroll',
    '滚动当前 AI 工作标签页。',
    {
      tab_id: tabIdProperty,
      x: { type: 'number', description: '滚动发生的视口 x 坐标，省略时使用视口中心。' },
      y: { type: 'number', description: '滚动发生的视口 y 坐标，省略时使用视口中心。' },
      scroll_x: { type: 'number', description: '横向滚动量。' },
      scroll_y: { type: 'number', description: '纵向滚动量，正数向下。' },
    },
  ),
  createFunctionTool(
    'browser_navigate',
    '在当前 AI 工作标签页中打开 URL 并等待页面加载。若还没有 AI 工作标签页，会创建一个后台标签页。',
    {
      tab_id: tabIdProperty,
      url: { type: 'string', description: '完整 URL。' },
      timeout_ms: timeoutProperty,
    },
    ['url'],
  ),
  createFunctionTool('browser_back', '让当前 AI 工作标签页后退。', { tab_id: tabIdProperty, timeout_ms: timeoutProperty }),
  createFunctionTool('browser_forward', '让当前 AI 工作标签页前进。', { tab_id: tabIdProperty, timeout_ms: timeoutProperty }),
  createFunctionTool('browser_reload', '刷新当前 AI 工作标签页。', { tab_id: tabIdProperty, timeout_ms: timeoutProperty }),
  createFunctionTool(
    'playwright_locator_click',
    '使用注入的 Playwright-style selector runtime 定位元素并点击。支持 CSS selector 和 text= 文本匹配。',
    {
      tab_id: tabIdProperty,
      selector: { type: 'string', description: 'CSS selector 或 text=... selector。' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      timeout_ms: timeoutProperty,
    },
    ['selector'],
  ),
  createFunctionTool(
    'playwright_locator_fill',
    '使用 Playwright-style locator 填写元素。敏感字段会要求用户二次确认。',
    {
      tab_id: tabIdProperty,
      selector: { type: 'string', description: 'CSS selector 或 text=... selector。' },
      value: { type: 'string', description: '要填写的文本。' },
      timeout_ms: timeoutProperty,
    },
    ['selector', 'value'],
  ),
  createFunctionTool('playwright_locator_inner_text', '读取 locator 匹配元素的 innerText。', {
    tab_id: tabIdProperty,
    selector: { type: 'string' },
    timeout_ms: timeoutProperty,
  }, ['selector']),
  createFunctionTool('playwright_locator_text_content', '读取 locator 匹配元素的 textContent。', {
    tab_id: tabIdProperty,
    selector: { type: 'string' },
    timeout_ms: timeoutProperty,
  }, ['selector']),
  createFunctionTool('playwright_locator_count', '统计 locator 匹配元素数量。', {
    tab_id: tabIdProperty,
    selector: { type: 'string' },
  }, ['selector']),
  createFunctionTool('playwright_locator_is_visible', '检查 locator 第一个匹配元素是否可见。', {
    tab_id: tabIdProperty,
    selector: { type: 'string' },
  }, ['selector']),
  createFunctionTool('playwright_locator_wait_for', '等待 locator 达到 attached/detached/visible/hidden 状态。', {
    tab_id: tabIdProperty,
    selector: { type: 'string' },
    state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'] },
    timeout_ms: timeoutProperty,
  }, ['selector']),
];

const browserVisionTools: FunctionTool[] = [
  createFunctionTool(
    'browser_screenshot',
    '截取当前 AI 工作标签页截图并作为图片上下文返回给 AI。先读 DOM，再在需要视觉确认时使用。',
    {
      tab_id: tabIdProperty,
      full_page: { type: 'boolean', description: '是否截取整页。默认 false，仅当前视口。' },
      crop_x: { type: 'number', description: '裁剪区域 x。' },
      crop_y: { type: 'number', description: '裁剪区域 y。' },
      crop_width: { type: 'number', description: '裁剪宽度。' },
      crop_height: { type: 'number', description: '裁剪高度。' },
    },
  ),
  createFunctionTool(
    'browser_element_screenshot',
    '按 node_id 或 selector 截取单个元素截图并作为图片上下文返回给 AI。',
    {
      tab_id: tabIdProperty,
      node_id: { type: 'string', description: 'browser_dom_snapshot 返回的 node_id。' },
      selector: { type: 'string', description: 'CSS selector 或 text=... selector。' },
    },
  ),
  createFunctionTool(
    'playwright_screenshot',
    'Playwright 风格截图工具，支持当前视口、整页或裁剪区域。',
    {
      tab_id: tabIdProperty,
      full_page: { type: 'boolean' },
      crop_x: { type: 'number' },
      crop_y: { type: 'number' },
      crop_width: { type: 'number' },
      crop_height: { type: 'number' },
    },
  ),
];

export const browserAutomationToolNames = new Set([
  ...browserAutomationTools.map(tool => tool.function.name),
  ...browserVisionTools.map(tool => tool.function.name),
]);

export function isBrowserAutomationTool(toolName: string): boolean {
  return browserAutomationToolNames.has(toolName);
}

// 定义可用工具（OpenAI Function Calling 格式）
export const availableTools: FunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'extract_page_content',
      description: '提取并清洗当前网页的主要内容，返回包含标题、作者、来源等元数据的结构化 Markdown 格式文本。当用户询问关于当前页面的问题时，需要调用此工具获取页面内容。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'activate_skill',
      description: '激活一个已安装的 Skill，加载其完整指令到上下文中。当用户的任务匹配某个 Skill 的描述时调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill 的名称' },
        },
        required: ['skill_name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_skill_script',
      description: '执行 Skill 中的脚本文件。脚本在当前页面上下文中运行，可访问 DOM。脚本执行前可能需要用户确认。可通过 arguments 传递参数，脚本中通过 __args__ 变量获取。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill 的名称' },
          script_path: { type: 'string', description: '脚本文件路径' },
          arguments: { type: 'object', description: '传递给脚本的参数对象（可选），脚本中通过 __args__ 获取' },
        },
        required: ['skill_name', 'script_path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description: '读取 Skill 中的引用文件。可读取 references/ 目录下的引用文件（如文档、配置模板）或 assets/ 目录下的文本资源。仅支持文本文件。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill 的名称' },
          file_path: { type: 'string', description: '引用文件路径' },
        },
        required: ['skill_name', 'file_path'],
        additionalProperties: false,
      },
    },
  },
];

// 获取工具的状态提示文本
export function getToolStatusText(
  toolName: string,
  args?: Record<string, any>
): string {
  // 优先使用动态状态文本
  const dynamicText = getDynamicToolStatusText(toolName, args);
  if (dynamicText) {
    return dynamicText;
  }
  // 回退到静态状态文本
  return toolStatusTexts[toolName] || `正在执行 ${toolName}...`;
}

// Skills 提示生成（从 skills.ts 导入的类型）
export interface SkillInfo {
  name: string;
  description: string;
}

// 根据上下文过滤可用工具
export function getFilteredTools(context?: {
  sharePageContent?: boolean;
  skills?: SkillInfo[];
  mcpTools?: McpTool[];
  browserAutomationAvailable?: boolean;
  browserVisionAvailable?: boolean;
}): FunctionTool[] {
  const tools: FunctionTool[] = [];

  // 添加内置工具
  for (const tool of availableTools) {
    const toolName = tool.function.name;

    // 如果未分享页面内容，禁用 extract_page_content
    if (toolName === 'extract_page_content' && !context?.sharePageContent) {
      continue;
    }

    // Chrome 自动化启用时，页面理解使用 DOM snapshot/export，避免 Readability 转换丢失可交互信息
    if (toolName === 'extract_page_content' && context?.browserAutomationAvailable) {
      continue;
    }
    
    // 如果没有 skills，禁用 skill 相关工具
    if ((toolName === 'activate_skill' || toolName === 'execute_skill_script' || toolName === 'read_skill_file')) {
      if (!context?.skills || context.skills.length === 0) {
        continue;
      }
    }
    
    tools.push(tool);
  }

  if (context?.browserAutomationAvailable) {
    tools.push(...browserAutomationTools);
    if (context.browserVisionAvailable) {
      tools.push(...browserVisionTools);
    }
  }

  // 添加 MCP 工具
  if (context?.mcpTools && context.mcpTools.length > 0) {
    for (const mcpTool of context.mcpTools) {
      tools.push(mcpToolToOpenAITool(mcpTool));
    }
  }

  return tools;
}

// 生成 Skills 系统提示（用于 function calling 上下文）
function buildSkillsContextPrompt(skills?: SkillInfo[], browserAutomationAvailable = false): string {
  if (!skills || skills.length === 0) {
    return '';
  }

  const skillsXml = skills.map(skill =>
    `  <skill>
    <name>${skill.name}</name>
    <description>${skill.description}</description>
  </skill>`
  ).join('\n');

  return `

## 可用 Skills
以下 Skills 已安装，当用户的任务匹配某个 Skill 的描述时，使用 activate_skill 工具激活它：

<available_skills>
${skillsXml}
</available_skills>

### 工具优先级
当需要获取页面内容时：
1. **优先检查** Skills 列表，如果某个 Skill 的描述表明它专门处理当前网站/页面类型，先激活该 Skill
2. **否则** ${browserAutomationAvailable ? '使用 browser_dom_snapshot / browser_export_content 获取页面结构或原始内容' : '使用通用的 extract_page_content 工具'}

激活 Skill 后，你将获得详细的指令来完成任务。`;
}

// 语言类型
export type Language = 'en' | 'zh-CN';

// 生成 MCP 工具上下文提示
function buildMcpToolsContextPrompt(mcpTools?: McpTool[]): string {
  if (!mcpTools || mcpTools.length === 0) {
    return '';
  }

  // 按 Server 分组
  const toolsByServer = new Map<string, McpTool[]>();
  for (const tool of mcpTools) {
    const existing = toolsByServer.get(tool.serverName) || [];
    existing.push(tool);
    toolsByServer.set(tool.serverName, existing);
  }

  const serverSections: string[] = [];
  for (const [serverName, tools] of toolsByServer) {
    const toolsXml = tools.map(tool =>
      `    <tool>
      <name>${tool.name}</name>
      <description>${tool.description || '无描述'}</description>
    </tool>`
    ).join('\n');

    serverSections.push(`  <server name="${serverName}">
${toolsXml}
  </server>`);
  }

  return `

## MCP 工具
以下 MCP Server 已连接，你可以使用它们提供的工具：

<mcp_servers>
${serverSections.join('\n')}
</mcp_servers>

调用 MCP 工具时，工具名称格式为 \`mcp__{serverId}__{toolName}\`，直接使用即可。`;
}

// 生成上下文提示
export function generateContextPrompt(context?: {
  sharePageContent?: boolean;
  skills?: SkillInfo[];
  mcpTools?: McpTool[];
  browserAutomationAvailable?: boolean;
  browserVisionAvailable?: boolean;
  pageInfo?: {
    domain: string;
    title: string;
    url?: string;
  };
  language?: Language;
}): string {
  const hints: string[] = [];
  
  // 语言设置提示
  if (context?.language) {
    const langName = context.language === 'zh-CN' ? '简体中文' : 'English';
    hints.push(`- Always respond in ${langName}`);
  }
  
  if (context?.sharePageContent) {
    let hint = '- 用户已点击输入框上方标签页高亮分享当前页面内容，当用户询问关于当前页面的问题时，你需要先获取页面内容';
    if (context.pageInfo) {
      hint += `\n- 当前页面：${context.pageInfo.title}（${context.pageInfo.domain}）`;
      if (context.pageInfo.url) {
        hint += `\n- 页面 URL：${context.pageInfo.url}`;
      }
    }
    hints.push(hint);
  } else {
    hints.push('- 用户未点击输入框上方标签页高亮分享当前页面内容，extract_page_content 工具当前不可用');
  }

  if (context?.browserAutomationAvailable) {
    hints.push(`- Chrome 浏览器自动化可用。需要操作网页、读取表单/按钮/导航或避免正文抽取丢信息时，先使用 browser_dom_snapshot 获取可交互节点，再用 node_id 或 Playwright-style locator 操作。
- 如果任务涉及打开新网站或搜索资料，优先 browser_create_tab/browser_navigate，在 AI 工作标签页中完成，避免打断用户当前浏览。
- 如果任务明确指向当前页面，先 browser_claim_current_tab。
- browser_export_content 返回原始 MHTML/HTML，不做 Readability 或 Markdown 转换。
- ${context.browserVisionAvailable ? '当前模型支持视觉；需要确认视觉布局、截图或元素外观时，可在 DOM 快照后调用 browser_screenshot、browser_element_screenshot 或 playwright_screenshot。' : '当前模型未启用视觉；截图工具不会暴露，请依赖 DOM 快照和原始内容导出。'}
- 浏览器任务完成后调用 browser_finalize_tabs，保留结果页并清理中间页。`);
  }

  const skillsPrompt = buildSkillsContextPrompt(context?.skills, context?.browserAutomationAvailable === true);
  const mcpPrompt = buildMcpToolsContextPrompt(context?.mcpTools);

  return `## 当前上下文
${hints.join('\n')}${skillsPrompt}${mcpPrompt}

## 重要提示
- 不要假设页面内容，必须通过工具获取真实内容
- 工具调用后会返回结果，你需要基于结果进行回答`;
}
