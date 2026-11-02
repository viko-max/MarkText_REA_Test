# app/ — Markdown Lite Studio

本目录是新编辑器的独立 Electron 项目。根 `AGENTS.md` 的边界规则同样适用；本文件只补充
`app/` 内部的结构、命令与约定。所有应用代码均由子代理编写，主代理只做验收与 review。

## 1. 结构

```
app/
├── electron.vite.config.ts     main / preload / renderer 三段构建
├── electron-builder.yml        免安装 Windows dir 打包配置（输出 dist/）
├── tsconfig*.json              base + node(main/preload/tests) + web(renderer)
├── vitest.config.mts           单元测试（tests/**/*.test.ts，node 环境）
├── playwright.config.ts        Electron 行为测试配置；e2e/ 暂无 spec
├── scripts/verify-node.mjs     打印实际使用的 Node 与 Electron 版本
├── src/
│   ├── main/                   主进程
│   │   ├── index.ts            启动、单实例、session 加固、runtime 目录
│   │   ├── window.ts           BrowserWindow 安全基线、导航/弹窗拦截
│   │   ├── ipc.ts              固定 channel 注册、发送方校验、错误映射
│   │   ├── runtime-paths.ts    MARKDOWN_LITE_USER_DATA / app/.runtime
│   │   ├── errors.ts           AppError（携带 IpcErrorCode）
│   │   ├── security/
│   │   │   └── workspace-paths.ts  工作区根约束 + realpath/junction 逃逸检查
│   │   └── services/           Workspace/Document/Resource/Background/Export/State/Link/Rename
│   ├── preload/index.ts        仅暴露 window.markdownLite
│   ├── renderer/               index.html + src/main.ts（三栏应用壳）+ styles.css
│   │   └── src/                editor/（CodeMirror 宿主、paste）、html/（预览工作区、theme-panel、preview-links）、
│   │                           links/（补全、反链、图谱）、render/（唯一渲染管线）
│   └── shared/                 跨进程契约（无 Node/Electron import）
│       ├── contracts.ts        领域类型
│       ├── api.ts              MarkdownLiteApi 接口
│       ├── ipc.ts              channel 注册表 + IpcResult
│       ├── validation.ts       IPC 入参运行时校验
│       ├── paths.ts            POSIX 工作区路径纯函数
│       └── defaults.ts         主题/布局/持久状态默认值
└── tests/                      Vitest：路径规则、根约束、校验、契约
```

## 2. 命令

`package.json` 的脚本直接调用绝对路径
`C:\Users\14698\Desktop\MarkText_REA_Test\tools\node\node.exe`（仓库自带 Node v24.22.1），
不经过 PATH 上的 `node`/`npm`；因此脚本与当前工作区布局绑定，移动目录后需同步修改。
调用 npm 本身仍应使用绝对路径：

```bash
W=C:/Users/14698/Desktop/MarkText_REA_Test
cd "$W/app"
env TEMP="$W/.cache/tmp" TMP="$W/.cache/tmp" HOME="$W/.cache/home" USERPROFILE="$W/.cache/home" \
    APPDATA="$W/.cache/appdata" LOCALAPPDATA="$W/.cache/localappdata" \
    XDG_CACHE_HOME="$W/.cache/xdg-cache" npm_config_cache="$W/.cache/npm-cache" \
    npm_config_userconfig="$W/.cache/npmrc" \
    ELECTRON_CACHE="$W/.cache/electron" electron_config_cache="$W/.cache/electron" \
    ELECTRON_BUILDER_CACHE="$W/.cache/electron-builder" \
    "$W/tools/node/node.exe" "$W/tools/node/node_modules/npm/bin/npm-cli.js" <script>
```

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | electron-vite 开发模式（会启动 GUI） |
| `npm run build` | 两个 tsconfig 类型检查 + electron-vite 生产构建到 `out/` |
| `npm start` | `electron-vite preview`，运行已构建的 `out/` |
| `npm run typecheck` | 仅类型检查 |
| `npm test` | Vitest 单元测试 |
| `npm run test:e2e` | Playwright：`e2e/editor-workspace.spec.ts`（E1–E8 行为用例）、`e2e/image-compat.spec.ts`（Windows 反斜杠图片与 127.0.0.1 远程图片）、`e2e/marktext-compare.spec.ts`（MarkText 对照，其中导出落盘等限制记为 unknown）与 `e2e/theme-wallpaper.spec.ts`（T1 浅色/深色/system，T2 壁纸选择-导出-清除-重启） |
| `npm run package` | 类型检查 + 构建 + `electron-builder --win --dir` → `dist/win-unpacked/` |
| `npm run verify:node` | 打印真实 Node/Electron 路径与版本 |

