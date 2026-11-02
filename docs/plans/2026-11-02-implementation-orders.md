# 子代理函数级实施单

本文件是编码子代理的唯一实施依据。主代理已完成设计与取舍；子代理不得另行选型、调查 MarkText、改变模块边界或自行决定验收标准。按顺序执行，不做范围外重构。

## 当前盘点（主代理实测）

- 基础：Electron + TypeScript 已落地，73 项基础测试曾通过。
- 部分模块：当前 209 项测试，208 通过、1 失败。
- `npm run build` 当前失败：`src/renderer/src/links/link-store.ts:93-94` 在 Node tsconfig 中使用未声明的 `window`。
- `npm test` 当前失败：`tests/link-service.test.ts:15` 在并行测试文件间删除共享 `LINK_TEST_ROOT`，导致其他工作区被误删。
- 文件、HTML、链接模块已有部分实现，保留；根 `renderer/main.ts` 仍是占位页面，HTML 模块没有测试，恢复启动与跨文件引用事务尚未连接。

## A. 修复当前断点并补齐模块测试

### A1. Node 环境兼容修复

文件：`app/src/renderer/src/links/link-store.ts`

只修改 `resolveApi()` 的全局对象访问方式：

- 不直接引用标识符 `window`，因为 `tsconfig.node.json` 不包含 DOM lib。
- 保留显式 `options.api`、`options.apiFactory` 的优先级。
- 使用 `globalThis` 并局部收窄为 `{ markdownLite?: { links?: MarkdownLiteLinksApi } }`；存在 `links` 时返回。
- 无 API 时仍抛 `LinkApiError('no_api', ...)`。
- 在 `tests/wiki-store.test.ts` 增加一个 Node 环境无全局 API 的断言，确保不引用 DOM 也能得到 `no_api`。

### A2. 消除测试清理竞态

文件：`app/tests/link-service.test.ts`

- `afterAll` 只执行 `created.map(temp => temp.cleanup())`，不得删除共享 `LINK_TEST_ROOT`。
- 删除不再使用的 `rm` 和 `LINK_TEST_ROOT` import。
- 不改 `wiki-fixtures.ts` 的独立 `mkdtemp` 工作区机制，不改其他测试语义。

### A3. HTML 渲染与导出测试

新增：`app/tests/render-pipeline.test.ts`、`app/tests/html-workspace.test.ts`、`app/tests/export-service.test.ts`。

使用已安装 `jsdom@26`。不得再增加依赖。覆盖：

1. 标题、任务列表、引用、表格、代码块、中文文本渲染。
2. `[[示例]]` 不出现在 `code`/`codespan` 的 wikilink token 中。
3. 原始 HTML 被转义/净化，`script`、事件属性、`javascript:` URL 不进入结果。
4. 本地图片 resolver 返回合法 PNG base64 时为 data URI；远程图片列 `external`；缺失列 `missing`；SVG/超大资源被拒绝且有提示。
5. 同一 markdown/theme/layout/resources 两次渲染 signature 相同；只改主题后 signature 改变，且预览与导出读取的是同一个 `RenderResult.html`。
6. `HtmlWorkspaceController`：`setDocument` 更新 iframe.srcdoc；`setMarkdown` 后 `hasUnexportedChanges=true`；`exportHtml` 成功后才更新 exportedSignature；`openHtmlFile` 可切换源码/预览且不能导出为 Markdown。
7. `ExportService`：取消返回 `details.reason='cancelled'`；目标等于源文件时拒绝；成功时调用注入 writer 并原样返回 signature/dependencies/bytes。对话框与 writer 全用注入 fake，不写真实用户文件。

### A4. 恢复状态修复

文件：`app/src/main/services/state-service.ts`、`app/tests/state-service.test.ts`

- `save(state)` 除当前按 root 哈希保存外，还把同一状态原子写到全局 `workspace-state.json`，使无工作区时的 `load()` 能返回最后 root。
- 全局写入与按 root 写入顺序固定：先按 root，后全局；任何错误向上抛出，不静默。
- 测试验证：无 root 时保存/加载最后工作区；setRoot 后加载对应 root 状态；损坏 JSON 回退默认值。

完成后运行 `npm test` 与 `npm run build`，全部通过才进入 B。

## B. 主进程恢复与重命名事务

### B1. 无参数恢复工作区

