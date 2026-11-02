# Markdown Lite Studio

一个本地优先的轻量 Markdown 编辑器。使用 Electron + TypeScript，源代码、依赖锁文件、测试和免安装 Windows 构建均在本目录。

## 运行

### 免安装 Windows 版

已构建到 `dist/win-unpacked/`。直接运行：

```text
dist/win-unpacked/markdown-lite-studio.exe
```

不需要系统 Node.js，不执行安装程序，不修改系统 PATH。当前 EXE SHA-256：

`b1d6fc26c98cd3f25c1768bf5f6377e37f32ad9f46dab3c0a00c567348c9041d`

运行数据默认写在该程序目录的 `.runtime/`；开发模式默认写在 `app/.runtime/`。可用 `MARKDOWN_LITE_USER_DATA` 指定其他隔离目录。

### 从源码启动

先阅读 `AGENTS.md` 第 2 节，使用工作区 `tools/node/node.exe` 与随附 npm，并隔离所有 npm/cache/TEMP/HOME 环境变量。不要全局安装依赖。

```bash
cd app
npm ci               # 首次或重建依赖时；完整隔离命令见 AGENTS.md
npm run dev          # 开发模式
npm start            # 运行 out/ 中已有生产构建
```

若 `npm ci` 后 Electron 二进制缺失，按 `AGENTS.md` 的命令补执行本地 `node_modules/electron/install.js`。

## 构建与验证

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run package
```

- `typecheck` / `build`：main、preload、renderer 类型检查和 electron-vite 构建。
- `test`：34 个文件、315 个 Vitest 用例。
- `test:e2e`：14 个真实 Electron 场景，包括 Windows 图片、全应用主题、自定义壁纸与 MarkText 对照；会启动 GUI，只在隔离副本中写文件。
- `package`：输出 `dist/win-unpacked/`，不生成安装程序。

测试截图、结果和性能数据在 `test-results/`；总体验证记录见 `../evidence/verification.md`。

## 使用

1. 打开一个本地笔记文件夹，侧栏显示真实 `.md`、`.markdown` 和 `.html` 文件。
2. 新建、重命名、切换多个笔记；编辑、分屏和预览可切换，Ctrl+S 保存，支持自动保存和查找。
3. 编辑器支持中文输入、选区、粘贴、Ctrl+Z 撤销、Ctrl+Shift+Z 或 Ctrl+Y 重做。
4. 粘贴 PNG/JPEG/GIF/WebP 图片后，图片先写入 `assets/<sha256>.<ext>`，再插入可持续恢复的相对引用。
5. “主题布局”提供真正的全应用浅色、深色和跟随系统模式，可调整正文宽度、字体、字号、行距、颜色、标题、目录和侧栏。还可选择本地 PNG/JPEG/GIF/WebP 壁纸，设置透明度、模糊、平铺方式和位置；清除后恢复纯色。配置与壁纸数据保存在运行目录并在重启后恢复，同时作用于预览与 HTML 导出。
6. “导出 HTML”生成实际 HTML 文件。预览与导出使用同一渲染管线；本地图片嵌入 data URI，远程资源单独报告。
7. 已有 HTML 文件可在应用内预览并切换源码，脚本被禁止。Markdown、主题或布局改变但未重新导出时，会显示未导出修改。
8. 使用 `[[笔记]]`、`[[目录/笔记]]`、`[[笔记|别名]]` 创建双链。支持补全、同名选择、缺失提示、反链和真实关系图谱。图谱支持平移、缩放、节点选择和打开笔记。

## 逆向结论如何进入实现

调查记录：`../evidence/marktext-v0.23.0-investigation.md`。设计：`../docs/plans/2026-11-02-markdown-editor-design.md`。

| MarkText 证据确认的机制 | 本应用的实现 |
| --- | --- |
| Markdown 是持久化形式，编辑器另有状态 | CodeMirror 统一文档模型；Markdown 字符串为唯一持久真相 |
| 渲染端生成 HTML，主进程写盘 | 共享 RenderPipeline 生成预览/导出，ExportService 原子写入 |
| 原子保存与逐文档写队列 | 同样采用，但增加 baseHash CAS，冲突时阻止手动和自动覆盖 |
| watcher 感知外部变化 | 干净文档可重载，脏文档进入 conflict，删除进入 missing |
| 图片真实落盘并引用 | 内容哈希去重，先写图后插入，统一 POSIX 相对路径 |
| 预览主题和导出主题可不同 | 主动改为同一主题/布局同时作用于预览与导出 |

未复制 MarkText 的品牌、界面资源、Muya 块树、OT 历史或源码。双链、反链、图谱和统一 HTML 页面制作是自主设计。

## 主动简化与已知限制

- 使用源码编辑器 + 独立 HTML 预览，不实现 Muya 的所见即所得块树、复杂表格选区、图形图表、Pandoc、PDF 或上传服务。
- 支持 GFM 常用语法；高级数学、Mermaid、Vega、PlantUML 等不在当前范围。
- 预览禁止脚本。SVG 图片拒绝；单张图片最大 10 MiB。HTTP(S) 图片保留为外部依赖，不自动联网抓取。
- 撤销历史不跨重启恢复；工作区、打开文档、活动文档、主题布局和分屏状态会恢复。
- 同名 wikilink 需要用户选择，不会静默猜测；重命名只更新可无歧义解析的引用。
- 当前 Windows 构建未签名，使用默认 Electron 图标。免安装目录约 378 MiB；“轻量”指功能与源码设计集中，不代表分发体积更小。

## 代码结构

- `src/main/`：窗口安全、固定 IPC、工作区、文档 CAS/原子保存、重命名事务、图片、导出、状态和链接索引。
- `src/preload/`：仅暴露类型化 `window.markdownLite`，无通用 IPC。
- `src/shared/`：跨进程契约、校验、路径和默认配置。
- `src/renderer/src/editor/`：CodeMirror、IME、自动保存、图片粘贴。
- `src/renderer/src/render/`：唯一 Markdown/HTML 渲染管线。
- `src/renderer/src/html/`：预览、主题布局、导出状态。
- `src/renderer/src/links/`：双链交互、反链与 Cytoscape 图谱。
- `tests/`、`e2e/`：单元、主进程集成和真实 Electron 行为测试。
