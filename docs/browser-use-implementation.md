# Tactus Chrome Browser Use 实现方案

## 背景

Tactus 现在在 Chrome 构建中内置网页自动化能力，用于让 AI 在浏览器扩展内直接创建、认领、观察和操作网页。实现目标是贴近 `open-codex-browser-use` 的核心模型：通过 Chrome DevTools Protocol 控制页面，以标签页会话为单位管理任务，用 DOM 快照和截图帮助模型理解页面，并通过原始内容导出避免正文抽取丢失结构。

Firefox 构建暂不暴露自动化工具，也不申请 Chrome 专有自动化权限。

## 总体架构

实现由四层组成：

1. `wxt.config.ts`
   - Chrome manifest 增加 `debugger`、`tabs`、`tabGroups`、`scripting`。
   - Firefox 构建不增加 `debugger`、`tabs`、`tabGroups`，也不暴露浏览器自动化工具。

2. `utils/browserAutomation.ts`
   - Browser Automation Controller。
   - 负责标签页会话、CDP attach/detach、tab group、DOM 快照、截图、原始内容导出和页面操作。

3. `utils/tools.ts`
   - 注册 AI 可调用的 browser use 工具。
   - Chrome 自动化可用时禁用旧的 `extract_page_content`，避免 Readability/Markdown 转换和自动化链路冲突。
   - 视觉模型可用时才暴露截图工具。

4. `entrypoints/sidepanel/App.vue`
   - 负责工具执行转发、敏感操作确认、停止清理，以及把截图作为视觉上下文回传给模型。
   - 不再显示任务级“允许浏览器自动化”弹窗，只在敏感操作时确认。

## 标签页与会话模型

每次对话轮次会初始化一个 browser automation session，session 状态保存在 `browser.storage.local` 中。

主要状态包括：

- `activeTabId`：当前 AI 操作的标签页。
- `chromeGroupId`：AI 工作标签组。
- `tabOrigins`：记录标签页来源，区分 AI 创建的 `agent` 标签页和用户认领的 `user` 标签页。
- `deliverableGroupId`：结果标签组。

标签组设计：

- AI 工作组标题：`Tactus Task`
- 结果组标题：`Tactus Results`
- AI 新建标签页会进入工作组。
- 认领用户当前标签页时，会加入工作组，但结束时默认释放，不随便关闭。
- `finalizeTabs` 会关闭中间页、保留结果页，并将结果页移动到结果组。

停止、结束、报错时都会释放页面自动化连接，避免 Chrome 残留自动化控制状态。

## AI 工具

### 标签页与会话

- `browser_create_tab`
- `browser_claim_current_tab`
- `browser_list_tabs`
- `browser_select_tab`
- `browser_finalize_tabs`

### 页面观察

- `browser_dom_snapshot`
- `browser_screenshot`
- `browser_element_screenshot`
- `browser_export_content`

### DOM/CDP 操作

- `browser_click_node`
- `browser_fill_node`
- `browser_type_text`
- `browser_keypress`
- `browser_scroll`
- `browser_navigate`
- `browser_back`
- `browser_forward`
- `browser_reload`

### Playwright-style locator

- `playwright_locator_click`
- `playwright_locator_fill`
- `playwright_locator_inner_text`
- `playwright_locator_text_content`
- `playwright_locator_count`
- `playwright_locator_is_visible`
- `playwright_locator_wait_for`
- `playwright_screenshot`

## 页面理解策略

自动化链路不使用 `extract_page_content`。

推荐流程是：

1. 先调用 `browser_dom_snapshot` 获取可见可交互节点。
2. 如需确认视觉布局，再调用截图工具。
3. 如需完整结构或页面源码，再调用 `browser_export_content`。
4. 根据 `node_id` 或 locator 执行点击、输入、滚动和导航。

### DOM 快照

`browser_dom_snapshot` 只返回可见可交互节点，默认限制：

- 最多 250 个节点。
- 每个节点文本最多 500 字。

节点信息包括：

- `node_id`
- `tag`
- `role`
- `aria`
- `text`
- `type`
- `href`
- `boundingBox`
- `state`
- `risk`

可交互节点来源包括常见表单控件、链接、按钮、媒体元素、`role`、`onclick`、`contenteditable` 和 `tabindex`。

### 截图

截图通过 CDP `Page.captureScreenshot` 实现。