修改：`shared/contracts.ts`（如需恢复结果类型）、`shared/api.ts`、`shared/ipc.ts`、`preload/index.ts`、`main/ipc.ts`。

新增固定 channel：`workspace:restore`；API：`workspace.restore(): Promise<IpcResult<OpenWorkspaceResult>>`，无参数。

主 handler 顺序固定：

1. `services.state.load()` 读取全局状态。
2. 无 `workspaceRootPath` 时返回 `{cancelled:true,workspace:null}`。
3. 有 root 时调用 `services.workspace.setRoot(root)`，再 `services.documents.refreshWorkspace()`。
4. 成功返回 `{cancelled:false,workspace:summary}`；root 已不存在时沿用统一错误映射，不伪报成功。
5. 成功后调用 `services.links.invalidate()`。

不得让 renderer 传任意绝对路径。

### B2. 引用更新计划携带原文

修改：`main/services/links/rename-plan.ts` 的 `RenameRewrite`：

- 新增 `originalMarkdown:string`。
- `planRename()` 在 push 每个 rewrite 时填入该文档未修改的原文；`markdown` 仍是修改后全文。
- 更新 `tests/wiki-rename.test.ts`，验证原文与修改后文本不同且原文精确。

### B3. 新增 RenameCoordinator

新增：`app/src/main/services/rename-coordinator.ts`。

导出 `class RenameCoordinator`，构造参数为 `DocumentService` 与 `LinkService`，方法 `rename(request: RenameDocumentRequest): Promise<RenameDocumentResult>`。严格按以下算法：

1. `updateReferences=false`：直接 `documents.rename(request)`，结果 `referencesDeferred=false`。
2. `true`：先 `links.renamePlan(fromPath,toPath)`，再 `documents.rename({...request,updateReferences:false})`。
3. 保存 `written: {path, originalMarkdown, rewrittenMarkdown}[]`。plan 中 `documentPath===fromPath` 的 rewrite 写到 `toPath`，其他写到原 path。
4. 每个 rewrite 调 `documents.save`，`baseHash=sha256Hex(originalMarkdown)`，`documentId='rename:'+request.documentId`。保存前若有并发修改，CAS 必须失败。
5. 成功一个就加入 `written`。全部完成后 `links.invalidate()`，返回 `referenceEdits`、`skippedReferences`、`referencesDeferred:false`。
6. 任一写入失败：按 written 逆序用 `documents.save` 恢复原文（baseHash 为 rewritten 的哈希），再调用 `documents.rename` 将 `toPath` 改回 `fromPath`；随后 `links.invalidate()`。
7. 回滚完成后抛 `AppError('conflict','rename rolled back because reference updates failed', {path:failedPath,referenceEdits,skippedReferences})`。回滚自身失败时不得宣称恢复成功，错误 message 改为 `rename rollback incomplete`，details 同时包含最初失败与回滚失败。
8. 单元测试覆盖：无引用、普通引用、同名歧义不更新、源文档自链、写入冲突回滚、回滚失败报告。

`main/ipc.ts` 的 `document:rename` 改为调用 coordinator。`main/services/index.ts` 创建 coordinator 并放入 `Services`。

## C. Renderer 应用壳集成

只修改/新增：`renderer/src/main.ts`、`renderer/src/styles.css`、`renderer/index.html`、`renderer/src/editor/*`（仅本段列出的 paste 接口）、`renderer/src/html/theme-panel.ts`（新）、必要测试。不得改其他模块算法。

### C1. 启动和布局

实现单窗口三栏：

- 顶栏：打开文件夹、新建笔记、重命名、查找、自动保存开关、关系图谱、主题布局、导出 HTML。
- 左栏：真实目录树与标签页；可通过 layout 配置左右位置和显隐。
- 中栏：CodeMirror 编辑器与 `HtmlWorkspace` 预览，支持编辑/预览切换及分屏。
- 右栏：当前笔记反链和大纲；图谱可切换为中栏视图。
- 状态栏：dirty/saving/conflict/missing、未导出修改、错误与依赖提示。

`index.html` 只保留静态容器，CSP 不放宽。`main.ts` 不新增内联脚本。样式原创、紧凑，不复制 MarkText 品牌。

### C2. 工作区生命周期

