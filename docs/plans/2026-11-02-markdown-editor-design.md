# 轻量本地 Markdown 编辑器设计

日期：2026-11-02  
状态：用于子代理实施与主代理验收

## 1. 技术选择与边界

采用 Electron + TypeScript。备选的本地方案是 Node 本地 Web 服务（文件访问与独立运行体验较弱）和 Tauri（需要新增 Rust 工具链），均不如 Electron 适合本任务的应用内 HTML 预览、Windows 文件集成和参考行为对照。

渲染层使用 CodeMirror 6、marked、DOMPurify 和 Cytoscape；主进程使用 Node fs、chokidar、write-file-atomic。Vite + TypeScript 构建，Vitest 做单元/集成测试，Playwright 做 Electron 行为测试，electron-builder 输出免安装 Windows 目录。所有依赖安装到 `app/node_modules`，缓存和运行数据留在工作区。

不复制 MarkText 的品牌、界面资源、Muya 块树或源码。复现的是经证据确认的通用行为：Markdown 持久化、编辑状态、原子保存、监视外部变化、渲染端生成 HTML、主进程写导出文件。双链、反链、图谱和统一预览/导出主题为自主设计。

## 2. 进程与模块

**Main**

- `WindowService`：单窗口，`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`。
- `WorkspaceService`：打开文件夹、目录树、真实路径解析、`.md/.markdown/.html` 读取。
- `DocumentService`：文档队列、baseHash 校验、原子保存、重命名、自动保存和外部 watcher。
- `ResourceService`：粘贴图片内容哈希命名、相对路径解析、导出资源读取。
- `ExportService`：选择目标并原子写 HTML；不重新实现另一套渲染。
- `StateService`：在工作区运行目录原子保存主题、布局、打开文档和活动状态。

**Preload**

只暴露按领域划分的 TypeScript API。每个 channel 固定且参数经过校验；不暴露通用 `send/invoke/on`，不接受任意绝对路径。渲染器使用工作区相对 POSIX 路径，主进程解析后确认仍位于根目录内。

**Renderer**

- `EditorWorkspace`：目录、标签、编辑/源码/HTML 预览、状态提示。
- `EditorController`：CodeMirror 文档、中文输入、选区、查找、撤销重做、自动保存去抖。
- `MarkdownRenderPipeline`：marked GFM、DOMPurify、标题锚点、任务列表、表格、代码块、图片、wikilink token 扩展。
- `ThemeLayoutPanel`：正文宽度、字体、字号、行距、前景/背景、标题区、目录与侧栏显示和位置、自定义 CSS 变量。
- `HtmlWorkspace`：同源 iframe 预览与源码切换、导出状态签名。
- `LinkIndex` / `GraphView`：真实链接索引、反链、缺失目标、同名消歧、Cytoscape 平移缩放与打开笔记。

## 3. 文档与保存模型

每个打开文档至少包含：`path`、`markdown`、`baseHash`、`diskHash`、`mtimeMs`、`dirty`、`saving`、`conflict`、`missing`、`selection`、`scrollTop`、`viewMode`、`exportedSignature`。

保存以文档 ID 排队。写入前重新读取磁盘并比较 `baseHash`：匹配才原子写入；不匹配进入 `conflict` 并阻止手动和自动保存。用户可选择重新加载或另存副本。保存期间继续编辑时，只有当前内容哈希等于已写内容才清除 dirty。外部变化：干净文档可重载，脏文档进入冲突；删除进入 missing。图片先写文件再插入引用，失败时文档不变。

工作区状态与必要的编辑器状态原子恢复；撤销历史只保留在本次运行内，不声称跨重启恢复。自动保存去抖并复用手动保存同一链路。

## 4. 渲染、主题与 HTML

`MarkdownRenderPipeline` 是唯一 HTML 来源，预览和导出共享 marked 配置、Sanitize、标题锚点、wikilink 解析、CSS 生成和资源嵌入。预览 iframe 使用 `srcdoc`，禁止脚本；导出禁止覆盖源 Markdown。

主题配置是序列化 JSON，CSS 变量同时作用于编辑器预览和导出。高级自定义只允许受控变量，不直接注入脚本。页面结构支持标题区、目录、侧栏的显示与位置。每次修改后更新预览并改变内容签名；只有写盘成功才记录 `exportedSignature`，UI 明确显示未导出修改。

本地图片按 MIME 转 data URI；SVG 先净化或拒绝并报告。HTTP(S) 图片默认不联网抓取，保留 URL 并列入导出依赖报告；缺失图片显示错误且不静默丢内容。打开已有 HTML 时提供同源预览和源码查看，不把它伪装成 Markdown 文档。

## 5. 双链、重命名与图谱

支持 `[[笔记]]`、`[[目录/笔记]]` 和 `[[笔记|别名]]`。解析基于 marked token 范围，代码块、行内代码和 HTML 代码示例不进入索引。无扩展名 basename 唯一时跳转；同名时展示候选；不存在时显示缺失样式和补全建议。

重命名先计算影响范围：只更新能够无歧义解析到旧目标的引用，歧义引用不自动改并给出列表。文件与引用更新使用可恢复的事务记录和原子写，任何失败都停止并报告，不宣称完全事务成功。

反链与图谱从同一索引派生。Cytoscape 只接收真实笔记和真实链接，支持平移、缩放、节点选择、点击打开以及当前笔记邻域过滤。watcher、保存和重命名后增量失效并重建受影响索引。

## 6. 子代理接口与验收

实施顺序：

1. 基础子代理：项目、TypeScript 配置、Electron 安全基线、IPC 类型、启动构建。
2. 文件编辑子代理：文档模型、目录、编辑器、保存、图片、恢复。
3. HTML 子代理：共享渲染、预览、主题布局、导出。
4. 链接图谱子代理：wikilink、索引、重命名影响分析、图谱。
5. 测试子代理：fixtures、Vitest、Playwright 场景与测量脚本。

主代理负责接口 review、依赖审查、实际启动、截图与行为验证；发现的问题交回对应实现子代理修复并复验。

**必须通过的验收**：

- 中文编辑、选区、撤销重做、常用 Markdown 预览。
- 文件夹、目录、新建、重命名、多文档、查找、真实保存与自动保存。
- 图片粘贴/恢复、外部修改、保存失败和冲突处理。
- 重启恢复内容、主题、布局、打开文档和活动状态。
- HTML 应用内预览、已有 HTML 源码/预览、单文件离线导出与依赖报告。
- 预览/导出主题一致性、未导出修改提示。
- 中文/子目录/同名/缺失双链，代码示例排除，反链、重命名与图谱更新。
- `npm run build`、单元/集成测试和 Electron 行为测试通过；记录启动时间、内存和主动简化差异。