支持：

- 当前视口截图。
- full page 截图。
- 元素区域裁剪截图。

截图工具只在当前模型支持视觉能力时暴露。工具结果会先写入 tool result，再在本批工具调用全部结束后追加为图片上下文，避免破坏多工具调用时的消息顺序。

### 原始内容导出

`browser_export_content` 不做 Markdown 转换，也不使用 Readability。

导出优先级：

1. CDP `Page.captureSnapshot({ format: 'mhtml' })`
2. 失败时回退：

```html
<!doctype html>
document.documentElement.outerHTML
```

这样可以保留表单、导航、评论、隐藏结构等信息，避免主内容抽取丢失关键页面元素。

## Playwright Selector Runtime

首版不启动外部 Playwright 浏览器，而是在目标页面中注入轻量 selector runtime。

支持：

- CSS selector。
- `text=...` 文本 selector。
- 可见性判断。
- enabled / disabled 状态。
- editable 状态。
- checked / unchecked 状态。
- 文本读取。
- 填充。
- 等待。
- 元素截图。

实际点击、输入、截图仍通过 CDP 执行。

locator 操作失败时，应让 AI 重新获取 DOM 快照或截图后再继续，不盲目沿用旧坐标点击。

## 导航与内部页面处理

内部页面默认不允许自动化，例如：

- `chrome:`
- `edge:`
- `about:` 非空白页
- `chrome-extension:`
- `moz-extension:`

`about:blank` 是例外。AI 新建标签页后初始 URL 通常是 `about:blank`，因此它被视为可导航工作页，允许后续 `browser_navigate({ tab_id, url })` 直接导航。

## 风险确认策略

不再有任务级“允许浏览器自动化”确认。

只在页面操作命中敏感或破坏性风险时二次确认。

破坏性风险关键词示例：

- 删除
- 移除
- 清空
- 重置
- 注销
- 取消订单
- delete / remove / reset / close account

敏感风险关键词示例：

- 密码
- 验证码
- 信用卡
- 银行卡
- 身份证
- 护照
- 支付
- 付款
- 购买
- 结账
- 转账
- 提交订单
- 确认付款
- password / otp / credit card / payment / checkout / transfer / submit order

普通搜索提交不会触发敏感确认。例如：

- `百度一下`
- `submit`
- `search submit`

这些普通搜索/表单提交不再因为单独出现 `submit` 或 `提交` 而被误判为敏感操作。

## 侧边栏 UI 行为

当前界面策略：

- 不显示浏览器自动化状态小窗口。
- 不弹出任务级授权确认。
- 只显示敏感操作确认弹窗。
- 输入框里的终止按钮使用停止图标，不再显示“终止”文字。
- 停止说明使用用户可理解文案：
  - “Tactus 会停止页面操作，并保留已打开的结果页。”

用户点击停止时：

1. 终止当前模型流。
2. 停止后续工具调用。
3. 释放页面自动化连接。
4. 保留已打开结果页。

## 多模型工具结果处理

OpenAI、Anthropic、Gemini 三条链路都支持 browser use 工具结果。

截图结果处理方式：

1. 工具本身返回文本说明。
2. 如果包含图片，则追加 `image_url` 格式的视觉上下文。
3. 多工具调用时，图片上下文会延后到本批 tool result 之后追加，确保消息顺序合法。

## Firefox 边界

Firefox 暂不实现自动化。

当前策略：

- Firefox manifest 不申请 Chrome 自动化权限。
- `getFilteredTools` 不暴露 browser use 工具。
- 如果运行时误调用自动化能力，会返回“Firefox 暂不支持浏览器自动化”。

## 当前已验证

已通过：

- `npm run compile`
- `npm run test`
- `npm run build`
- `npm run build:firefox`
- `git diff --check`

构建中仍可能出现项目既有的 WXT duplicate imports / chunk size warnings，这些不是本功能引入的阻塞错误。

## 后续可扩展项

后续可以继续扩展：

- 更完整的 Playwright selector runtime。
- 更细的风险分类与站点级规则。
- 文件上传、下载、剪贴板、历史记录等工具。
- 更完善的人工接管/交付标签页体验。
- 自动化过程的可选调试面板。
- 更系统的端到端测试，覆盖真实 Chrome 中的 attach/detach、tab group、截图和导航流程。