1. 启动先 `app.getInfo`，再 `workspace.restore()`；无恢复目标时显示打开文件夹页。
2. 打开/恢复后 `getTree({path:'',depth:4})` 和 `state.load()`，恢复 theme/layout/openDocuments/activeDocument/documentViews。
3. 每个 Markdown 文档 `documents.read` 后传给 `CodeMirrorEditorHost.open`；HTML 文档传给 `HtmlWorkspace.openHtmlFile`。
4. 活动文档变化时同步 editor、HtmlWorkspace、backlinks、graph focus 和 state.save（去抖）。
5. 新建：只要求文件名与目录，调用 `documents.create` 后刷新树并打开。
6. 关闭标签：dirty 时要求保存/另存/取消，不静默丢内容。
7. watcher 回调先 `editorHost.applyExternalChange`，再 `links.invalidate()` 和刷新反链/图谱。

### C3. 编辑、预览和查找

- `EditorHostOptions.onStateChange` 中读取活动 markdown，调用 `htmlWorkspace.setMarkdown`（300ms 去抖，旧 renderToken 不得覆盖新结果）。
- Ctrl+S 使用 host.save；查找使用 host.openSearch；自动保存复用 host 既有队列。
- 中文 composition 期间不得触发 wikilink 补全或自有 Enter/Escape 处理。
- `CodeMirrorEditorHost` 增加 `insertText(text,start,end)` 与 `getActiveMarkdown()` 两个只读/写入小接口，供 wikilink 和 paste 使用；插入使用 `view.dispatch(changes)` 并把光标放到插入文本末尾。

### C4. 图片粘贴

在 editor 的 `EditorView.domEventHandlers` 增加 paste 处理：

1. 仅当剪贴板含 `image/png|jpeg|gif|webp` 文件时接管；其他粘贴完全交给 CodeMirror。
2. `event.isComposing` 时不拦截。
3. File 转 canonical base64 后调用 `images.save`，返回成功才通过 `insertText` 插入 `![](<asset.path>)`；路径空格和括号按 Markdown 规则转义。
4. 失败显示错误，文档不变；SVG 不支持并明确提示。
5. 不在插入前写 data URL 占位。

### C5. 主题布局面板

新增 `html/theme-panel.ts`，导出 `mountThemePanel(container,{theme,layout,onChange})`：

- 输入：mode、bodyWidthPx、fontFamily、fontSizePx、lineHeight、codeFontFamily、foreground/background/accent、headingScale、title.visible、outline.visible/position、sidebar.visible/position/widthPx、customVariables（仅 `--mdl-`）。
- 每个控件的 min/max 与 shared validation 一致；非法值不进入 onChange。
- onChange 后依次 `htmlWorkspace.setTheme/setLayout`、应用根布局 class、去抖 `state.save`。
- 不添加自定义脚本或任意 CSS 文本框。

### C6. 双链与图谱

- `createLinkWorkspace` 的 `onOpenNote` 调统一 `openDocument(path)`；`onInsertLink` 调 `editorHost.insertText`。
- CodeMirror update 时调用 `wikiLinks.query`；键盘先 `wikiLinks.handleKeyDown`，composition 时跳过。
- `HtmlWorkspace` 的 pipeline 注入 wikilink resolver：从 LinkStore.index 解析，resolved 输出 `data-wikilink-target` 和相对 href；ambiguous/missing 只输出状态，不伪造可打开目标。
- 预览容器调用 `wikiLinks.attach` 和 `decorate`。
- 图谱通过 `mountGraph` 展示，支持 focus 当前笔记；保存、重命名和 watcher 后刷新。

### C7. 重命名与导出

- 重命名默认 `updateReferences=true`，调用 coordinator；结果显示修改文件数、引用数和 skipped 原因，刷新树、标签路径、索引和图谱。
- 导出不另写渲染逻辑，直接 `htmlWorkspace.exportHtml()`；结果提示 writtenPath、bytes 和 dependencies。
- 主题/布局改变但尚未导出时必须保留未导出标记。

## D. 验收（主代理执行，子代理不得自行宣布完成）

- `npm test`、`npm run typecheck`、`npm run build` 全过。
- 后续由专门测试子代理按主代理另一份场景单补齐 Playwright；主代理实际启动应用并检查中文输入、保存、图片、主题、HTML、双链、图谱、冲突与重启。
- 任何错误由主代理定位后形成精确修复单，子代理只修改点名文件与断言。