`npm ci` 后若 `node_modules/electron/dist` 缺失（npm 11 的 install-scripts 白名单会跳过
electron 的 postinstall），补执行：

```bash
env ELECTRON_CACHE="$W/.cache/electron" "$W/tools/node/node.exe" node_modules/electron/install.js
```

## 3. 安全基线（不要放宽）

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、
  `nodeIntegrationInWorker/InSubFrames: false`、`webSecurity: true`、
  `webviewTag: false`、`navigateOnDragDrop: false`。
- preload 只能 `require('electron')`；构建产物为 CommonJS。不要在 preload 引入 Node 内置模块
  或运行时依赖，否则 sandbox 下会加载失败。
- 不暴露通用 `send`/`invoke`/`on`。新增能力必须：`shared/ipc.ts` 加 channel →
  `shared/api.ts` 加方法 → preload 显式映射 → `src/main/ipc.ts` 用校验器注册。
- 所有 handler 先校验发送方（主窗口主 frame），再校验 payload；错误以
  `IpcResult` 返回，不拒绝 `invoke`。
- 渲染器传入的路径一律是工作区相对 POSIX 路径；主进程先做语法检查，再用
  `createWorkspacePathGuard` 的 `realpath` 检查确认仍在根内（含 junction/symlink 逃逸）。
- 渲染器 CSP 在 `src/renderer/index.html`，禁止内联脚本；预览 iframe 必须 `srcdoc` 且无脚本。
- 运行数据目录：`MARKDOWN_LITE_USER_DATA`，否则 `<app>/.runtime`。`userData`、
  `sessionData`、`logs`、`crashDumps`、`temp` 全部重定向到该目录，并覆盖 `TEMP`/`TMP`。
  不得写用户级目录。

## 4. 共享契约要点

`src/shared/contracts.ts` 覆盖后续模块所需类型：

- 工作区：`WorkspaceNode` / `WorkspaceTree` / `WorkspaceSummary`
- 文档：`DocumentState`（`baseHash`/`diskHash`/`dirty`/`saving`/`conflict`/`missing`/
  `selection`/`scrollTop`/`viewMode`/`exportedSignature`）、`DocumentContent`、保存与重命名请求/结果
- 图片：`SaveImageRequest`（base64 + mediaType）→ `ImageAsset`（相对路径 + sha256）
- HTML：`ExportHtmlRequest`（渲染结果 + 签名 + 依赖报告）→ `ExportHtmlResult`
- 主题布局：`ThemeConfig`（含 `wallpaper`：`dataUri` + `opacity`/`blurPx`/`size`/`position`）/
  `LayoutConfig` / `WorkspaceUiState`；`ChooseBackgroundResult` 只携带 data URI、mediaType、
  字节数与 sha256，绝不包含绝对路径
- 链接：`WikiLink` / `LinkIndex` / `BacklinkReport` / `LinkGraph`

所有 IPC 请求/响应都包在 `IpcResult<T>` 中：`{ ok: true, value }` 或
`{ ok: false, error: { code, message, details? } }`。

## 5. 服务边界（已实现）

| 服务 | 职责 |
| --- | --- |
| `WorkspaceService` | 原生目录选择、无参数恢复、canonical root、guard 缓存、目录树 |
| `DocumentService` | 文档读取/新建、baseHash CAS、原子写、逐文档队列、外部 watcher、冲突/缺失 |
| `RenameCoordinator` | 引用影响计划、跨文件 CAS 更新、逆序回滚与失败报告 |
| `ResourceService` | 图片格式/大小校验、内容哈希去重、原子写与 base64 读取（magic-byte sniff 在 `services/image-sniff.ts`） |
| `BackgroundService` | `background:choose` 原生壁纸选择：仅 png/jpg/jpeg/webp、sniff 与扩展一致、10 MiB 上限，只返回 data URI |
| `ExportService` | 原生保存对话框、禁止覆盖源文件、原子 HTML 写盘 |
| `StateService` | 全局最后工作区与按 root 状态、原子恢复、主题布局与文档视图 |
| `LinkService` | 真实 wikilink 索引、反链、图谱、增量失效和重命名计划 |

所有 handler 保留发送方、payload 和工作区路径前置校验；新增能力不得退回通用 IPC 或绝对路径输入。

## 6. 验证状态

- `npm run build`：通过（TypeScript 7.0.2 + electron-vite 6.0.0 + Vite 8.3.5），产物
  `out/main/index.js`、`out/preload/index.js`（CJS，仅 require `electron`）、`out/renderer/*`。
- `npm test`：34 个文件、315 个用例通过（含 junction 逃逸、文件根拒绝、IPC 校验与
  Node errno 可读映射、`workspace:restore` 恢复顺序、`document:rename` 委派、跨文件重命名事务与
  回滚、render-pipeline / html-workspace / export-service 渲染与导出断言、render-resources 的
  Windows 反斜杠图片路径与越界/绝对路径拒绝断言、editor-paste / theme-panel / preview-links
  渲染器纯逻辑断言、editor-keymap 的 Ctrl+Shift+Z 绑定与 IME guard 断言，以及 theme-wallpaper
  的旧配置兼容/壁纸 data URI 规则/共享 CSS 与 background-service 的取消-格式-大小-无路径断言）。
- `npm run package`：通过，输出 `dist/win-unpacked/`；`app.asar` 含 `out/`、
  `package.json` 与生产 `node_modules`，不含 `src/`、`tests/`。
- `npm run test:e2e`：14 个用例全部通过（E1–E8 行为用例 + IMG1 图片兼容用例 + 3 个 MarkText
  对照用例 + T1/T2 主题与壁纸用例）；E2 以真实 Ctrl+Z → Ctrl+Shift+Z 验证重做，E3/E7 验证重命名与重启后仍为 split，
  IMG1 以 iframe `naturalWidth>0` 验证 `assets\pixel.png` 与 127.0.0.1 回环图片真实解码；
  T1 用 `page.emulateMedia({colorScheme})` 断言浅色在深色系统下仍为浅色、深色与 system 跟随系统，
  T2 断言壁纸 data URI 同时进入外壳与 iframe、导出 HTML 与 srcdoc 逐字节相同、清除后回到纯色、
  重启后模式与壁纸恢复，截图见 `test-results/T1-theme-modes/theme-light.png`、
  `theme-dark.png` 与 `test-results/T2-theme-wallpaper/theme-wallpaper.png`。
  MarkText 的 inspector/真实保存对话框限制仍记为 unknown，未伪报为通过。
- 运行数据路径设置已在无窗口 Electron 冒烟中核实：`userData`、`sessionData`、`logs`、
  `crashDumps`、`temp` 全部指向指定 runtime 目录，不写用户级目录。
- 渲染界面已实现（三栏壳：目录/标签、编辑/预览/分屏、反链/大纲/主题面板，图谱可切换为中栏视图）；
  真实界面行为、重启恢复与 MarkText 对照由 `npm run test:e2e` 在隔离工作区中验证。
